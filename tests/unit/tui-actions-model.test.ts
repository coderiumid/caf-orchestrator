import { describe, expect, it } from 'vitest';
import { transitionToast } from '../../src/tui/application/process-toasts.js';
import { actionText, buildActions, type ActionsInput } from '../../src/tui/application/view-models/actions.js';
import type { ProcessStatus } from '../../src/tui/domain/models/process.js';

const input = (over: Partial<ActionsInput> = {}): ActionsInput => ({ server: 'stopped', worker: 'stopped', tunnel: 'stopped', tunnelAvailable: true, tunnelInAll: false, focused: 'worker', activeJobs: 0, failedJobs: 0, ...over });
const by = (a: ReturnType<typeof buildActions>) => Object.fromEntries(a.map((x) => [x.id, x]));
const st = (name: 'server' | 'worker' | 'tunnel', state: ProcessStatus['state'], over: Partial<ProcessStatus> = {}): ProcessStatus => ({ name, state, pid: null, startedAt: null, exitCode: null, ...over });

describe('buildActions', () => {
  it('offers START when stopped, with kill disabled', () => {
    const a = by(buildActions(input()));
    expect(a.server).toMatchObject({ label: 'START SERVER', icon: '▶', bg: 'green' });
    expect(a.all.label).toBe('START ALL');
    expect(a.kill.disabled).toBe(true);
  });

  it('turns into STOP when running and warns about running jobs', () => {
    const a = by(buildActions(input({ server: 'running', worker: 'running', activeJobs: 2 })));
    expect(a.server).toMatchObject({ label: 'STOP SERVER', bg: 'red' });
    expect(a.worker.hint).toContain('2 running job');
    expect(a.all.label).toBe('STOP ALL');
    expect(a.kill.disabled).toBe(false);
  });

  it('offers a force kill while stopping and names the focused process', () => {
    const a = by(buildActions(input({ worker: 'stopping', focused: 'worker' })));
    expect(a.worker).toMatchObject({ label: 'FORCE WORKER', icon: '»' });
    expect(a.restart.label).toBe('RESTART worker');
    expect(a.kill.label).toBe('KILL worker');
    expect(a.kill.disabled).toBe(false);
  });

  it('mentions a previous crash in the start hint', () => {
    expect(by(buildActions(input({ server: 'crashed' }))).server.hint).toContain('crashed');
  });

  it('has an always-enabled help button on ?', () => {
    expect(by(buildActions(input({ server: 'running' }))).help).toMatchObject({ key: '?', short: 'HELP', disabled: false });
    expect(by(buildActions(input())).mode).toBeUndefined();
  });

  it('prints icon and the short label', () => {
    expect(actionText(by(buildActions(input())).server)).toBe(' ▶ START SERVER ');
    expect(actionText(by(buildActions(input())).restart)).toBe(' ↻ RESTART ');
  });

  it('keeps every button label within a half-width button', () => {
    const states = ['stopped', 'starting', 'running', 'stopping', 'crashed'] as const;
    for (const state of states) {
      for (const a of buildActions(input({ server: state, worker: state, tunnel: state, failedJobs: 12 }))) {
        // Button inner width is 16: border (2) of an 18-wide button.
        expect(actionText(a).length, `${a.id}/${state}: "${actionText(a)}"`).toBeLessThanOrEqual(16);
      }
    }
  });

  it('has a tunnel toggle on n that follows the tunnel state, independent of server and worker', () => {
    const idle = by(buildActions(input()));
    expect(idle.tunnel).toMatchObject({ key: 'n', label: 'START TUNNEL', bg: 'green' });
    const up = by(buildActions(input({ tunnel: 'running' })));
    expect(up.tunnel).toMatchObject({ label: 'STOP TUNNEL', bg: 'red' });
    expect(up.all.label).toBe('START ALL');
    expect(by(buildActions(input({ tunnel: 'running', tunnelInAll: true }))).all.label).toBe('STOP ALL');
    expect(by(buildActions(input({ tunnel: 'stopping' }))).tunnel.label).toBe('FORCE TUNNEL');
  });

  it('START ALL mentions the tunnel only when TUNNEL_URL is set', () => {
    expect(by(buildActions(input({ tunnelInAll: true }))).all.hint).toBe('Start server, worker and tunnel');
    expect(by(buildActions(input())).all.hint).toContain('set TUNNEL_URL');
  });

  it('disables the tunnel button when its settings are invalid', () => {
    expect(by(buildActions(input({ tunnelAvailable: false }))).tunnel).toMatchObject({ disabled: true, bg: 'gray' });
  });

  it('can target the tunnel for restart and kill', () => {
    const a = by(buildActions(input({ focused: 'tunnel', tunnel: 'running' })));
    expect(a.restart.label).toBe('RESTART tunnel');
    expect(a.kill.disabled).toBe(false);
  });

  it('shows the failed-job count on the queue button', () => {
    expect(by(buildActions(input({ failedJobs: 4 }))).queue).toMatchObject({ short: 'QUEUE 4', bg: 'yellow', key: 'u' });
    expect(by(buildActions(input())).queue.short).toBe('QUEUE');
  });
});

describe('transitionToast', () => {
  it('announces up, stop, stopping and crash', () => {
    expect(transitionToast(st('server', 'starting'), st('server', 'running', { pid: 7 }))).toEqual({ tone: 'ok', text: 'Server is up (pid 7)' });
    expect(transitionToast(st('server', 'running'), st('server', 'stopped'))).toEqual({ tone: 'info', text: 'Server stopped' });
    expect(transitionToast(st('worker', 'running'), st('worker', 'stopping'))?.text).toContain('waiting for the running job');
    expect(transitionToast(st('worker', 'running'), st('worker', 'crashed', { exitCode: 1 }))).toMatchObject({ tone: 'bad', text: 'Worker crashed (exit 1) — see logs' });
  });

  it('names the tunnel in toasts', () => {
    expect(transitionToast(st('tunnel', 'starting'), st('tunnel', 'running', { pid: 9 }))?.text).toBe('Tunnel is up (pid 9)');
    expect(transitionToast(st('tunnel', 'running'), st('tunnel', 'crashed', { exitCode: 1 }))?.text).toContain('Tunnel crashed');
  });

  it('stays quiet for non-changes and for starting', () => {
    expect(transitionToast(st('server', 'running'), st('server', 'running'))).toBeNull();
    expect(transitionToast(undefined, st('server', 'starting'))).toBeNull();
    expect(transitionToast(undefined, st('server', 'stopped'))).toBeNull();
  });
});
