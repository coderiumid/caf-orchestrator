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

/**
 * CAF-RETRYPIPELINE-01: carried on a resume job — either from
 * `/caf-retry-pipeline` (Task 4) or a Linear ticket re-entering "Ready for AI"
 * on a branch that already exists (Task 5). Both trigger paths resolve the
 * same open PR (via `findOpenPullRequestByHead`) and route every status
 * comment for this run there, rather than back to the original Linear
 * ticket/GitHub issue — that PR thread is where the human who triggered the
 * retry is actually watching.
 */
export interface RetryContext {
  owner: string;
  repo: string;
  prNumber: number;
  maxOrchestrationRetries: number;
}

export interface ExistingJobPayload {
  jobId: string;
  ticketId: string;
  ticketKey: string;
  ticketTitle: string;
  ticketDescription: string;
  projectConfig: JobProjectContext;
  // Where this ticket lives, and therefore where pipeline status comments get
  // posted back to. Undefined ≡ 'linear' — every pre-existing job payload
  // (including any already queued in Redis) has no such field and must keep
  // behaving exactly as before.
  ticketSource?: 'linear' | 'github';
  // CAF-RETRYPIPELINE-01: true when this job is a resume of a
  // previously-gate-exhausted ticket (branch `ai-agent/{ticketKey}` already
  // exists) rather than a fresh ticket. Changes clone/branch behavior in
  // run-agent-pipeline.use-case.ts (sync onto the existing branch instead of
  // creating a new one off baseBranch) and gates the run on
  // orchestration-state.json's retry counter before any agent runs.
  isRetry?: boolean;
  retryContext?: RetryContext;
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
