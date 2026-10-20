import type { AgentEvent, PipelineRun } from '../../../infrastructure/db/pipeline-run.repository.js';
import type { PipelineRunApiShape } from '../../../infrastructure/db/pipeline-run-shape.js';
import type { FloorEvent } from '../../../presentation/web/agent-floor/event-normalizer.js';

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

export interface FailedJobInfo {
  id: string;
  name: string;
  attemptsMade: number;
  failedReason: string;
  finishedOn: number | null;
  ticket: string | null;
}

export interface RunDetailView {
  run: PipelineRun;
  api: PipelineRunApiShape;
  events: AgentEvent[];
  floor: FloorEvent[];
}

export interface HealthInfo {
  redis: 'up' | 'down';
  db: 'up' | 'missing' | 'down';
  server: 'up' | 'down';
}

/** Everything the views read. An interface so views can be driven by a fake in tests. */
export interface ITuiDataSource {
  listRuns(limit?: number): PipelineRunApiShape[];
  getRunDetail(runId: string): RunDetailView | undefined;
  queueCounts(): Promise<QueueCounts | null>;
  failedJobs(limit?: number): Promise<FailedJobInfo[]>;
  retryJob(jobId: string): Promise<boolean>;
  health(): Promise<HealthInfo>;
  /** True when `url` answers over HTTP at all (200 or 503, i.e. the app's /health), within a few seconds. */
  probe(url: string): Promise<boolean>;
  /** Calls onNudge on every dashboard event published by the worker; returns an unsubscribe. */
  subscribe(onNudge: () => void): () => void;
  close(): Promise<void>;
}
