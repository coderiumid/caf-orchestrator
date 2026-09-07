import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';
import { registerDashboardBasicAuth } from '../auth/dashboard-basic-auth.js';
import { getDb } from '../../../infrastructure/db/connection.js';
import {
  PipelineRunRepository,
  type PipelineRun,
  type AgentEvent,
  type PivPhase,
} from '../../../infrastructure/db/pipeline-run.repository.js';

/**
 * CAF-DASHBOARD-01 Task 5: REST read API over the pipeline-history store.
 * "Live" and "history" are the SAME query against pipeline_runs — a running
 * pipeline is just a row with `final_status IS NULL` (written by
 * `recordPipelineStarted`/`finalizePipelineRun`, Task 3) — so the response
 * shape is identical regardless of whether the row represents a live or a
 * finished run; there's no separate merge step or second data source (see
 * verify-report.md's Task 5 note: orchestration-state.json was ruled out as
 * the live-status source here because it doesn't survive an ephemeral
 * workspace's cleanup, so it can't be read reliably at REST-query time).
 *
 * Task 6 (frontend table) needs current PIV phase / retry-per-gate / running
 * cost / last artifact link — none of which live on pipeline_runs itself,
 * only derivable from a run's agent_events. Computed here (not stored) since
 * it's cheap at this scale and keeps agent_events as the single source of
 * truth instead of a second denormalized copy on pipeline_runs.
 */

interface PipelineRunApiShape {
  repoId: string;
  ticketId: string;
  ticketTitle: string;
  startedAt: string;
  endedAt: string | null;
  finalStatus: string | null;
  /** Convenience: `finalStatus` verbatim, or 'RUNNING' while it's still null. */
  status: string;
  /** PIV phase of the most recent agent_events row, or null if none yet. */
  currentPivPhase: PivPhase | null;
  /** Per-agent retry count, from 'retry' events (only caf-qa/caf-reviewer produce these — see run-agent-pipeline.use-case.ts). */
  retryCounts: Record<string, number>;
  /** Sum of costUsd across every event that has one, or null if no cost data has landed yet (never 0, to keep "no data" distinguishable from "genuinely free"). */
  totalCostUsd: number | null;
  /** artifactLink of the most recent event that has one (typically a gate_exhausted event), or null. */
  lastArtifactLink: string | null;
}

function summarizeEvents(events: AgentEvent[]) {
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

function toApiShape(run: PipelineRun, events: AgentEvent[]): PipelineRunApiShape {
  return {
    repoId: run.repoId,
    ticketId: run.ticketId,
    ticketTitle: run.ticketTitle,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    finalStatus: run.finalStatus,
    status: run.finalStatus ?? 'RUNNING',
    ...summarizeEvents(events),
  };
}

export async function pipelinesRoutes(app: FastifyInstance): Promise<void> {
  if (!config.dashboard.enabled) {
    return;
  }

  await registerDashboardBasicAuth(app);
  app.addHook('onRequest', app.basicAuth);

  app.get('/api/pipelines', async (request) => {
    const { repoId } = request.query as { repoId?: string };
    const repo = new PipelineRunRepository(getDb());
    return repo.getPipelineRuns(repoId).map((run) => toApiShape(run, repo.getEventsForRun(run.id)));
  });

  // repoId is "owner/repo" (see pipeline-instrumentation.ts's repoIdFromCloneUrl)
  // — callers must percent-encode the "/" (e.g. "ganjardbc%2Fumkm-pos") so it
  // survives as a single path segment; Fastify decodes it back before this
  // handler sees it.
  app.get('/api/pipelines/:repoId/:ticketId', async (request, reply) => {
    const { repoId, ticketId } = request.params as { repoId: string; ticketId: string };
    const repo = new PipelineRunRepository(getDb());
    const detail = repo.getPipelineDetail(repoId, ticketId);
    if (!detail) {
      return reply.code(404).send({ error: `No pipeline run found for ${repoId}/${ticketId}` });
    }
    return { ...toApiShape(detail.run, detail.events), events: detail.events };
  });
}
