import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';
import { registerDashboardBasicAuth } from '../auth/dashboard-basic-auth.js';
import { getDb } from '../../../infrastructure/db/connection.js';
import { PipelineRunRepository, type PipelineRun } from '../../../infrastructure/db/pipeline-run.repository.js';

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
}

function toApiShape(run: PipelineRun): PipelineRunApiShape {
  return {
    repoId: run.repoId,
    ticketId: run.ticketId,
    ticketTitle: run.ticketTitle,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    finalStatus: run.finalStatus,
    status: run.finalStatus ?? 'RUNNING',
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
    return repo.getPipelineRuns(repoId).map(toApiShape);
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
    return { ...toApiShape(detail.run), events: detail.events };
  });
}
