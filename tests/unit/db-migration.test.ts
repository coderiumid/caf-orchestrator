import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, migrate } from '../../src/infrastructure/db/connection.js';
import { PipelineRunRepository } from '../../src/infrastructure/db/pipeline-run.repository.js';

// CAF-DASHBOARD-02 T1: a database created by CAF-DASHBOARD-01 (before the
// attempt/pr_number/exit_code/outcome/verify_details columns existed) must be
// upgraded in place, keeping its rows, by the guarded ALTER TABLE ADD COLUMN.

const LEGACY_SCHEMA = `
CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, ticket_id TEXT NOT NULL, ticket_title TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, final_status TEXT
);
CREATE UNIQUE INDEX idx_pipeline_runs_repo_ticket ON pipeline_runs (repo_id, ticket_id);
CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs (id),
  agent_name TEXT NOT NULL,
  piv_phase TEXT NOT NULL CHECK (piv_phase IN ('plan', 'implement', 'verify')),
  event_type TEXT NOT NULL CHECK (event_type IN ('start', 'end', 'retry', 'gate_exhausted')),
  retry_count INTEGER, cost_usd REAL, artifact_link TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_events_pipeline_run_id ON agent_events (pipeline_run_id);
INSERT INTO pipeline_runs VALUES ('r:GAN-1', 'r', 'GAN-1', 'Old run', '2026-09-08T09:00:00.000Z', '2026-09-08T09:10:00.000Z', 'SUCCESS');
INSERT INTO agent_events (pipeline_run_id, agent_name, piv_phase, event_type, cost_usd, created_at)
  VALUES ('r:GAN-1', 'caf-planner', 'plan', 'end', 0.1, '2026-09-08T09:01:00.000Z');
`;

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

describe('db migration (CAF-DASHBOARD-02 T1 added columns)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caf-dashboard-02-migrate-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('adds the new columns to a pre-existing database and keeps its rows', () => {
    const path = join(dir, 'legacy.sqlite');
    const legacy = new Database(path);
    legacy.exec(LEGACY_SCHEMA);
    legacy.close();

    const db = openDb(path);
    expect(columnsOf(db, 'pipeline_runs')).toEqual(expect.arrayContaining(['attempt', 'pr_number']));
    expect(columnsOf(db, 'agent_events')).toEqual(
      expect.arrayContaining(['attempt', 'exit_code', 'outcome', 'verify_details']),
    );

    const detail = new PipelineRunRepository(db).getPipelineDetail('r', 'GAN-1');
    expect(detail?.run).toMatchObject({ finalStatus: 'SUCCESS', attempt: null, prNumber: null });
    expect(detail?.events).toEqual([
      expect.objectContaining({ agentName: 'caf-planner', costUsd: 0.1, attempt: null, exitCode: null, outcome: null, verifyDetails: null }),
    ]);
    db.close();
  });

  it('treats a legacy run history as attempt 1 when the run is started again', () => {
    const path = join(dir, 'legacy-rerun.sqlite');
    const legacy = new Database(path);
    legacy.exec(LEGACY_SCHEMA);
    legacy.close();

    const db = openDb(path);
    const repo = new PipelineRunRepository(db);
    repo.upsertPipelineRun({ id: 'r:GAN-1', repoId: 'r', ticketId: 'GAN-1', ticketTitle: 'Old run', startedAt: '2026-10-04T00:00:00.000Z' });
    expect(repo.getPipelineDetail('r', 'GAN-1')?.run.attempt).toBe(2);
    db.close();
  });

  it('is idempotent — migrating twice changes nothing and does not throw', () => {
    const db = openDb(':memory:');
    const before = [columnsOf(db, 'pipeline_runs'), columnsOf(db, 'agent_events')];
    expect(() => migrate(db)).not.toThrow();
    expect([columnsOf(db, 'pipeline_runs'), columnsOf(db, 'agent_events')]).toEqual(before);
    db.close();
  });

  it('leaves the event_type / piv_phase CHECK constraints in force', () => {
    const db = openDb(':memory:');
    const repo = new PipelineRunRepository(db);
    repo.upsertPipelineRun({ id: 'x', repoId: 'r', ticketId: 'T-1', ticketTitle: 't', startedAt: '2026-10-04T00:00:00.000Z' });
    expect(() =>
      repo.insertEvent({ pipelineRunId: 'x', agentName: 'a', pivPhase: 'plan', eventType: 'handoff' as never, createdAt: '2026-10-04T00:00:01.000Z' }),
    ).toThrow(/CHECK/);
    db.close();
  });
});

