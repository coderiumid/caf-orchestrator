import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { IProcessController } from '../../domain/interfaces/process-controller.interface.js';
import type { LogLine } from '../../domain/models/log-line.js';
import { PROCESS_NAMES, type ProcessName, type ProcessStatus, type RunMode } from '../../domain/models/process.js';
import { LineSplitter, parseLogLine } from './log-parser.js';

type SpawnFn = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] }) => ChildProcess;

export interface ProcessManagerOptions {
  repoRoot: string;
  /** Worker SIGTERM grace: it waits on a running job, so this is the agent timeout plus margin. */
  workerGraceMs: number;
  serverGraceMs?: number;
  /** The cloudflared command, or null when the tunnel is not configured (start('tunnel') is then refused). */
  tunnel?: { command: string; args: readonly string[]; notFoundHint?: string } | null;
  mode?: RunMode;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  maxLogLines?: number;
}

/** Log line that flips a starting process to running. */
const READY_PATTERN: Record<ProcessName, RegExp> = {
  server: /Server listening on port/,
  worker: /Worker started/,
  tunnel: /Registered tunnel connection/,
};

const ENTRY: Record<'server' | 'worker', { dev: string; dist: string }> = {
  server: { dev: 'src/presentation/web/server.ts', dist: 'dist/presentation/web/server.js' },
  worker: { dev: 'src/worker.ts', dist: 'dist/worker.js' },
};

interface Managed {
  child: ChildProcess | null;
  status: ProcessStatus;
  killTimer: NodeJS.Timeout | null;
}

/**
 * Owns the two long-lived child processes. Children are spawned directly
 * (tsx / node, never via pnpm) so SIGTERM reaches the real process, which has
 * its own graceful shutdown. Events: 'status' (ProcessStatus), 'log' (LogLine).
 */
export class ProcessManager extends EventEmitter implements IProcessController {
  private readonly managed: Record<ProcessName, Managed> = {
    server: this.blank('server'),
    worker: this.blank('worker'),
    tunnel: this.blank('tunnel'),
  };
  private readonly logs: LogLine[] = [];
  private mode: RunMode;
  private readonly spawnFn: SpawnFn;
  private readonly maxLogLines: number;

  constructor(private readonly options: ProcessManagerOptions) {
    super();
    this.mode = options.mode ?? 'dev';
    this.spawnFn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.maxLogLines = options.maxLogLines ?? 2000;
  }

  private blank(name: ProcessName): Managed {
    return { child: null, killTimer: null, status: { name, state: 'stopped', pid: null, startedAt: null, exitCode: null } };
  }

  getStatus(name: ProcessName): ProcessStatus {
    return { ...this.managed[name].status };
  }

  getLogs(): readonly LogLine[] {
    return this.logs;
  }

  getMode(): RunMode {
    return this.mode;
  }

  /** Mode only applies to the next start; refuses while anything runs so the two never mix. */
  setMode(mode: RunMode): boolean {
    if (this.isActive('server') || this.isActive('worker')) return false;
    this.mode = mode;
    return true;
  }

  /** True while server, worker or tunnel is starting, running or stopping. */
  anyActive(): boolean {
    return PROCESS_NAMES.some((n) => this.isActive(n));
  }

  isActive(name: ProcessName): boolean {
    const s = this.managed[name].status.state;
    return s === 'starting' || s === 'running' || s === 'stopping';
  }

  start(name: ProcessName): boolean {
    const m = this.managed[name];
    if (this.isActive(name)) return false;

    let command: string;
    let args: readonly string[];
    let env: NodeJS.ProcessEnv;
    if (name === 'tunnel') {
      if (!this.options.tunnel) return false;
      ({ command, args } = this.options.tunnel);
      env = { ...(this.options.env ?? process.env) };
    } else {
      const entry = ENTRY[name][this.mode];
      [command, args] =
        this.mode === 'dev'
          ? [join(this.options.repoRoot, 'node_modules', '.bin', 'tsx'), [entry]]
          : [process.execPath, [entry]];
      // production => pino emits JSON lines the log pane can parse. DASHBOARD etc. come from the parent env + .env.
      env = { ...(this.options.env ?? process.env), NODE_ENV: 'production' };
    }
    const child = this.spawnFn(command, args, { cwd: this.options.repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    m.child = child;
    this.setStatus(name, { state: 'starting', pid: child.pid ?? null, startedAt: Date.now(), exitCode: null });

    for (const [stream, fromStderr] of [[child.stdout, false], [child.stderr, true]] as const) {
      const splitter = new LineSplitter();
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => splitter.push(chunk).forEach((l) => this.ingest(name, l, fromStderr)));
      stream?.on('end', () => splitter.flush().forEach((l) => this.ingest(name, l, fromStderr)));
    }

    child.on('error', (err) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      this.ingest(name, missing && name === 'tunnel' && this.options.tunnel?.notFoundHint ? this.options.tunnel.notFoundHint : `spawn failed: ${err.message}`, true);
      this.finish(name, null, false);
    });
    child.on('exit', (code, signal) => {
      const requested = m.status.state === 'stopping';
      this.finish(name, code ?? (signal ? 1 : 0), requested);
    });
    return true;
  }

