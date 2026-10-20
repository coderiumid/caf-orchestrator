import { describe, expect, it } from 'vitest';
import { isActiveState, planAll, planKill, planQuit, planRestart, planToggle, startAllOrder } from '../../src/tui/application/process-plans.js';

describe('planToggle', () => {
  it('starts anything that is not running', () => {
    expect(planToggle('server', 'stopped', 0)).toEqual({ action: 'start' });
    expect(planToggle('tunnel', 'crashed', 0)).toEqual({ action: 'start' });
  });

  it('stops a running process without asking, unless it is a worker with jobs', () => {
    expect(planToggle('server', 'running', 3)).toEqual({ action: 'stop' });
    expect(planToggle('worker', 'running', 0)).toEqual({ action: 'stop' });
    const busy = planToggle('worker', 'running', 2);
    expect(busy.action).toBe('stop');
    expect(busy.confirm).toContain('2 active job(s)');
  });

  it('offers a force kill while stopping and while starting just stops', () => {
    expect(planToggle('worker', 'stopping', 5)).toMatchObject({ action: 'force', confirm: expect.stringContaining('still stopping') });
    expect(planToggle('tunnel', 'starting', 0)).toEqual({ action: 'stop' });
  });
});

describe('planAll', () => {
  it('starts when nothing runs and stops otherwise, asking only with active jobs', () => {
    expect(planAll(false, 4)).toEqual({ action: 'startAll' });
    expect(planAll(true, 0)).toEqual({ action: 'stopAll' });
    expect(planAll(true, 1)).toMatchObject({ action: 'stopAll', confirm: expect.stringContaining('1 active job(s)') });
  });

  it('starts the tunnel between server and worker only when asked to', () => {
    expect(startAllOrder(true)).toEqual(['server', 'tunnel', 'worker']);
    expect(startAllOrder(false)).toEqual(['server', 'worker']);
  });
});

describe('restart, kill and quit', () => {
  it('asks before restarting a busy worker only', () => {
    expect(planRestart('worker', 1).confirm).toContain('Restart anyway');
    expect(planRestart('worker', 0)).toEqual({ action: 'restart' });
    expect(planRestart('server', 9)).toEqual({ action: 'restart' });
  });

  it('always confirms a kill and explains the consequence per process', () => {
    expect(planKill('worker')).toMatchObject({ action: 'force', confirm: expect.stringContaining('retried by BullMQ') });
    expect(planKill('tunnel').confirm).toContain('Webhooks stop reaching');
    expect(planKill('server').confirm).toContain('In-flight requests');
  });

  it('confirms quitting only while something runs', () => {
    expect(planQuit(false)).toEqual({});
    expect(planQuit(true).confirm).toContain('Quit?');
  });

  it('knows which states are active', () => {
    expect(['starting', 'running', 'stopping'].every((s) => isActiveState(s as never))).toBe(true);
    expect(['stopped', 'crashed'].some((s) => isActiveState(s as never))).toBe(false);
  });
});
