import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FloorEvent } from '../../src/presentation/web/agent-floor/event-normalizer.js';

// CAF-DASHBOARD-02 T3: GET /api/pipelines/:repoId/:ticketId/floor-events —
// contract events in order, a cursor that makes re-asking after a dropped
// connection safe, the same Basic Auth as the rest of /api/pipelines, one
// run (repo + ticket) per request, and no writes.

let dbPath: string;
let configMock: {
  dashboard: { enabled: boolean; basicAuthUser: string };
  DASHBOARD_BASIC_AUTH_PASSWORD: string;
  db: { path: string };
  agents?: { qa: { maxRetries: number }; reviewer: { maxRetries: number } };
};

vi.mock('../../src/config/index.js', () => ({
  get config() {
    return configMock;
  },
}));

const AUTH = { authorization: `Basic ${Buffer.from('admin:correct-horse').toString('base64')}` };
const UMKM = 'ganjardbc/umkm-pos';
const CODERIUM = 'ganjardbc/coderium-web-v2';
const url = (repoId: string, ticketId: string, after?: string): string =>
  `/api/pipelines/${encodeURIComponent(repoId)}/${ticketId}/floor-events${after === undefined ? '' : `?after=${after}`}`;

interface FloorResponse {
  run: { runId: string; repoId: string; ticketId: string; branch: string; status: string; attempt: number | null; prNumber: number | null };
  events: FloorEvent[];
  nextCursor: string | null;
}

