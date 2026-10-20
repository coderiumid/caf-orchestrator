import { describe, expect, it } from 'vitest';
import { heartbeat, justify, renderHeaderLines, visibleLength, type HeaderInput } from '../../src/tui/presentation/formatters/header.js';

const status = (state: 'stopped' | 'running' | 'crashed' | 'starting', over = {}) => ({
  name: 'server' as const, state, pid: state === 'running' ? 123 : null, startedAt: state === 'running' ? 1_000_000 : null, exitCode: null, ...over,
});

function input(over: Partial<HeaderInput> = {}): HeaderInput {
  return {
    version: '0.1.1', now: 1_000_000 + 125_000, frame: 0, width: 160,
    server: status('running'), worker: { ...status('stopped'), name: 'worker' },
    health: { redis: 'up', db: 'up', server: 'up' },
    queue: { waiting: 1, active: 2, delayed: 0, failed: 3, completed: 9 },
    mode: 'dev', port: 3030, trigger: true, activeRuns: 1,
    tunnel: { ...status('stopped'), name: 'tunnel' as const }, ...over,
  };
}

const plain = (s: string) => s.replace(/\{[^}]*\}/g, '');

describe('header model', () => {
  it('measures visible length without tags', () => {
    expect(visibleLength('{red-fg}abc{/}')).toBe(3);
    expect(visibleLength('{#fab283-fg}abc{/}')).toBe(3);
  });

  it('right-aligns to the width', () => {
    expect(visibleLength(justify('{red-fg}ab{/}', 'cd', 20))).toBe(20);
    expect(justify('a', 'b', 1)).toBe('a b');
  });

  it('builds two lines that fit the width', () => {
    const lines = renderHeaderLines(input());
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(visibleLength(l)).toBeLessThanOrEqual(159);
  });

  it('shows brand and version on the first line, process dots and uptime on the second', () => {
    const [l1, l2] = renderHeaderLines(input()).map(plain);
    expect(l1).toContain('CAF Orchestrator');
    expect(l1).toContain('v0.1.1');
    expect(l2).toContain('● server ↑2m 5s');
    expect(l2).toContain('○ worker off');
    expect(l2).toContain('○ tunnel off');
    expect(l2).toContain('● redis');
    expect(l2).toContain('● db');
    expect(l2).toContain('● http');
  });

  it('shows queue counts, trigger and mode on the right', () => {
    const l2 = plain(renderHeaderLines(input())[1]);
    expect(l2).toContain('1 waiting');
    expect(l2).toContain('2 active');
    expect(l2).toContain('3 failed');
    expect(l2).toContain('trigger ON');
    expect(l2).toContain('dev :3030');
  });

  it('flags a crash with the exit code and a down dependency', () => {
    const l2 = plain(renderHeaderLines(input({ worker: { ...status('crashed', { exitCode: 1 }), name: 'worker' }, health: { redis: 'down', db: 'missing', server: 'down' }, queue: null }))[1]);
    expect(l2).toContain('✖ worker crashed exit 1');
    expect(l2).toContain('queue n/a');
    expect(l2).toContain('✖ redis down');
    expect(l2).toContain('◌ db missing');
  });

  it('omits the trigger flag when unset and animates the heartbeat only when busy', () => {
    expect(plain(renderHeaderLines(input({ trigger: null }))[1])).not.toContain('trigger');
    expect(heartbeat(true, 0)).not.toBe(heartbeat(true, 1));
    expect(heartbeat(false, 0)).toBe(heartbeat(false, 3));
  });

  it('drops the flags and then the queue instead of overflowing a narrow terminal', () => {
    for (let width = 100; width <= 200; width++) {
      const l2 = renderHeaderLines(input({ width }))[1];
      expect(visibleLength(l2), `width ${width}`).toBeLessThanOrEqual(width - 1);
      // The flags go first: they never show without the queue.
      if (plain(l2).includes('trigger')) expect(plain(l2)).toContain('3 failed');
    }
    expect(plain(renderHeaderLines(input({ width: 200 }))[1])).toContain('trigger ON');
    const narrow = plain(renderHeaderLines(input({ width: 80 }))[1]);
    expect(narrow).not.toContain('failed');
    expect(narrow).toContain('server');
  });
});
