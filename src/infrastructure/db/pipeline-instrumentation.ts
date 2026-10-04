import { getDb } from './connection.js';
import {
  PipelineRunRepository,
  type PivPhase,
  type AgentEventType,
  type AgentOutcome,
} from './pipeline-run.repository.js';
import type { VerifyDetails } from '../reports/verify-report-details.js';
import { parseAgentUsage } from '../agent/agent-cost-parser.js';
import { logger } from '../logging/logger.js';
import { parseGithubRepo } from '../vcs/github.service.js';
import { publishDashboardEvent } from '../queue/dashboard-events.js';

/**
 * CAF-DASHBOARD-01 Task 3: write-side of the dashboard's history store, called
 * from the exact points in run-agent-pipeline.use-case.ts that already update
 * orchestration-state.json (or, for per-agent start/end, the existing spawn
 * call sites). Every export here is a safe wrapper — it never throws; a DB
 * failure is logged as a warning and swallowed, per the AC that instrumentation
 * must never take down the main pipeline.
 */

function repository(): PipelineRunRepository {
  return new PipelineRunRepository(getDb());
}

export function pipelineRunId(repoId: string, ticketId: string): string {
  return `${repoId}:${ticketId}`;
}

/** owner/repo derived from the same repoCloneUrl the pipeline already clones from. */
export function repoIdFromCloneUrl(repoCloneUrl: string): string {
  const { owner, repo } = parseGithubRepo(repoCloneUrl);
  return `${owner}/${repo}`;
}

const AGENT_PIV_PHASE: Record<string, PivPhase> = {
  'caf-planner': 'plan',
  'caf-frontend': 'implement',
  'caf-backend': 'implement',
  'caf-qa': 'verify',
  'caf-reviewer': 'verify',
};

/** PIV phase for a known agent name, or undefined for one this dashboard doesn't track (e.g. caf-documentation — excluded per Task 2/3 scope). */
export function pivPhaseForAgent(agentName: string): PivPhase | undefined {
  return AGENT_PIV_PHASE[agentName];
}

function warnOnFailure(action: string, context: Record<string, unknown>, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.warn(`Pipeline-history DB write failed (${action}) — instrumentation only, pipeline continues`, undefined, {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Nudges the dashboard to refetch immediately instead of waiting for the
 * next orchestration-state.json fs event (gate failure/reset only) or a
 * manual page reload — every DB write below is a real progress change
 * (agent start/end, pipeline start/finalize). This runs inside the BullMQ
 * worker process, not the web server, so it can't call eventBroadcaster
 * directly (separate process, separate memory) — publishDashboardEvent
 * relays it over Redis to whichever process actually holds the SSE clients.
 */
function broadcastChange(repoId: string, ticketId: string): void {
  publishDashboardEvent({ repoId, ticketId, eventType: 'change', timestamp: new Date().toISOString() });
}

/** Creates or resets the pipeline_runs row for a new attempt (fresh run or a retry/resume). Clears ended_at/final_status on every call — a new attempt hasn't concluded yet. */
export function recordPipelineStarted(repoId: string, ticketId: string, ticketTitle: string): void {
  warnOnFailure('recordPipelineStarted', { repoId, ticketId }, () => {
    repository().upsertPipelineRun({
      id: pipelineRunId(repoId, ticketId),
      repoId,
      ticketId,
      ticketTitle,
      startedAt: new Date().toISOString(),
    });
  });
  broadcastChange(repoId, ticketId);
}

export function finalizePipelineRun(repoId: string, ticketId: string, finalStatus: string): void {
  warnOnFailure('finalizePipelineRun', { repoId, ticketId, finalStatus }, () => {
    repository().finalizePipelineRun(pipelineRunId(repoId, ticketId), new Date().toISOString(), finalStatus);
  });
  broadcastChange(repoId, ticketId);
}

/** Records the PR opened (or reused) for a run — the final PR on success, or the Draft PR on a gate stop (CAF-DASHBOARD-02 T1). */
export function recordPullRequest(repoId: string, ticketId: string, prNumber: number): void {
  warnOnFailure('recordPullRequest', { repoId, ticketId, prNumber }, () => {
    repository().setPullRequestNumber(pipelineRunId(repoId, ticketId), prNumber);
  });
  broadcastChange(repoId, ticketId);
}

export interface RecordAgentEventOptions {
  retryCount?: number;
  costUsd?: number;
  artifactLink?: string;
  exitCode?: number | null;
  outcome?: AgentOutcome;
  verifyDetails?: VerifyDetails | null;
}

export function recordAgentEvent(
  repoId: string,
  ticketId: string,
  agentName: string,
  pivPhase: PivPhase,
  eventType: AgentEventType,
  options: RecordAgentEventOptions = {},
): void {
  warnOnFailure('recordAgentEvent', { repoId, ticketId, agentName, eventType }, () => {
    repository().insertEvent({
      pipelineRunId: pipelineRunId(repoId, ticketId),
      agentName,
      pivPhase,
      eventType,
      retryCount: options.retryCount ?? null,
      costUsd: options.costUsd ?? null,
      artifactLink: options.artifactLink ?? null,
      createdAt: new Date().toISOString(),
      exitCode: options.exitCode ?? null,
      outcome: options.outcome ?? null,
      verifyDetails: options.verifyDetails ?? null,
    });
  });
  broadcastChange(repoId, ticketId);
}

/** The subset of AgentRunResult the "end" event records. */
export interface AgentRunOutcomeInput {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
}

/** How the agent process ended. A timeout is reported as such even though it also surfaces as a kill signal. */
export function outcomeOf(result: Pick<AgentRunOutcomeInput, 'exitCode' | 'signal' | 'timedOut'>): AgentOutcome {
  if (result.timedOut) return 'TIMEOUT';
  if (result.signal) return 'KILLED';
  return result.exitCode === 0 ? 'OK' : 'FAILED';
}

/**
 * Convenience for the "end" event of an agent run — extracts cost/usage from
 * stdout via parseAgentUsage (Task 2) and the process outcome from the run
 * result, so call sites don't have to. `verifyDetails` is only meaningful for
 * implementation agents (see verify-report-details.ts).
 */
export function recordAgentEnd(
  repoId: string,
  ticketId: string,
  agentName: string,
  pivPhase: PivPhase,
  result: AgentRunOutcomeInput,
  verifyDetails?: VerifyDetails | null,
): void {
  const usage = parseAgentUsage(result.stdout);
  recordAgentEvent(repoId, ticketId, agentName, pivPhase, 'end', {
    costUsd: usage?.costUsd,
    exitCode: result.exitCode,
    outcome: outcomeOf(result),
    verifyDetails,
  });
}
