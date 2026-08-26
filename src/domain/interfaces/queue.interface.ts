export interface IQueue {
  addJob(name: string, data: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/**
 * Domain-owned shape of per-project routing data carried on a job.
 * Deliberately a subset of config's ProjectConfig — the domain layer must
 * not depend on config-loading concerns (validation shape, versioning,
 * etc.); infrastructure maps ProjectConfig -> JobProjectContext at the
 * point a job payload is built.
 */
export interface JobProjectContext {
  repoCloneUrl: string;
  baseBranch: string;
  workspaceDir: string;
  agents: {
    modelOverrides: Record<string, string>;
  };
}

export interface ExistingJobPayload {
  jobId: string;
  ticketId: string;
  ticketKey: string;
  ticketTitle: string;
  ticketDescription: string;
  projectConfig: JobProjectContext;
}

/**
 * Comment/thread context carried into a `pr-review` job — mirrors the shape
 * `/caf-fix-review` (caf-initiator) injects directly into the reviewer agent's
 * spawn prompt (label INLINE/GENERAL, path/line only for INLINE). See
 * caf-initiator/src/templates/fix-review-command.js `spawnSection()`.
 */
export interface PrReviewCommentContext {
  // GitHub comment id — not in plan-checkpoint-b.md's original payload sketch,
  // added because Task F's reply-to-comment step (POST .../pulls/{pr}/comments/{id}/replies)
  // needs it, and readFixReviewLog() needs it to correlate a fix-review-log.md
  // block back to the GitHub comment it replies to.
  id: number;
  label: 'INLINE' | 'GENERAL';
  body: string;
  path?: string;
  line?: number;
}

export interface PrReviewJobPayload {
  jobId: string;
  repoFullName: string;
  cloneUrl: string;
  prNumber: number;
  prHeadBranch: string;
  mode: 'initial' | 'scoped' | 'global';
  commentContext: PrReviewCommentContext[];
}

export type JobPayload = ExistingJobPayload | PrReviewJobPayload;

export type JobRunner = (job: { name: string; data: JobPayload; id: string }) => Promise<void>;
