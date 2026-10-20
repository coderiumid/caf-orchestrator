import { describe, expect, it } from 'vitest';
import type { PipelineRunApiShape } from '../../src/infrastructure/db/pipeline-run-shape.js';
import { buildStatTiles, sparkline } from '../../src/tui/application/view-models/stat-tiles.js';
import { computeStats, filterRuns, runType, statusBucket, statusLabel } from '../../src/tui/application/view-models/run-list.js';
import { escapeTags } from '../../src/tui/presentation/formatters/markup.js';
import { formatElapsed, truncate } from '../../src/tui/shared/format.js';

function run(over: Partial<PipelineRunApiShape>): PipelineRunApiShape {
  return {
    runId: 'r', kind: 'pipeline', reviewMode: null, reviewResult: null, waitingFor: null, acSummary: null,
    repoId: 'o/r', ticketId: 'ABC-1', ticketTitle: 'Title', startedAt: '2026-01-01T00:00:00Z', endedAt: null,
    finalStatus: null, status: 'RUNNING', attempt: 1, prNumber: null, currentPivPhase: null, retryCounts: {},
    totalCostUsd: null, lastArtifactLink: null, ...over,
  };
}

describe('view-models', () => {
  it('classifies run types and status buckets', () => {
    expect(runType(run({ kind: 'pr-review', reviewMode: 'initial' }))).toBe('review');
    expect(runType(run({ kind: 'pr-review', reviewMode: 'scoped' }))).toBe('fix');
    expect(statusBucket(run({ finalStatus: 'NEEDS_HUMAN', waitingFor: 'clarify' }))).toBe('waiting');
    expect(statusBucket(run({ finalStatus: 'NEEDS_HUMAN' }))).toBe('attention');
    expect(statusLabel(run({ finalStatus: 'NEEDS_HUMAN', waitingFor: 'spec-approval' }))).toBe('AWAIT SPEC');
  });

  it('computes dashboard stats', () => {
    const s = computeStats([
      run({}),
      run({ finalStatus: 'SUCCESS', totalCostUsd: 1.5 }),
      run({ finalStatus: 'ERROR', totalCostUsd: 0.5 }),
      run({ finalStatus: 'NEEDS_HUMAN', waitingFor: 'clarify' }),
    ]);
    expect(s).toEqual({ active: 1, completed: 1, waiting: 1, attention: 1, spend: 2 });
  });

  it('filters and pins running runs on top', () => {
    const rows = [run({ runId: 'a', finalStatus: 'SUCCESS', ticketId: 'X-1' }), run({ runId: 'b', ticketId: 'X-2' })];
    const all = filterRuns(rows, { search: '', type: 'all', status: 'all', repo: '' });
    expect(all.map((r) => r.runId)).toEqual(['b', 'a']);
    expect(filterRuns(rows, { search: 'x-1', type: 'all', status: 'all', repo: '' }).map((r) => r.runId)).toEqual(['a']);
    expect(filterRuns(rows, { search: '', type: 'all', status: 'running', repo: '' }).map((r) => r.runId)).toEqual(['b']);
  });

  it('formats elapsed and truncates', () => {
    const now = Date.parse('2026-01-01T01:05:00Z');
    expect(formatElapsed('2026-01-01T00:00:00Z', null, now)).toBe('1h 5m');
    expect(formatElapsed('2026-01-01T00:00:00Z', '2026-01-01T00:00:30Z')).toBe('30s');
    expect(truncate('abcdef', 4)).toBe('abc…');
  });

  it('escapes blessed tag braces', () => {
    expect(escapeTags('a{b}')).toBe('a{open}b{close}');
  });
});

describe('stat tiles', () => {
  const rows = [
    run({ runId: 'a' }),
    run({ runId: 'b', finalStatus: 'SUCCESS', totalCostUsd: 2 }),
    run({ runId: 'c', finalStatus: 'SUCCESS', totalCostUsd: 1 }),
    run({ runId: 'd', finalStatus: 'ERROR' }),
    run({ runId: 'e', finalStatus: 'NEEDS_HUMAN', waitingFor: 'spec-approval' }),
  ];

  it('builds five tiles with captions and bars', () => {
    const tiles = buildStatTiles(rows, 10);
    expect(tiles.map((t) => t.id)).toEqual(['active', 'completed', 'waiting', 'attention', 'spend']);
    const by = Object.fromEntries(tiles.map((t) => [t.id, t]));
    expect(by.active).toMatchObject({ value: '1', caption: 'running now', bar: '▰▰▱▱▱▱▱▱▱▱' });
    expect(by.completed.caption).toBe('67% success rate');
    expect(by.waiting.caption).toBe('0 clarify · 1 spec');
    expect(by.attention).toMatchObject({ value: '1', caption: '0 human · 1 error' });
    expect(by.spend).toMatchObject({ value: '$3.00', caption: 'avg $1.50 / run' });
  });

  it('is calm with no runs', () => {
    const by = Object.fromEntries(buildStatTiles([], 6).map((t) => [t.id, t]));
    expect(by.active.caption).toBe('all quiet');
    expect(by.completed.caption).toBe('no finished runs');
    expect(by.spend).toMatchObject({ value: '$0.00', caption: 'no cost data' });
  });

  it('draws sparklines scaled to the max', () => {
    expect(sparkline([0, 1, 2])).toBe('▁▅█');
    expect(sparkline([])).toBe('');
  });
});