describe('GET /api/pipelines/:repoId/:ticketId/floor-events', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = mkdtempSync(join(tmpdir(), 'caf-dashboard-02-floor-events-'));
    dbPath = join(tmpDir, 'test.sqlite');
    configMock = {
      dashboard: { enabled: true, basicAuthUser: 'admin' },
      DASHBOARD_BASIC_AUTH_PASSWORD: 'correct-horse',
      db: { path: dbPath },
      agents: { qa: { maxRetries: 1 }, reviewer: { maxRetries: 1 } },
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

  /** A second handle on the same file — stands in for the worker process writing while the web server reads. */
  async function writer() {
    const { openDb } = await import('../../src/infrastructure/db/connection.js');
    const { PipelineRunRepository } = await import('../../src/infrastructure/db/pipeline-run.repository.js');
    const db = openDb(dbPath);
    const repo = new PipelineRunRepository(db);
    let tick = 0;
    const stamp = (): string => new Date(Date.parse('2026-09-08T09:00:00.000Z') + ++tick * 1000).toISOString();
    return {
      db,
      repo,
      startRun: (repoId: string, ticketId: string) =>
        repo.upsertPipelineRun({ id: `${repoId}:${ticketId}`, repoId, ticketId, ticketTitle: `Ticket ${ticketId}`, startedAt: stamp() }),
      event: (repoId: string, ticketId: string, agentName: string, eventType: 'start' | 'end' | 'retry' | 'gate_exhausted') =>
        repo.insertEvent({
          pipelineRunId: `${repoId}:${ticketId}`,
          agentName,
          pivPhase: agentName === 'caf-planner' ? 'plan' : agentName === 'caf-qa' || agentName === 'caf-reviewer' ? 'verify' : 'implement',
          eventType,
          createdAt: stamp(),
          ...(eventType === 'end' ? { outcome: 'OK' as const, exitCode: 0, costUsd: 0.1 } : {}),
          ...(eventType === 'retry' ? { retryCount: 1 } : {}),
        }),
      finish: (repoId: string, ticketId: string, status: string) => repo.finalizePipelineRun(`${repoId}:${ticketId}`, stamp(), status),
    };
  }

  it('rejects a client with no auth, or wrong credentials (401)', async () => {
    const w = await writer();
    w.startRun(UMKM, 'GAN-1');
    const app = await buildTestApp();

    expect((await app.inject({ method: 'GET', url: url(UMKM, 'GAN-1') })).statusCode).toBe(401);
    const wrong = { authorization: `Basic ${Buffer.from('admin:nope').toString('base64')}` };
    expect((await app.inject({ method: 'GET', url: url(UMKM, 'GAN-1'), headers: wrong })).statusCode).toBe(401);

    await app.close();
    w.db.close();
  });

  it('404s for a run that does not exist, 400s for a cursor it did not issue', async () => {
    const w = await writer();
    w.startRun(UMKM, 'GAN-1');
    const app = await buildTestApp();

    expect((await app.inject({ method: 'GET', url: url(UMKM, 'GAN-404'), headers: AUTH })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: url(UMKM, 'GAN-1', 'not-a-cursor'), headers: AUTH })).statusCode).toBe(400);

    await app.close();
    w.db.close();
  });

  it('returns contract events in order with the run summary, and uses the configured retry limit', async () => {
    const w = await writer();
    w.startRun(UMKM, 'GAN-1');
    for (const [agent, type] of [
      ['caf-planner', 'start'],
      ['caf-planner', 'end'],
      ['caf-backend', 'start'],
      ['caf-backend', 'end'],
      ['caf-qa', 'start'],
      ['caf-qa', 'end'],
      ['caf-qa', 'retry'],
    ] as const) {
      w.event(UMKM, 'GAN-1', agent, type);
    }
    const app = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: url(UMKM, 'GAN-1'), headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = response.json<FloorResponse>();

    expect(body.run).toMatchObject({
      runId: `${UMKM}:GAN-1`,
      repoId: UMKM,
      ticketId: 'GAN-1',
      branch: 'ai-agent/GAN-1',
      status: 'RUNNING',
      attempt: 1,
      prNumber: null,
    });
    expect(body.events[0]).toMatchObject({ type: 'run_started', ticket: 'GAN-1', repo: UMKM });
    expect(body.events.at(-1)).toMatchObject({ type: 'agent_state', agent: 'qa', state: 'retrying', retry: { count: 1, max: 1 } });
    expect(body.nextCursor).toBe(body.events.at(-1)?.cursor);

    const timestamps = body.events.map((e) => Date.parse(e.timestamp));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));

    await app.close();
    w.db.close();
  });

  it('a client that reconnects and re-asks with its cursor never receives an event twice, and misses none', async () => {
    const w = await writer();
    w.startRun(UMKM, 'GAN-1');
    const app = await buildTestApp();

    const received: FloorEvent[] = [];
    let cursor: string | undefined;
    const poll = async (): Promise<number> => {
      const body = (await app.inject({ method: 'GET', url: url(UMKM, 'GAN-1', cursor), headers: AUTH })).json<FloorResponse>();
      received.push(...body.events);
      cursor = body.nextCursor ?? cursor;
      return body.events.length;
    };

    expect(await poll()).toBe(1); // run_started
    expect(await poll()).toBe(0); // "reconnect": nothing new, nothing repeated

    w.event(UMKM, 'GAN-1', 'caf-planner', 'start');
    expect(await poll()).toBeGreaterThan(0);
    expect(await poll()).toBe(0);

    // Several writes land while the client is disconnected.
    w.event(UMKM, 'GAN-1', 'caf-planner', 'end');
    w.event(UMKM, 'GAN-1', 'caf-backend', 'start');
    w.event(UMKM, 'GAN-1', 'caf-backend', 'end');
    await poll();
    expect(await poll()).toBe(0);

    w.finish(UMKM, 'GAN-1', 'SUCCESS');
    await poll();
    w.repo.setPullRequestNumber(`${UMKM}:GAN-1`, 31);
    await poll();
    expect(await poll()).toBe(0);

    // Exactly what a fresh read of the finished run (replay) returns.
    const replay = (await app.inject({ method: 'GET', url: url(UMKM, 'GAN-1'), headers: AUTH })).json<FloorResponse>();
    expect(received).toEqual(replay.events);
    expect(new Set(received.map((e) => e.cursor)).size).toBe(received.length);
    expect(received.at(-1)).toMatchObject({ type: 'step', step: 'pr', prNumber: 31 });

    await app.close();
    w.db.close();
  });

  it('serves one run per request — the same ticket key in two repos never mixes', async () => {
    const w = await writer();
    w.startRun(UMKM, 'GAN-1');
    w.startRun(CODERIUM, 'GAN-1');
    w.event(UMKM, 'GAN-1', 'caf-planner', 'start');
    w.event(CODERIUM, 'GAN-1', 'caf-backend', 'start');
    w.event(UMKM, 'GAN-1', 'caf-planner', 'end');
    const app = await buildTestApp();

    const umkm = (await app.inject({ method: 'GET', url: url(UMKM, 'GAN-1'), headers: AUTH })).json<FloorResponse>();
    const coderium = (await app.inject({ method: 'GET', url: url(CODERIUM, 'GAN-1'), headers: AUTH })).json<FloorResponse>();

    expect(new Set(umkm.events.map((e) => e.runId))).toEqual(new Set([`${UMKM}:GAN-1`]));
    expect(new Set(coderium.events.map((e) => e.runId))).toEqual(new Set([`${CODERIUM}:GAN-1`]));
    expect(umkm.events.some((e) => e.type === 'agent_state' && e.agent === 'backend')).toBe(false);
    expect(coderium.events.some((e) => e.type === 'agent_state' && e.agent === 'planner')).toBe(false);

    await app.close();
    w.db.close();
  });

  it('is read-only: reading the feed leaves both tables exactly as they were', async () => {
    const w = await writer();
    w.startRun(UMKM, 'GAN-1');
    w.event(UMKM, 'GAN-1', 'caf-planner', 'start');
    w.event(UMKM, 'GAN-1', 'caf-planner', 'end');
    w.finish(UMKM, 'GAN-1', 'NEEDS_HUMAN');
    const snapshot = (): string =>
      JSON.stringify([w.db.prepare('SELECT * FROM pipeline_runs').all(), w.db.prepare('SELECT * FROM agent_events').all()]);
    const before = snapshot();
    const app = await buildTestApp();

    const first = (await app.inject({ method: 'GET', url: url(UMKM, 'GAN-1'), headers: AUTH })).json<FloorResponse>();
    await app.inject({ method: 'GET', url: url(UMKM, 'GAN-1', first.nextCursor ?? undefined), headers: AUTH });
    await app.inject({ method: 'GET', url: url(UMKM, 'GAN-404'), headers: AUTH });

    expect(snapshot()).toBe(before);

    await app.close();
    w.db.close();
  });
});
