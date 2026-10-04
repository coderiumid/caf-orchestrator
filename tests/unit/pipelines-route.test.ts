import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dbPath: string;
let configMock: {
  dashboard: { enabled: boolean; basicAuthUser: string };
  DASHBOARD_BASIC_AUTH_PASSWORD: string;
  db: { path: string };
};

vi.mock('../../src/config/index.js', () => ({
  get config() {
    return configMock;
  },
}));

const AUTH_HEADER = `Basic ${Buffer.from('admin:correct-horse').toString('base64')}`;

describe('GET /api/pipelines*', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = mkdtempSync(join(tmpdir(), 'caf-dashboard-01-pipelines-route-'));
    dbPath = join(tmpDir, 'test.sqlite');
    configMock = {
      dashboard: { enabled: true, basicAuthUser: 'admin' },
      DASHBOARD_BASIC_AUTH_PASSWORD: 'correct-horse',
      db: { path: dbPath },
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function buildTestApp() {
    const Fastify = (await import('fastify')).default;
    const { pipelinesRoutes } = await import('../../src/presentation/web/routes/pipelines.js');
    const app = Fastify();
    await app.register(pipelinesRoutes);
    return app;
  }

  async function seed() {
    const { openDb } = await import('../../src/infrastructure/db/connection.js');
    const { PipelineRunRepository } = await import('../../src/infrastructure/db/pipeline-run.repository.js');
    const db = openDb(dbPath);
    const repo = new PipelineRunRepository(db);

    repo.upsertPipelineRun({
      id: 'ganjardbc/umkm-pos:CAF-1',
      repoId: 'ganjardbc/umkm-pos',
      ticketId: 'CAF-1',
      ticketTitle: 'Running ticket',
      startedAt: '2026-09-07T00:00:00.000Z',
    });
    repo.insertEvent({
      pipelineRunId: 'ganjardbc/umkm-pos:CAF-1',
      agentName: 'caf-planner',
      pivPhase: 'plan',
      eventType: 'start',
      createdAt: '2026-09-07T00:00:01.000Z',
    });

    repo.upsertPipelineRun({
      id: 'ganjardbc/umkm-pos:CAF-2',
      repoId: 'ganjardbc/umkm-pos',
      ticketId: 'CAF-2',
      ticketTitle: 'Finished ticket',
      startedAt: '2026-09-06T00:00:00.000Z',
      endedAt: '2026-09-06T01:00:00.000Z',
      finalStatus: 'SUCCESS',
    });

    repo.upsertPipelineRun({
      id: 'ganjardbc/other-repo:CAF-9',
      repoId: 'ganjardbc/other-repo',
      ticketId: 'CAF-9',
      ticketTitle: 'Other repo ticket',
      startedAt: '2026-09-05T00:00:00.000Z',
    });

    db.close();
  }

  it('rejects requests with no auth header (401)', async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/pipelines' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('returns pipeline runs with the same field shape for a live (running) and a finished row', async () => {
    await seed();
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/pipelines?repoId=ganjardbc%2Fumkm-pos',
      headers: { authorization: AUTH_HEADER },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);

    const running = body.find((r) => r.ticketId === 'CAF-1');
    const finished = body.find((r) => r.ticketId === 'CAF-2');

    // Same keys on both, regardless of whether the row is still running or done.
    expect(Object.keys(running!).sort()).toEqual(Object.keys(finished!).sort());
    expect(running).toMatchObject({ finalStatus: null, status: 'RUNNING', endedAt: null });
    expect(finished).toMatchObject({ finalStatus: 'SUCCESS', status: 'SUCCESS' });

    await app.close();
  });

  it('filters by repoId query param', async () => {
    await seed();
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/pipelines?repoId=ganjardbc%2Fother-repo',
      headers: { authorization: AUTH_HEADER },
    });
    const body = response.json() as Array<Record<string, unknown>>;
    expect(body.map((r) => r.ticketId)).toEqual(['CAF-9']);

    await app.close();
  });

  it('returns full detail with events for GET /api/pipelines/:repoId/:ticketId', async () => {
    await seed();
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/pipelines/ganjardbc%2Fumkm-pos/CAF-1',
      headers: { authorization: AUTH_HEADER },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ repoId: 'ganjardbc/umkm-pos', ticketId: 'CAF-1', status: 'RUNNING' });
    expect(body.events).toHaveLength(1);
    expect((body.events as Array<Record<string, unknown>>)[0]).toMatchObject({
      agentName: 'caf-planner',
      pivPhase: 'plan',
      eventType: 'start',
    });

    await app.close();
  });

  it('summarizes currentPivPhase, retryCounts, totalCostUsd, and lastArtifactLink from agent_events', async () => {
    const { openDb } = await import('../../src/infrastructure/db/connection.js');
    const { PipelineRunRepository } = await import('../../src/infrastructure/db/pipeline-run.repository.js');
    const db = openDb(dbPath);
    const repo = new PipelineRunRepository(db);

    repo.upsertPipelineRun({
      id: 'ganjardbc/umkm-pos:CAF-5',
      repoId: 'ganjardbc/umkm-pos',
      ticketId: 'CAF-5',
      ticketTitle: 'Summary ticket',
      startedAt: '2026-09-07T00:00:00.000Z',
    });
    repo.insertEvent({
      pipelineRunId: 'ganjardbc/umkm-pos:CAF-5',
      agentName: 'caf-backend',
      pivPhase: 'implement',
      eventType: 'end',
      costUsd: 0.01,
      createdAt: '2026-09-07T00:00:01.000Z',
    });
    repo.insertEvent({
      pipelineRunId: 'ganjardbc/umkm-pos:CAF-5',
      agentName: 'caf-qa',
      pivPhase: 'verify',
      eventType: 'retry',
      retryCount: 1,
      createdAt: '2026-09-07T00:00:02.000Z',
    });
    repo.insertEvent({
      pipelineRunId: 'ganjardbc/umkm-pos:CAF-5',
      agentName: 'caf-qa',
      pivPhase: 'verify',
      eventType: 'end',
      costUsd: 0.02,
      createdAt: '2026-09-07T00:00:03.000Z',
    });
    repo.insertEvent({
      pipelineRunId: 'ganjardbc/umkm-pos:CAF-5',
      agentName: 'caf-qa',
      pivPhase: 'verify',
      eventType: 'gate_exhausted',
      artifactLink: '.caf/tasks/CAF-5/qa-report.md',
      createdAt: '2026-09-07T00:00:04.000Z',
    });
    db.close();

    const app = await buildTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/pipelines/ganjardbc%2Fumkm-pos/CAF-5',
      headers: { authorization: AUTH_HEADER },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      currentPivPhase: 'verify',
      retryCounts: { 'caf-qa': 1 },
      totalCostUsd: 0.03,
      lastArtifactLink: '.caf/tasks/CAF-5/qa-report.md',
    });

    await app.close();
  });

  it('reports totalCostUsd as null (not 0) when no event has cost data yet', async () => {
    await seed();
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/pipelines/ganjardbc%2Fumkm-pos/CAF-1',
      headers: { authorization: AUTH_HEADER },
    });
    const body = response.json() as Record<string, unknown>;
    expect(body.totalCostUsd).toBeNull();

    await app.close();
  });

  it('returns 404 for an unknown repoId/ticketId pair', async () => {
    await seed();
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/pipelines/ganjardbc%2Fumkm-pos/CAF-DOES-NOT-EXIST',
      headers: { authorization: AUTH_HEADER },
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });
  // CAF-DASHBOARD-03 T3: PR review runs alongside pipeline runs.
  describe('PR review runs', () => {
    const REVIEW_A = 'pr-review:github-a';
    const REVIEW_B = 'pr-review:github-b';

    /** CAF-2 (finished pipeline run from seed()) gets two review runs: an initial review and a fix review. */
    async function seedReviews() {
      await seed();
      const { openDb } = await import('../../src/infrastructure/db/connection.js');
      const { PipelineRunRepository } = await import('../../src/infrastructure/db/pipeline-run.repository.js');
      const db = openDb(dbPath);
      const repo = new PipelineRunRepository(db);
      const common = { repoId: 'ganjardbc/umkm-pos', ticketId: 'CAF-2', ticketTitle: 'Finished ticket', kind: 'pr-review' as const, prNumber: 14 };

      repo.upsertPipelineRun({ id: REVIEW_A, ...common, reviewMode: 'initial', startedAt: '2026-09-08T00:00:00.000Z' });
      repo.insertEvent({ pipelineRunId: REVIEW_A, agentName: 'caf-reviewer', pivPhase: 'verify', eventType: 'start', createdAt: '2026-09-08T00:00:01.000Z' });
      repo.insertEvent({
        pipelineRunId: REVIEW_A,
        agentName: 'caf-reviewer',
        pivPhase: 'verify',
        eventType: 'end',
        costUsd: 0.5,
        exitCode: 0,
        outcome: 'OK',
        createdAt: '2026-09-08T00:05:00.000Z',
      });
      repo.setReviewResult(REVIEW_A, { type: 'verdict', verdict: 'CHANGES_REQUESTED', postedAsComment: false });
      repo.finalizePipelineRun(REVIEW_A, '2026-09-08T00:05:01.000Z', 'SUCCESS');

      repo.upsertPipelineRun({ id: REVIEW_B, ...common, reviewMode: 'global', startedAt: '2026-09-09T00:00:00.000Z' });
      repo.insertEvent({ pipelineRunId: REVIEW_B, agentName: 'caf-reviewer', pivPhase: 'verify', eventType: 'start', createdAt: '2026-09-09T00:00:01.000Z' });
      db.close();
    }

    const get = async (url: string, headers: Record<string, string> = { authorization: AUTH_HEADER }) => {
      const app = await buildTestApp();
      const response = await app.inject({ method: 'GET', url, headers });
      await app.close();
      return response;
    };

    it('lists every kind together, newest first, with kind / mode / result on each row', async () => {
      await seedReviews();
      const body = (await get('/api/pipelines?repoId=ganjardbc%2Fumkm-pos')).json() as Array<Record<string, unknown>>;

      expect(body.map((r) => r.runId)).toEqual([REVIEW_B, REVIEW_A, 'ganjardbc/umkm-pos:CAF-1', 'ganjardbc/umkm-pos:CAF-2']);
      expect(body[0]).toMatchObject({ kind: 'pr-review', reviewMode: 'global', reviewResult: null, status: 'RUNNING', prNumber: 14, ticketId: 'CAF-2' });
      expect(body[1]).toMatchObject({
        kind: 'pr-review',
        reviewMode: 'initial',
        reviewResult: { type: 'verdict', verdict: 'CHANGES_REQUESTED', postedAsComment: false },
        status: 'SUCCESS',
        totalCostUsd: 0.5,
      });
      expect(body[2]).toMatchObject({ kind: 'pipeline', reviewMode: null, reviewResult: null });
      // Same keys whatever the kind.
      expect(Object.keys(body[0]).sort()).toEqual(Object.keys(body[2]).sort());
    });

    it('filters by kind, and ignores a kind it does not know', async () => {
      await seedReviews();
      const ids = async (query: string) =>
        ((await get(`/api/pipelines${query}`)).json() as Array<{ runId: string }>).map((r) => r.runId);

      expect(await ids('?kind=pr-review')).toEqual([REVIEW_B, REVIEW_A]);
      expect(await ids('?kind=pipeline')).toEqual(['ganjardbc/umkm-pos:CAF-1', 'ganjardbc/umkm-pos:CAF-2', 'ganjardbc/other-repo:CAF-9']);
      expect(await ids('?kind=pr-review&repoId=ganjardbc%2Fother-repo')).toEqual([]);
      expect(await ids('?kind=bogus')).toHaveLength(5);
    });

    it('repo + ticket still resolves to the pipeline run, untouched by its reviews', async () => {
      await seedReviews();
      const body = (await get('/api/pipelines/ganjardbc%2Fumkm-pos/CAF-2')).json() as Record<string, unknown>;
      expect(body).toMatchObject({ runId: 'ganjardbc/umkm-pos:CAF-2', kind: 'pipeline', status: 'SUCCESS', endedAt: '2026-09-06T01:00:00.000Z', attempt: 1 });
      expect(body.events).toEqual([]);
    });

    it('GET /api/pipelines/by-run/:runId returns one specific review run with its events', async () => {
      await seedReviews();
      const response = await get(`/api/pipelines/by-run/${encodeURIComponent(REVIEW_A)}`);
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ runId: REVIEW_A, kind: 'pr-review', reviewMode: 'initial', status: 'SUCCESS' });
      expect((body.events as Array<{ eventType: string }>).map((e) => e.eventType)).toEqual(['start', 'end']);
    });

    it('by-run also serves a pipeline run (its id contains a slash and a colon)', async () => {
      await seedReviews();
      const response = await get(`/api/pipelines/by-run/${encodeURIComponent('ganjardbc/umkm-pos:CAF-1')}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ runId: 'ganjardbc/umkm-pos:CAF-1', kind: 'pipeline', ticketId: 'CAF-1' });
    });

    it('by-run floor-events: review contract events, cursor paging, bad cursor rejected', async () => {
      await seedReviews();
      const url = `/api/pipelines/by-run/${encodeURIComponent(REVIEW_A)}/floor-events`;
      const first = (await get(url)).json() as { run: Record<string, unknown>; events: Array<Record<string, unknown>>; nextCursor: string };

      expect(first.run).toMatchObject({ runId: REVIEW_A, kind: 'pr-review', branch: 'ai-agent/CAF-2' });
      expect(first.events[0]).toMatchObject({ type: 'run_started', kind: 'pr-review', reviewMode: 'initial', prNumber: 14 });
      expect(first.events.at(-1)).toMatchObject({
        type: 'run_finished',
        finalStatus: 'SUCCESS',
        review: { mode: 'initial', result: { verdict: 'CHANGES_REQUESTED' } },
      });
      expect(first.events.some((e) => e.type === 'agent_state' && e.state === 'reviewing')).toBe(true);

      const again = (await get(`${url}?after=${encodeURIComponent(first.nextCursor)}`)).json() as { events: unknown[]; nextCursor: string };
      expect(again.events).toEqual([]);
      expect(again.nextCursor).toBe(first.nextCursor);

      expect((await get(`${url}?after=nope`)).statusCode).toBe(400);
    });

    it('by-run: 404 for an unknown run, 401 without auth', async () => {
      await seedReviews();
      expect((await get('/api/pipelines/by-run/pr-review%3Amissing')).statusCode).toBe(404);
      expect((await get('/api/pipelines/by-run/pr-review%3Amissing/floor-events')).statusCode).toBe(404);
      expect((await get(`/api/pipelines/by-run/${encodeURIComponent(REVIEW_A)}`, {})).statusCode).toBe(401);
      expect((await get(`/api/pipelines/by-run/${encodeURIComponent(REVIEW_A)}/floor-events`, {})).statusCode).toBe(401);
    });
  });
});