// CAF-DASHBOARD-03 T1: kind/review_mode/review_result columns, and the
// (repo_id, ticket_id) unique index narrowed to pipeline rows.
describe('db migration (CAF-DASHBOARD-03 T1 run kinds)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caf-dashboard-03-migrate-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const indexesOf = (db: Database.Database): string[] =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pipeline_runs'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
  const review = (id: string) => ({
    id,
    repoId: 'r',
    ticketId: 'GAN-1',
    ticketTitle: 'Old run',
    startedAt: '2026-10-04T00:00:00.000Z',
    kind: 'pr-review' as const,
    reviewMode: 'initial' as const,
    prNumber: 5,
  });

  it('upgrades a pre-existing database: columns added, index swapped, rows kept and read as pipeline runs', () => {
    const path = join(dir, 'legacy.sqlite');
    const legacy = new Database(path);
    legacy.exec(LEGACY_SCHEMA);
    legacy.close();

    const db = openDb(path);
    expect(columnsOf(db, 'pipeline_runs')).toEqual(expect.arrayContaining(['kind', 'review_mode', 'review_result']));
    expect(indexesOf(db)).toContain('idx_pipeline_runs_repo_ticket_pipeline');
    expect(indexesOf(db)).not.toContain('idx_pipeline_runs_repo_ticket');
    expect(new PipelineRunRepository(db).getPipelineDetail('r', 'GAN-1')?.run).toMatchObject({
      finalStatus: 'SUCCESS',
      kind: 'pipeline',
      reviewMode: null,
      reviewResult: null,
    });
    db.close();
  });

  it('allows any number of pr-review rows next to the one pipeline row of a ticket', () => {
    const path = join(dir, 'legacy-reviews.sqlite');
    const legacy = new Database(path);
    legacy.exec(LEGACY_SCHEMA);
    legacy.close();

    const db = openDb(path);
    const repo = new PipelineRunRepository(db);
    repo.upsertPipelineRun(review('pr-review:a'));
    repo.upsertPipelineRun(review('pr-review:b'));
    repo.setReviewResult('pr-review:a', { type: 'verdict', verdict: 'APPROVE', postedAsComment: false });

    expect(repo.getPipelineRuns('r', {}, 'pr-review').map((r) => r.id).sort()).toEqual(['pr-review:a', 'pr-review:b']);
    expect(repo.getPipelineRuns('r', {}, 'pipeline').map((r) => r.id)).toEqual(['r:GAN-1']);
    expect(repo.getPipelineRuns('r')).toHaveLength(3);
    // repo + ticket still means the pipeline run, never a review of it.
    expect(repo.getPipelineDetail('r', 'GAN-1')?.run.id).toBe('r:GAN-1');
    expect(repo.getRunById('pr-review:a')?.run).toMatchObject({
      kind: 'pr-review',
      reviewMode: 'initial',
      prNumber: 5,
      reviewResult: { type: 'verdict', verdict: 'APPROVE', postedAsComment: false },
    });
    expect(repo.getRunById('nope')).toBeUndefined();
    db.close();
  });

  it('still refuses a second pipeline row for the same repo + ticket', () => {
    const db = openDb(':memory:');
    const repo = new PipelineRunRepository(db);
    const run = { repoId: 'r', ticketId: 'T-1', ticketTitle: 't', startedAt: '2026-10-04T00:00:00.000Z' };
    repo.upsertPipelineRun({ id: 'one', ...run });
    expect(() => repo.upsertPipelineRun({ id: 'two', ...run })).toThrow(/UNIQUE/);
    db.close();
  });

  it('is idempotent — migrating twice leaves columns and indexes as they were', () => {
    const db = openDb(':memory:');
    const before = [columnsOf(db, 'pipeline_runs'), indexesOf(db)];
    expect(() => migrate(db)).not.toThrow();
    expect([columnsOf(db, 'pipeline_runs'), indexesOf(db)]).toEqual(before);
    db.close();
  });
});
