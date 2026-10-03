import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/infrastructure/db/connection.js';
import { PipelineRunRepository } from '../../src/infrastructure/db/pipeline-run.repository.js';

describe('PipelineRunRepository', () => {
  let db: Database.Database;
  let repo: PipelineRunRepository;

  beforeEach(() => {
    db = openDb(':memory:');
    repo = new PipelineRunRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedRun(overrides: Partial<Parameters<PipelineRunRepository['upsertPipelineRun']>[0]> = {}) {
    repo.upsertPipelineRun({
      id: 'run-1',
      repoId: 'repo-a',
      ticketId: 'CAF-1',
      ticketTitle: 'Some ticket',
      startedAt: '2026-09-07T00:00:00.000Z',
      ...overrides,
    });
  }

  it('upsertPipelineRun creates a new row', () => {
    seedRun();
    const runs = repo.getPipelineRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: 'run-1', repoId: 'repo-a', ticketId: 'CAF-1' });
  });

  it('upsertPipelineRun on the same id updates mutable fields instead of duplicating', () => {
    seedRun();
    seedRun({ finalStatus: 'SUCCESS', endedAt: '2026-09-07T01:00:00.000Z' });

    const runs = repo.getPipelineRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].finalStatus).toBe('SUCCESS');
    expect(runs[0].endedAt).toBe('2026-09-07T01:00:00.000Z');
  });

  it('insertEvent stores an event and returns it with an assigned id', () => {
    seedRun();
    const event = repo.insertEvent({
      pipelineRunId: 'run-1',
      agentName: 'caf-planner',
      pivPhase: 'plan',
      eventType: 'start',
      createdAt: '2026-09-07T00:00:01.000Z',
    });

    expect(event.id).toBeTypeOf('number');
    expect(event).toMatchObject({
      pipelineRunId: 'run-1',
      agentName: 'caf-planner',
      pivPhase: 'plan',
      eventType: 'start',
      retryCount: null,
      costUsd: null,
      artifactLink: null,
    });
  });

  it('getPipelineRuns filters by repoId', () => {
    seedRun({ id: 'run-1', repoId: 'repo-a', ticketId: 'CAF-1' });
    seedRun({ id: 'run-2', repoId: 'repo-b', ticketId: 'CAF-2' });

    expect(repo.getPipelineRuns('repo-a').map((r) => r.id)).toEqual(['run-1']);
    expect(repo.getPipelineRuns('repo-b').map((r) => r.id)).toEqual(['run-2']);
    expect(repo.getPipelineRuns()).toHaveLength(2);
  });

  it('getPipelineRuns orders newest first and respects pagination', () => {
    seedRun({ id: 'run-1', ticketId: 'CAF-1', startedAt: '2026-09-07T00:00:00.000Z' });
    seedRun({ id: 'run-2', ticketId: 'CAF-2', startedAt: '2026-09-07T02:00:00.000Z' });
    seedRun({ id: 'run-3', ticketId: 'CAF-3', startedAt: '2026-09-07T01:00:00.000Z' });

    expect(repo.getPipelineRuns(undefined, { limit: 2 }).map((r) => r.id)).toEqual(['run-2', 'run-3']);
    expect(repo.getPipelineRuns(undefined, { limit: 2, offset: 2 }).map((r) => r.id)).toEqual(['run-1']);
  });

  it('getPipelineDetail returns the run with its events in chronological order', () => {
    seedRun();
    repo.insertEvent({
      pipelineRunId: 'run-1',
      agentName: 'caf-planner',
      pivPhase: 'plan',
      eventType: 'end',
      createdAt: '2026-09-07T00:00:05.000Z',
    });
    repo.insertEvent({
      pipelineRunId: 'run-1',
      agentName: 'caf-planner',
      pivPhase: 'plan',
      eventType: 'start',
      createdAt: '2026-09-07T00:00:01.000Z',
    });

    const detail = repo.getPipelineDetail('repo-a', 'CAF-1');
    expect(detail?.run.id).toBe('run-1');
    expect(detail?.events.map((e) => e.eventType)).toEqual(['start', 'end']);
  });

  it('getPipelineDetail returns undefined when no run matches', () => {
    expect(repo.getPipelineDetail('repo-x', 'CAF-999')).toBeUndefined();
  });
  describe('CAF-DASHBOARD-02 T1: attempt marker, PR number, agent outcome', () => {
    it('starts at attempt 1 and bumps the attempt on every later start of the same run', () => {
      seedRun();
      expect(repo.getPipelineRuns()[0].attempt).toBe(1);
      seedRun();
      seedRun();
      expect(repo.getPipelineRuns()[0].attempt).toBe(3);
    });

    it('stamps each event with the attempt that was current when it was written', () => {
      seedRun();
      repo.insertEvent({ pipelineRunId: 'run-1', agentName: 'caf-planner', pivPhase: 'plan', eventType: 'start', createdAt: '2026-09-07T00:00:01.000Z' });
      seedRun();
      repo.insertEvent({ pipelineRunId: 'run-1', agentName: 'caf-planner', pivPhase: 'plan', eventType: 'start', createdAt: '2026-09-07T00:10:01.000Z' });

      expect(repo.getEventsForRun('run-1').map((e) => e.attempt)).toEqual([1, 2]);
    });

    it('stores and returns the PR number, and keeps it across a new attempt', () => {
      seedRun();
      expect(repo.getPipelineRuns()[0].prNumber).toBeNull();
      repo.setPullRequestNumber('run-1', 42);
      seedRun();
      expect(repo.getPipelineRuns()[0].prNumber).toBe(42);
    });

    it('round-trips exit code, outcome and verify details on an event, defaulting to null', () => {
      seedRun();
      const verifyDetails = { attempt: 2, maxAttempts: 3, checks: { lint: 'pass', typecheck: 'fail', test: null } } as const;
      const full = repo.insertEvent({
        pipelineRunId: 'run-1',
        agentName: 'caf-backend',
        pivPhase: 'implement',
        eventType: 'end',
        createdAt: '2026-09-07T00:00:02.000Z',
        exitCode: 1,
        outcome: 'FAILED',
        verifyDetails,
      });
      const bare = repo.insertEvent({ pipelineRunId: 'run-1', agentName: 'caf-qa', pivPhase: 'verify', eventType: 'start', createdAt: '2026-09-07T00:00:03.000Z' });

      expect(full).toMatchObject({ exitCode: 1, outcome: 'FAILED', verifyDetails });
      expect(bare).toMatchObject({ exitCode: null, outcome: null, verifyDetails: null });
    });
  });
});
