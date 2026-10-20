import { describe, expect, it } from 'vitest';
import type { FloorEvent } from '../../src/presentation/web/agent-floor/event-normalizer.js';
import { buildFloor } from '../../src/tui/application/view-models/floor.js';
import { deskGlyph, formatOffset, progressBar } from '../../src/tui/presentation/formatters/floor.js';

let n = 0;
const base = () => ({ cursor: `${++n}.0`, runId: 'r', attempt: 1, timestamp: new Date(Date.parse('2026-01-01T00:00:00Z') + n * 1000).toISOString() });
const started = (): FloorEvent => ({ ...base(), type: 'run_started', ticket: 'ABC-1', ticketTitle: 'T', repo: 'o/r', branch: 'ai-agent/ABC-1', startedAt: '2026-01-01T00:00:00Z' });

describe('buildFloor', () => {
  it('is safe on no events', () => {
    const v = buildFloor([]);
    expect(v.title).toBe('');
    expect(v.desks).toHaveLength(6);
    expect(v.progress).toBe(0);
  });

  it('tracks a working agent, steps and progress', () => {
    const v = buildFloor([
      started(),
      { ...base(), type: 'agent_state', agent: 'planner', state: 'planning' },
      { ...base(), type: 'step', step: 'plan', status: 'pass' },
      { ...base(), type: 'agent_state', agent: 'backend', state: 'implementing' },
    ]);
    expect(v.phase).toBe('run');
    expect(v.desks.find((d) => d.id === 'planner')).toMatchObject({ text: 'Planning', working: true });
    expect(v.desks.find((d) => d.id === 'backend')?.working).toBe(true);
    expect(v.steps.map((s) => s.status)).toEqual(['pass', 'pending', 'pending', 'pending', 'pending']);
    expect(v.progress).toBeCloseTo(0.2);
  });

  it('shows a retry with its counter and logs it', () => {
    const v = buildFloor([started(), { ...base(), type: 'agent_state', agent: 'qa', state: 'retrying', gate: 'qa', retry: { count: 1, max: 2 } }]);
    expect(v.desks.find((d) => d.id === 'qa')).toMatchObject({ state: 'retrying', text: 'Rejected, retry 1/2', tone: 'warn' });
    expect(v.feed.at(-1)?.text).toContain('Validator gate rejected, retry 1/2');
  });

  it('records usage and marks idle agents off duty once the run finished', () => {
    const v = buildFloor([
      started(),
      { ...base(), type: 'usage', agent: 'planner', costUsd: 0.5, tokens: null, durationMs: 4000 },
      { ...base(), type: 'run_finished', finalStatus: 'SUCCESS', gate: null, superseded: false },
    ]);
    expect(v.phase).toBe('success');
    expect(v.desks.find((d) => d.id === 'planner')).toMatchObject({ costUsd: 0.5, durationMs: 4000 });
    expect(v.desks.find((d) => d.id === 'frontend')?.state).toBe('offduty');
    expect(v.desks.find((d) => d.id === 'human')).toMatchObject({ text: 'Run finished', tone: 'ok' });
  });

  it('treats a parked spec as waiting, not failed', () => {
    const v = buildFloor([started(), { ...base(), type: 'run_finished', finalStatus: 'NEEDS_HUMAN', gate: null, superseded: false, waitingFor: 'spec-approval' }]);
    expect(v.phase).toBe('waiting');
    expect(v.pill).toBe('Waiting for spec approval');
  });

  it('resets the floor when a new attempt starts', () => {
    const v = buildFloor([
      started(),
      { ...base(), type: 'agent_state', agent: 'planner', state: 'error', outcome: 'TIMEOUT' },
      { ...started(), attempt: 2 },
    ]);
    expect(v.desks.find((d) => d.id === 'planner')?.state).toBe('idle');
    expect(v.meta).toContain('attempt 2');
  });

  it('uses a single review step for a PR review run', () => {
    const v = buildFloor([{ ...started(), kind: 'pr-review', reviewMode: 'initial', prNumber: 9 } as FloorEvent]);
    expect(v.isReview).toBe(true);
    expect(v.steps.map((s) => s.step)).toEqual(['review']);
  });
});

describe('helpers', () => {
  it('spins only while working', () => {
    const working = buildFloor([started(), { ...base(), type: 'agent_state', agent: 'planner', state: 'planning' }]).desks[0];
    expect(deskGlyph(working, 0)).not.toBe(deskGlyph(working, 1));
    expect(deskGlyph({ ...working, working: false, state: 'idle' }, 0)).toBe(deskGlyph({ ...working, working: false, state: 'idle' }, 1));
  });

  it('formats progress bar and offsets', () => {
    expect(progressBar(0.5, 10)).toBe('█████░░░░░');
    expect(formatOffset(65_000)).toBe('+01:05');
  });
});
