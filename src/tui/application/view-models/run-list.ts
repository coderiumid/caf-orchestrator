import type { PipelineRunApiShape } from '../../../infrastructure/db/pipeline-run-shape.js';

export type RunType = 'pipeline' | 'review' | 'fix';
export type TypeFilter = 'all' | RunType;
export type StatusFilter = 'all' | 'running' | 'success' | 'waiting' | 'attention' | 'error';

export const TYPE_FILTERS: readonly TypeFilter[] = ['all', 'pipeline', 'review', 'fix'];
export const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'running', 'success', 'waiting', 'attention', 'error'];

export function runType(run: PipelineRunApiShape): RunType {
  if (run.kind !== 'pr-review') return 'pipeline';
  return run.reviewMode === 'initial' ? 'review' : 'fix';
}

/** Mirrors the dashboard's status buckets: a run parked on Clarify/spec approval is "waiting", not "running". */
export function statusBucket(run: PipelineRunApiShape): Exclude<StatusFilter, 'all'> {
  if (run.finalStatus === null) return 'running';
  if (run.finalStatus === 'SUCCESS') return 'success';
  if (run.finalStatus === 'NEEDS_HUMAN') return run.waitingFor ? 'waiting' : 'attention';
  return 'error';
}

export function statusLabel(run: PipelineRunApiShape): string {
  switch (statusBucket(run)) {
    case 'running':
      return 'RUNNING';
    case 'success':
      return 'SUCCESS';
    case 'waiting':
      return run.waitingFor === 'clarify' ? 'AWAIT CLARIFY' : 'AWAIT SPEC';
    case 'attention':
      return 'NEEDS HUMAN';
    default:
      return 'ERROR';
  }
}

const STATUS_COLOR: Record<ReturnType<typeof statusBucket>, string> = {
  running: 'cyan',
  success: 'green',
  waiting: 'yellow',
  attention: 'magenta',
  error: 'red',
};

export function statusColor(run: PipelineRunApiShape): string {
  return STATUS_COLOR[statusBucket(run)];
}

export interface RunFilters {
  search: string;
  type: TypeFilter;
  status: StatusFilter;
  repo: string; // '' = all
}

export function filterRuns(runs: readonly PipelineRunApiShape[], f: RunFilters): PipelineRunApiShape[] {
  const needle = f.search.trim().toLowerCase();
  const out = runs.filter((r) => {
    if (f.type !== 'all' && runType(r) !== f.type) return false;
    if (f.status !== 'all' && statusBucket(r) !== f.status) return false;
    if (f.repo && r.repoId !== f.repo) return false;
    if (needle && !`${r.ticketId} ${r.ticketTitle} ${r.repoId}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  // Running rows pinned on top; the repository already returns newest first, and sort is stable.
  return out.sort((a, b) => Number(statusBucket(b) === 'running') - Number(statusBucket(a) === 'running'));
}

export interface RunStats {
  active: number;
  completed: number;
  waiting: number;
  attention: number;
  spend: number | null;
}

export function computeStats(runs: readonly PipelineRunApiShape[]): RunStats {
  const stats: RunStats = { active: 0, completed: 0, waiting: 0, attention: 0, spend: null };
  for (const r of runs) {
    const bucket = statusBucket(r);
    if (bucket === 'running') stats.active++;
    else if (bucket === 'success') stats.completed++;
    else if (bucket === 'waiting') stats.waiting++;
    else stats.attention++; // attention + error, as the dashboard's "Needs attention" tile
    if (r.totalCostUsd !== null) stats.spend = (stats.spend ?? 0) + r.totalCostUsd;
  }
  return stats;
}
