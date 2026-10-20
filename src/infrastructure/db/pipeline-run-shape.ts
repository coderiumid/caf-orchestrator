import type {
  PipelineRun,
  AgentEvent,
  PivPhase,
  RunKind,
  ReviewMode,
  ReviewResult,
  WaitingFor,
  AcCounts,
} from './pipeline-run.repository.js';

/**
 * Pure projection of a pipeline_runs row + its agent_events into the shape the
 * dashboard REST API returns. Lives outside routes/pipelines.ts (which imports
 * `config`) so the TUI can reuse it without needing the full env.
 */

export interface PipelineRunApiShape {
  /** pipeline_runs.id — the only key that identifies a PR-review run, since one ticket can have several (CAF-DASHBOARD-03). */
  runId: string;
  /** 'pipeline' for a ticket pipeline run, 'pr-review' for a PR review / fix-review job. */
  kind: RunKind;
  /** PR-review runs only: 'initial' (full review) or 'global'/'scoped' (fix review). */
  reviewMode: ReviewMode | null;
  /** PR-review runs only, once the job finished normally: the verdict, or FIXED/SKIPPED/NOT_APPLICABLE counts. */
  reviewResult: ReviewResult | null;
  /** Ticket pipeline runs only: set while the run is parked on Clarify / spec approval (CAF-SDD-04h). */
  waitingFor: WaitingFor | null;
  /** Validator AC counts (pass/fail/unverified) once the validation gate ran, else null (CAF-SDD-04h). */
  acSummary: AcCounts | null;
  repoId: string;
  ticketId: string;
  ticketTitle: string;
  startedAt: string;
  endedAt: string | null;
  finalStatus: string | null;
  /** Convenience: `finalStatus` verbatim, or 'RUNNING' while it's still null. */
  status: string;
  /** How many times this run has been started (BullMQ retry / resume). Null for runs recorded before CAF-DASHBOARD-02. */
  attempt: number | null;
  /** The PR (or Draft PR) opened for this run, once known. */
  prNumber: number | null;
  /** PIV phase of the most recent agent_events row, or null if none yet. */
  currentPivPhase: PivPhase | null;
  /** Per-agent retry count, from 'retry' events (only caf-qa/caf-reviewer produce these — see run-agent-pipeline.use-case.ts). */
  retryCounts: Record<string, number>;
  /** Sum of costUsd across every event that has one, or null if no cost data has landed yet (never 0, to keep "no data" distinguishable from "genuinely free"). */
  totalCostUsd: number | null;
  /** artifactLink of the most recent event that has one (typically a gate_exhausted event), or null. */
  lastArtifactLink: string | null;
}

export function summarizeEvents(events: AgentEvent[]) {
  const currentPivPhase = events.length > 0 ? events[events.length - 1].pivPhase : null;

  // Each 'retry' event carries the retry loop's own running counter (1, 2, ...
  // — see the QA/reviewer retry loops in run-agent-pipeline.use-case.ts), so
  // the latest (max) value per agent is the count, not the number of rows.
  const retryCounts: Record<string, number> = {};
  for (const event of events) {
    if (event.eventType !== 'retry' || event.retryCount === null) continue;
    retryCounts[event.agentName] = Math.max(retryCounts[event.agentName] ?? 0, event.retryCount);
  }

  const costs = events.map((e) => e.costUsd).filter((c): c is number => c !== null);
  const totalCostUsd = costs.length > 0 ? costs.reduce((sum, c) => sum + c, 0) : null;

  const lastArtifactLink = [...events].reverse().find((e) => e.artifactLink !== null)?.artifactLink ?? null;

  return { currentPivPhase, retryCounts, totalCostUsd, lastArtifactLink };
}

export function toApiShape(run: PipelineRun, events: AgentEvent[]): PipelineRunApiShape {
  return {
    runId: run.id,
    kind: run.kind,
    reviewMode: run.reviewMode,
    reviewResult: run.reviewResult,
    waitingFor: run.waitingFor,
    acSummary: run.acSummary,
    repoId: run.repoId,
    ticketId: run.ticketId,
    ticketTitle: run.ticketTitle,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    finalStatus: run.finalStatus,
    status: run.finalStatus ?? 'RUNNING',
    attempt: run.attempt,
    prNumber: run.prNumber,
    ...summarizeEvents(events),
  };
}
