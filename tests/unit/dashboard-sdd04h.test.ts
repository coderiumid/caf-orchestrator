import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/infrastructure/db/connection.js';
import {
  PipelineRunRepository,
  type AgentEvent,
  type PipelineRun,
} from '../../src/infrastructure/db/pipeline-run.repository.js';
import { normalizeRun, type FloorEvent } from '../../src/presentation/web/agent-floor/event-normalizer.js';

// CAF-SDD-04h: the dashboard and the Agent Floor show a run parked on Clarify /
// spec approval as waiting (not failed), the validator's AC counts, and the
// validator under its own name.

type Call = [fn: string, ...args: unknown[]];
const { translate } = createRequire(__filename)(
  join(__dirname, '../../src/presentation/web/ui/agent-floor/translate.js'),
) as { translate: (event: FloorEvent, ctx?: Record<string, unknown>) => Call[] };

const T0 = Date.parse('2026-10-19T09:00:00.000Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const COUNTS = { pass: 1, fail: 0, unverified: 2, total: 3, allUnverified: false };

describe('pipeline_runs waiting_for / ac_summary', () => {
  let db: Database.Database;
  let repo: PipelineRunRepository;

  beforeEach(() => {
    db = openDb(':memory:');
    repo = new PipelineRunRepository(db);
    repo.upsertPipelineRun({ id: 'r1', repoId: 'o/r', ticketId: 'GAN-1', ticketTitle: 't', startedAt: at(0) });
  });
  afterEach(() => db.close());

  it('defaults to null on a fresh row', () => {
    expect(repo.getRunById('r1')!.run).toMatchObject({ waitingFor: null, acSummary: null });
  });

  it('stores and reads back the waiting reason and the AC counts', () => {
    repo.setWaitingFor('r1', 'clarify');
    repo.setAcSummary('r1', COUNTS);
    expect(repo.getRunById('r1')!.run).toMatchObject({ waitingFor: 'clarify', acSummary: COUNTS });
    repo.setWaitingFor('r1', 'spec-approval');
    expect(repo.getRunById('r1')!.run.waitingFor).toBe('spec-approval');
  });

  it('a new attempt clears both, like final_status', () => {
    repo.setWaitingFor('r1', 'spec-approval');
    repo.setAcSummary('r1', COUNTS);
    repo.upsertPipelineRun({ id: 'r1', repoId: 'o/r', ticketId: 'GAN-1', ticketTitle: 't', startedAt: at(100) });
    expect(repo.getRunById('r1')!.run).toMatchObject({ waitingFor: null, acSummary: null, attempt: 2 });
  });

  it('migrating an old database adds the columns without touching its rows', () => {
    const old = openDb(':memory:');
    old.exec('ALTER TABLE pipeline_runs DROP COLUMN waiting_for; ALTER TABLE pipeline_runs DROP COLUMN ac_summary;');
    old.prepare("INSERT INTO pipeline_runs (id, repo_id, ticket_id, ticket_title, started_at) VALUES ('x','o/r','K-1','t',?)").run(at(0));
    const names = (): string[] => (old.pragma('table_info(pipeline_runs)') as Array<{ name: string }>).map((c) => c.name);
    expect(names()).not.toContain('waiting_for');
    // openDb on a file would re-run migrate(); calling the exported one is the same path.
    return import('../../src/infrastructure/db/connection.js').then(({ migrate }) => {
      migrate(old);
      expect(names()).toEqual(expect.arrayContaining(['waiting_for', 'ac_summary']));
      expect(new PipelineRunRepository(old).getRunById('x')!.run).toMatchObject({ waitingFor: null, acSummary: null });
      old.close();
    });
  });
});

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'o/r:GAN-1',
    repoId: 'o/r',
    ticketId: 'GAN-1',
    ticketTitle: 'Some ticket',
    startedAt: at(0),
    endedAt: at(60),
    finalStatus: 'NEEDS_HUMAN',
    attempt: 1,
    prNumber: null,
    kind: 'pipeline',
    reviewMode: null,
    reviewResult: null,
    waitingFor: null,
    acSummary: null,
    ...overrides,
  };
}

function rows(specs: Array<[string, AgentEvent['eventType']]>): AgentEvent[] {
  return specs.map(([agentName, eventType], i) => ({
    id: i + 1,
    pipelineRunId: 'o/r:GAN-1',
    agentName,
    pivPhase: agentName === 'caf-planner' ? 'plan' : agentName === 'caf-validator' ? 'verify' : 'implement',
    eventType,
    retryCount: null,
    costUsd: null,
    artifactLink: null,
    createdAt: at((i + 1) * 5),
    attempt: 1,
    exitCode: eventType === 'end' ? 0 : null,
    outcome: eventType === 'end' ? 'OK' : null,
    verifyDetails: null,
  }));
}

const PLANNER_ONLY = rows([
  ['caf-planner', 'start'],
  ['caf-planner', 'end'],
]);

