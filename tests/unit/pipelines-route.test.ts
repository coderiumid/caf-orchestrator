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
});
