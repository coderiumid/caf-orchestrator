import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';
import { requireSessionOr401 } from '../auth/dashboard-session.js';
import { getDb } from '../../../infrastructure/db/connection.js';
import {
  PipelineRunRepository,
  type PipelineRun,
  type AgentEvent,
} from '../../../infrastructure/db/pipeline-run.repository.js';
import { toApiShape } from '../../../infrastructure/db/pipeline-run-shape.js';
import { normalizeRun, eventsAfter, parseCursor } from '../agent-floor/event-normalizer.js';

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

type RunDetail = { run: PipelineRun; events: AgentEvent[] };

function detailBody(detail: RunDetail) {
  return { ...toApiShape(detail.run, detail.events), events: detail.events };
}

// CAF-DASHBOARD-02 T3: the Agent Floor's event feed — the run's rows passed
// through the normalizer (requirements.md section 7 contract events). Read
// only. `after` is the `cursor` of the last event the caller already
// handled; the SSE stream stays a bare "something changed" nudge and the
// page answers it by asking here for whatever is new, so a dropped and
// re-established connection can't deliver an event twice. Live and replay
// both read this same endpoint (replay simply starts with no `after`).
function floorEventsBody(detail: RunDetail, after: string | undefined) {
  const all = normalizeRun(detail.run, detail.events, {
    retryLimits: { qa: config.agents?.qa?.maxRetries ?? null, reviewer: config.agents?.reviewer?.maxRetries ?? null },
  });
  return {
    run: { branch: `ai-agent/${detail.run.ticketId}`, ...toApiShape(detail.run, detail.events) },
    events: eventsAfter(all, after),
    // Position of the newest event that exists, whether or not it is in
    // this response — what to send as `after` next time.
    nextCursor: all[all.length - 1]?.cursor ?? after ?? null,
  };
}

export async function pipelinesRoutes(app: FastifyInstance): Promise<void> {
  if (!config.dashboard.enabled) {
    return;
  }

  app.addHook('onRequest', requireSessionOr401);

  // Runs of every kind, newest first. `kind=pipeline|pr-review` narrows it;
  // any other value is ignored rather than rejected.
  app.get('/api/pipelines', async (request) => {
    const { repoId, kind } = request.query as { repoId?: string; kind?: string };
    const repo = new PipelineRunRepository(getDb());
    const kindFilter = kind === 'pipeline' || kind === 'pr-review' ? kind : undefined;
    return repo.getPipelineRuns(repoId, {}, kindFilter).map((run) => toApiShape(run, repo.getEventsForRun(run.id)));
  });

  // CAF-DASHBOARD-03: any run by its `runId`. The only way to reach a
  // PR-review run — repoId+ticketId below always resolves to the ticket's
  // pipeline run. Callers must percent-encode the id (it contains ":" and,
  // for a pipeline run, "/"). "by-run" is a static segment, so it can't be
  // mistaken for a :repoId (which is always "owner/repo").
  app.get('/api/pipelines/by-run/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const detail = new PipelineRunRepository(getDb()).getRunById(runId);
    if (!detail) {
      return reply.code(404).send({ error: `No run found for ${runId}` });
    }
    return detailBody(detail);
  });

  app.get('/api/pipelines/by-run/:runId/floor-events', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const { after } = request.query as { after?: string };
    if (after !== undefined && parseCursor(after) === undefined) {
      return reply.code(400).send({ error: 'Invalid "after" cursor' });
    }
    const detail = new PipelineRunRepository(getDb()).getRunById(runId);
    if (!detail) {
      return reply.code(404).send({ error: `No run found for ${runId}` });
    }
    return floorEventsBody(detail, after);
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
    return detailBody(detail);
  });

  app.get('/api/pipelines/:repoId/:ticketId/floor-events', async (request, reply) => {
    const { repoId, ticketId } = request.params as { repoId: string; ticketId: string };
    const { after } = request.query as { after?: string };
    if (after !== undefined && parseCursor(after) === undefined) {
      return reply.code(400).send({ error: 'Invalid "after" cursor' });
    }

    const repo = new PipelineRunRepository(getDb());
    const detail = repo.getPipelineDetail(repoId, ticketId);
    if (!detail) {
      return reply.code(404).send({ error: `No pipeline run found for ${repoId}/${ticketId}` });
    }
    return floorEventsBody(detail, after);
  });
}
