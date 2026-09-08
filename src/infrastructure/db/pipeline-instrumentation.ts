import { getDb } from './connection.js';
import { PipelineRunRepository, type PivPhase, type AgentEventType } from './pipeline-run.repository.js';
import { parseAgentUsage } from '../agent/agent-cost-parser.js';
import { logger } from '../logging/logger.js';
import { parseGithubRepo } from '../vcs/github.service.js';
import { eventBroadcaster } from '../../presentation/web/sse/event-broadcaster.js';

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
 * Pushes an SSE nudge so the dashboard refetches immediately instead of
 * waiting for the next orchestration-state.json fs event (gate
 * failure/reset only) or a manual page reload — every DB write below is a
 * real progress change (agent start/end, pipeline start/finalize) the
 * dashboard should reflect live.
 */
function broadcastChange(repoId: string, ticketId: string): void {
  eventBroadcaster.broadcast({ repoId, ticketId, eventType: 'change', timestamp: new Date().toISOString() });
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

export interface RecordAgentEventOptions {
  retryCount?: number;
  costUsd?: number;
  artifactLink?: string;
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
    });
  });
  broadcastChange(repoId, ticketId);
}

/** Convenience for the "end" event of an agent run — extracts cost/usage from stdout via parseAgentUsage (Task 2) so call sites don't have to. */
export function recordAgentEnd(
  repoId: string,
  ticketId: string,
  agentName: string,
  pivPhase: PivPhase,
  stdout: string,
): void {
  const usage = parseAgentUsage(stdout);
  recordAgentEvent(repoId, ticketId, agentName, pivPhase, 'end', { costUsd: usage?.costUsd });
}