  /** SIGTERM, then SIGKILL after the grace period. Returns false if nothing to stop. */
  stop(name: ProcessName): boolean {
    const m = this.managed[name];
    if (!m.child || !this.isActive(name)) return false;
    if (m.status.state === 'stopping') return false;
    this.setStatus(name, { state: 'stopping' });
    m.child.kill('SIGTERM');
    const grace = name === 'worker' ? this.options.workerGraceMs : name === 'tunnel' ? 10_000 : (this.options.serverGraceMs ?? 15_000);
    m.killTimer = setTimeout(() => m.child?.kill('SIGKILL'), grace);
    m.killTimer.unref?.();
    return true;
  }

  /** Immediate SIGKILL — the "second press" on a stuck stop. */
  forceKill(name: ProcessName): boolean {
    const m = this.managed[name];
    if (!m.child || !this.isActive(name)) return false;
    if (m.status.state !== 'stopping') this.setStatus(name, { state: 'stopping' });
    m.child.kill('SIGKILL');
    return true;
  }

  /** Stop then start once the old process is gone. */
  restart(name: ProcessName): void {
    if (!this.isActive(name)) {
      this.start(name);
      return;
    }
    const onStatus = (s: ProcessStatus) => {
      if (s.name === name && (s.state === 'stopped' || s.state === 'crashed')) {
        this.off('status', onStatus);
        this.start(name);
      }
    };
    this.on('status', onStatus);
    this.stop(name);
  }

  /** Synchronous best-effort kill for TUI exit — no child may outlive the TUI. */
  killAllNow(): void {
    for (const name of PROCESS_NAMES) {
      const m = this.managed[name];
      if (m.killTimer) clearTimeout(m.killTimer);
      m.child?.kill('SIGKILL');
    }
  }

  /** Graceful shutdown of both; resolves once both exited (or after the force-kill backstop). */
  async stopAll(): Promise<void> {
    const waits = PROCESS_NAMES.filter((n) => this.isActive(n)).map((n) => this.waitStopped(n));
    PROCESS_NAMES.forEach((n) => this.stop(n));
    await Promise.all(waits);
  }

  private waitStopped(name: ProcessName): Promise<void> {
    return new Promise((resolve) => {
      const onStatus = (s: ProcessStatus) => {
        if (s.name === name && (s.state === 'stopped' || s.state === 'crashed')) {
          this.off('status', onStatus);
          resolve();
        }
      };
      this.on('status', onStatus);
    });
  }

  /** reqIds of the TUI's own GET /health polls. */
  private readonly healthReqIds = new Set<string>();
  /** The app's own "Request completed" line carries no url or reqId; it follows its "incoming request" line directly. */
  private healthCompletedDue = false;

  /** True for the log lines produced by the TUI polling /health, which would otherwise drown the server log every 2s. */
  private isHealthPollNoise(line: LogLine): boolean {
    const reqId = typeof line.fields.reqId === 'string' ? line.fields.reqId : null;
    const url = (line.fields.req as { url?: unknown } | undefined)?.url;
    if (line.message === 'incoming request' && reqId && url === '/health') {
      this.healthReqIds.add(reqId);
      this.healthCompletedDue = true;
      return true;
    }
    if (line.message === 'Request completed' && this.healthCompletedDue) {
      this.healthCompletedDue = false;
      return true;
    }
    if (reqId && this.healthReqIds.has(reqId)) {
      if (line.message === 'request completed') this.healthReqIds.delete(reqId);
      return true;
    }
    return false;
  }

  private ingest(name: ProcessName, raw: string, fromStderr: boolean): void {
    // cloudflared writes its normal (info) output to stderr, so stderr only means "error" for our own processes.
    const line = parseLogLine(name, raw, Date.now(), fromStderr && name !== 'tunnel');
    if (name === 'server' && this.isHealthPollNoise(line)) return;
    this.logs.push(line);
    if (this.logs.length > this.maxLogLines) this.logs.splice(0, this.logs.length - this.maxLogLines);
    if (this.managed[name].status.state === 'starting' && READY_PATTERN[name].test(line.message)) {
      this.setStatus(name, { state: 'running' });
    }
    this.emit('log', line);
  }

  private finish(name: ProcessName, exitCode: number | null, requested: boolean): void {
    const m = this.managed[name];
    if (m.killTimer) clearTimeout(m.killTimer);
    m.killTimer = null;
    m.child = null;
    this.setStatus(name, { state: requested || exitCode === 0 ? 'stopped' : 'crashed', pid: null, exitCode });
  }

  private setStatus(name: ProcessName, patch: Partial<ProcessStatus>): void {
    const m = this.managed[name];
    m.status = { ...m.status, ...patch };
    this.emit('status', { ...m.status });
  }
}
