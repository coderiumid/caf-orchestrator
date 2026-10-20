import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessManager } from '../../src/tui/infrastructure/process/process-manager.js';

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn((signal: string) => {
    if (signal === 'SIGKILL' || this.exitOnTerm) queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  });
  exitOnTerm = true;
}

function setup(exitOnTerm = true, tunnel: { command: string; args: string[]; notFoundHint?: string } | null = { command: 'cloudflared', args: ['tunnel', 'run', '--url', 'http://localhost:3030', 'ai-code-review'], notFoundHint: 'install cloudflared' }) {
  const child = new FakeChild();
  child.exitOnTerm = exitOnTerm;
  const spawn = vi.fn(() => child);
  const manager = new ProcessManager({ repoRoot: '/repo', workerGraceMs: 1000, serverGraceMs: 500, spawn: spawn as never, env: { FOO: 'bar' }, tunnel });
  return { child, spawn, manager };
}

describe('ProcessManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('spawns tsx directly in dev mode with NODE_ENV=production and cwd', () => {
    const { spawn, manager } = setup();
    expect(manager.start('server')).toBe(true);
    const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], { cwd: string; env: NodeJS.ProcessEnv }];
    expect(cmd).toBe('/repo/node_modules/.bin/tsx');
    expect(args).toEqual(['src/presentation/web/server.ts']);
    expect(opts.cwd).toBe('/repo');
    expect(opts.env).toMatchObject({ FOO: 'bar', NODE_ENV: 'production' });
    expect(manager.getStatus('server')).toMatchObject({ state: 'starting', pid: 4242 });
  });

  it('refuses a second start while active', () => {
    const { manager } = setup();
    manager.start('worker');
    expect(manager.start('worker')).toBe(false);
  });

  it('becomes running on the ready log line and buffers parsed logs', () => {
    const { child, manager } = setup();
    manager.start('worker');
    child.stdout.write('{"level":"info","time":1,"msg":"Worker started"}\n');
    expect(manager.getStatus('worker').state).toBe('running');
    expect(manager.getLogs()).toHaveLength(1);
  });

  it('stop sends SIGTERM and ends stopped', async () => {
    const { child, manager } = setup();
    manager.start('server');
    expect(manager.stop('server')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getStatus('server').state).toBe('stopped');
  });

  it('escalates to SIGKILL after the grace period', async () => {
    const { child, manager } = setup(false);
    manager.start('worker');
    manager.stop('worker');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(1001);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(manager.getStatus('worker').state).toBe('stopped');
  });

  it('marks an unrequested non-zero exit as crashed', () => {
    const { child, manager } = setup();
    manager.start('server');
    child.emit('exit', 1, null);
    expect(manager.getStatus('server')).toMatchObject({ state: 'crashed', exitCode: 1, pid: null });
  });

  it('refuses mode switch while a process is active', () => {
    const { manager } = setup();
    manager.start('server');
    expect(manager.setMode('dist')).toBe(false);
    expect(manager.getMode()).toBe('dev');
  });

  it('drops the log lines caused by its own /health polls', () => {
    const { child, manager } = setup();
    manager.start('server');
    const send = (o: object) => child.stdout.write(`${JSON.stringify({ level: 'info', time: 1, ...o })}\n`);
    send({ msg: 'incoming request', reqId: 'req-1', req: { method: 'GET', url: '/health' } });
    send({ msg: 'Request completed' });
    send({ msg: 'request completed', reqId: 'req-1', res: { statusCode: 200 } });
    send({ msg: 'incoming request', reqId: 'req-2', req: { method: 'POST', url: '/webhooks/linear' } });
    send({ msg: 'Request completed' });
    expect(manager.getLogs().map((l) => l.message)).toEqual(['incoming request', 'Request completed']);
  });

  describe('tunnel', () => {
    it('spawns the configured cloudflared command directly, without NODE_ENV', () => {
      const { spawn, manager } = setup();
      expect(manager.start('tunnel')).toBe(true);
      const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
      expect(cmd).toBe('cloudflared');
      expect(args).toEqual(['tunnel', 'run', '--url', 'http://localhost:3030', 'ai-code-review']);
      expect(opts.env.NODE_ENV).toBeUndefined();
    });

    it('refuses to start when the tunnel is not configured', () => {
      const { spawn, manager } = setup(true, null);
      expect(manager.start('tunnel')).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('is running once a connection registers, and its stderr info lines are not errors', () => {
      const { child, manager } = setup();
      manager.start('tunnel');
      child.stderr.write('2026-06-18T13:39:02Z INF Starting tunnel tunnelID=abc\n');
      expect(manager.getStatus('tunnel').state).toBe('starting');
      child.stderr.write('2026-06-18T13:39:03Z INF Registered tunnel connection connIndex=0\n');
      expect(manager.getStatus('tunnel').state).toBe('running');
      expect(manager.getLogs().map((l) => l.level)).toEqual(['info', 'info']);
      expect(manager.getLogs()[0].source).toBe('tunnel');
    });

    it('logs the install hint when cloudflared is missing, and ends crashed', () => {
      const { child, manager } = setup();
      manager.start('tunnel');
      child.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }));
      expect(manager.getLogs().at(-1)?.message).toBe('install cloudflared');
      expect(manager.getStatus('tunnel').state).toBe('crashed');
    });

    it('is independent of server/worker, but counts for anyActive and mode lock does not', () => {
      const { manager } = setup();
      manager.start('tunnel');
      expect(manager.anyActive()).toBe(true);
      expect(manager.isActive('server')).toBe(false);
      expect(manager.setMode('dist')).toBe(true);
    });
  });
});
