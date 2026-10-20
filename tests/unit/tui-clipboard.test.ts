import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { clipboardCommands, copyToClipboard } from '../../src/tui/infrastructure/system/clipboard.js';

function fakeSpawn(behaviour: Record<string, 'ok' | 'enoent' | 'fail'>) {
  const written: Record<string, string> = {};
  const spawn = vi.fn((command: string) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough };
    child.stdin = new PassThrough();
    let data = '';
    child.stdin.on('data', (c) => (data += c));
    child.stdin.on('end', () => (written[command] = data));
    queueMicrotask(() => {
      const b = behaviour[command] ?? 'enoent';
      if (b === 'enoent') child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      else setTimeout(() => child.emit('exit', b === 'ok' ? 0 : 1), 0);
    });
    return child;
  });
  return { spawn: spawn as never, written, calls: spawn };
}

describe('clipboard', () => {
  it('uses pbcopy on macOS and passes the text on stdin', async () => {
    const f = fakeSpawn({ pbcopy: 'ok' });
    expect(await copyToClipboard('https://x.example/webhooks/github', 'darwin', f.spawn)).toBe(true);
    expect(f.written.pbcopy).toBe('https://x.example/webhooks/github');
    expect(f.calls.mock.calls[0][1]).toEqual([]);
  });

  it('falls back through the Linux tools', async () => {
    const f = fakeSpawn({ xclip: 'ok' });
    expect(await copyToClipboard('t', 'linux', f.spawn)).toBe(true);
    expect(f.calls.mock.calls.map((c) => c[0])).toEqual(['wl-copy', 'xclip']);
  });

  it('reports failure when no tool works', async () => {
    expect(await copyToClipboard('t', 'linux', fakeSpawn({}).spawn)).toBe(false);
    expect(await copyToClipboard('t', 'darwin', fakeSpawn({ pbcopy: 'fail' }).spawn)).toBe(false);
  });

  it('lists a command for each platform', () => {
    expect(clipboardCommands('win32')[0].command).toBe('clip');
  });
});