describe('Agent Floor normalizer: a run parked on a human', () => {
  it.each(['clarify', 'spec-approval'] as const)('%s: spec step, planner → Manager handoff, waitingFor on run_finished', (waitingFor) => {
    const events = normalizeRun(makeRun({ waitingFor, prNumber: waitingFor === 'spec-approval' ? 7 : null }), PLANNER_ONLY);
    expect(events).toContainEqual(expect.objectContaining({ type: 'step', step: 'plan', status: 'pass', note: 'requirements.md' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'step', step: 'spec', status: 'active', note: waitingFor }));
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'handoff', from: 'planner', to: 'human', file: 'requirements.md' }),
    );
    const finished = events.find((e) => e.type === 'run_finished');
    expect(finished).toMatchObject({ finalStatus: 'NEEDS_HUMAN', gate: null, waitingFor });
    // run_finished still sorts after the spec step, and the Draft PR step after run_finished.
    const order = events.map((e) => e.type + (e.type === 'step' ? `:${e.step}` : ''));
    expect(order.indexOf('step:spec')).toBeLessThan(order.indexOf('run_finished'));
    if (waitingFor === 'spec-approval') expect(order.indexOf('run_finished')).toBeLessThan(order.indexOf('step:pr'));
  });

  it('cursors stay strictly increasing', () => {
    const cursors = normalizeRun(makeRun({ waitingFor: 'clarify' }), PLANNER_ONLY).map((e) => e.cursor);
    const key = (c: string): number[] => c.split('.').map(Number);
    for (let i = 1; i < cursors.length; i += 1) {
      const [a, b] = [key(cursors[i - 1]), key(cursors[i])];
      expect(a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])).toBe(true);
    }
  });

  it('a run that is not waiting has no spec step and no waitingFor', () => {
    const events = normalizeRun(makeRun(), PLANNER_ONLY);
    expect(events.some((e) => e.type === 'step' && e.step === 'spec')).toBe(false);
    expect(events.find((e) => e.type === 'run_finished')).not.toHaveProperty('waitingFor');
    expect(events).toContainEqual(expect.objectContaining({ type: 'step', step: 'plan', note: 'tasks.md' }));
  });

  it('a waiting reason on a run that is no longer NEEDS_HUMAN is ignored', () => {
    const events = normalizeRun(makeRun({ waitingFor: 'clarify', finalStatus: null, endedAt: null }), PLANNER_ONLY);
    expect(events.some((e) => e.type === 'step' && e.step === 'spec')).toBe(false);
  });

  it('carries the validator AC counts on run_finished', () => {
    const events = normalizeRun(makeRun({ acSummary: COUNTS }), PLANNER_ONLY);
    expect(events.find((e) => e.type === 'run_finished')).toMatchObject({ acSummary: COUNTS });
  });
});

describe('Agent Floor translator: waiting and criteria', () => {
  const base = { cursor: '1.0', runId: 'r', attempt: 1, timestamp: at(60) };
  const finished = (extra: Record<string, unknown>, ctx?: Record<string, unknown>): Call[] =>
    translate({ ...base, type: 'run_finished', finalStatus: 'NEEDS_HUMAN', gate: null, superseded: false, ...extra } as FloorEvent, ctx);

  it('Clarify reads as waiting for answers, not as a failure', () => {
    const calls = finished({ waitingFor: 'clarify' });
    expect(calls[0]).toEqual(['setStatus', 'needs', 'Waiting for answers']);
    expect(calls[1]).toEqual(['setState', 'human', 'alert', 'Need your answers', 'warn']);
    expect(JSON.stringify(calls)).not.toContain('Something needs a look');
  });

  it('spec approval reads as waiting for approval and marks the ctx for the Draft PR step', () => {
    const ctx: Record<string, unknown> = {};
    expect(finished({ waitingFor: 'spec-approval' }, ctx)[0]).toEqual(['setStatus', 'needs', 'Waiting for spec approval']);
    expect(ctx.waitingFor).toBe('spec-approval');
    const pr = translate({ ...base, type: 'step', step: 'pr', status: 'pass', note: 'Draft PR #7', prNumber: 7 } as FloorEvent, ctx);
    expect(pr).toContainEqual(['say', 'human', 'Draft PR #7 holds the spec', 'warn']);
  });

  it('a gate stop without waitingFor keeps the failure wording, now naming the Validator', () => {
    const calls = finished({ gate: 'qa' });
    expect(calls[1]).toEqual(['setState', 'human', 'alert', 'Something needs a look', 'bad']);
    expect(calls[2][2]).toBe('final_status: NEEDS_HUMAN (Validator gate)');
  });

  it('the spec step logs what the person has to do', () => {
    const calls = translate({ ...base, type: 'step', step: 'spec', status: 'active', note: 'clarify' } as FloorEvent);
    expect(calls[0]).toEqual(['step', 'spec', 'active', 'clarify']);
    expect(calls[1][1]).toBe('warn');
    expect(String(calls[1][2])).toContain('BLOCKING');
  });

  it('AC counts are set on the panel, and an all-UNVERIFIED PASS is called out', () => {
    const allUnverified = { pass: 0, fail: 0, unverified: 3, total: 3, allUnverified: true };
    const calls = finished({ gate: 'qa', acSummary: allUnverified });
    expect(calls[0]).toEqual(['setAc', allUnverified]);
    expect(calls[1]).toEqual(['log', 'warn', expect.stringContaining('none proven'), 0]);
  });
});
