import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AgentEvent, PipelineRun } from '../../src/infrastructure/db/pipeline-run.repository.js';
import { normalizeRun, type FloorEvent } from '../../src/presentation/web/agent-floor/event-normalizer.js';

// CAF-DASHBOARD-02 T5/T6: the browser-side translator (contract event →
// calls on the public render API). It is a plain script served as-is to the
// browser, loaded here through its module.exports hook.

type Call = [fn: string, ...args: unknown[]];
const { translate, replayDelay } = createRequire(__filename)(
  join(__dirname, '../../src/presentation/web/ui/agent-floor/translate.js'),
) as {
  translate: (event: FloorEvent, ctx?: { runStartMs?: number | null }) => Call[];
  replayDelay: (prev: string, next: string) => number;
};

const PUBLIC_API = ['setState', 'say', 'sendDoc', 'step', 'setStatus', 'log', 'reset', 'setRun', 'usage', 'celebrate'];
const T0 = Date.parse('2026-09-08T09:00:00.000Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const base = { cursor: '1.0', runId: 'r:GAN-1', attempt: 1, timestamp: at(60) };
const names = (calls: Call[]): string[] => calls.map((c) => c[0]);

describe('translate', () => {
  it('run_started resets the world, fills the run panel and marks it running', () => {
    const calls = translate({
      ...base,
      type: 'run_started',
      ticket: 'GAN-1',
      ticketTitle: 'Some ticket',
      repo: 'ganjardbc/umkm-pos',
      branch: 'ai-agent/GAN-1',
      startedAt: at(0),
    });
    expect(names(calls)).toEqual(['reset', 'setRun', 'setStatus', 'log']);
    expect(calls[1][1]).toMatchObject({ title: 'GAN-1  Some ticket', meta: 'repo ganjardbc/umkm-pos, branch ai-agent/GAN-1', startedAt: at(0) });
    expect(calls[2]).toEqual(['setStatus', 'run']);
  });

  it('a later attempt says so, so a retried run is not mistaken for a first try', () => {
    const calls = translate({ ...base, attempt: 2, type: 'run_started', ticket: 'GAN-1', ticketTitle: 't', repo: 'r', branch: 'b', startedAt: at(0) });
    expect((calls[1][1] as { meta: string }).meta).toContain('attempt 2');
    expect(calls[3]).toEqual(['log', 'info', 'Run restarted, attempt 2', 0]);
  });

  it.each([
    ['planner', 'planning'],
    ['backend', 'implementing'],
    ['qa', 'verifying'],
    ['reviewer', 'reviewing'],
  ] as const)('%s %s → setState without verify bars (live has no per-check data)', (agent, state) => {
    const calls = translate({ ...base, type: 'agent_state', agent, state });
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 3)).toEqual(['setState', agent, state]);
    expect(calls[0][6]).toEqual({ checks: null });
  });

  it('a gate retry shows the gate counter and its real limit, never an assumed n/3', () => {
    const known = translate({ ...base, type: 'agent_state', agent: 'qa', state: 'retrying', gate: 'qa', retry: { count: 1, max: 1 } });
    expect(known[0]).toEqual(['setState', 'qa', 'retrying', 'Rejected, retry 1/1', 'warn', 0, { checks: null }]);
    expect(known[1]).toEqual(['log', 'warn', 'QA: QA gate rejected, retry 1/1', 0]);

    const unknown = translate({ ...base, type: 'agent_state', agent: 'reviewer', state: 'retrying', gate: 'reviewer', retry: { count: 1, max: null } });
    expect(unknown[0][3]).toBe('Rejected, retry 1/?');
    expect(JSON.stringify([known, unknown])).not.toContain('/3');
  });

  it('blocked and error use the blocked/error states with the gate or outcome named', () => {
    expect(translate({ ...base, type: 'agent_state', agent: 'backend', state: 'blocked', gate: 'implementation' })).toEqual([
      ['setState', 'backend', 'blocked', 'Need Manager', 'bad'],
      ['log', 'bad', 'Backend: NEEDS_HUMAN at the implementation gate', 0],
    ]);
    expect(translate({ ...base, type: 'agent_state', agent: 'backend', state: 'error', outcome: 'TIMEOUT' })[0]).toEqual([
      'setState', 'backend', 'error', 'Error: TIMEOUT', 'bad',
    ]);
  });

  it('idle with verify details records the attempt and logs only the checks the report actually had', () => {
    const calls = translate({
      ...base,
      type: 'agent_state',
      agent: 'backend',
      state: 'idle',
      verify: { attempt: 2, maxAttempts: 3, checks: { lint: 'pass', typecheck: 'fail', test: null } },
    });
    expect(calls[0]).toEqual(['setState', 'backend', 'idle', undefined, '', 0, { attempt: '2/3' }]);
    expect(calls[1]).toEqual(['say', 'backend', null]);
    expect(calls[2].slice(0, 3)).toEqual(['log', 'info', 'Backend: verify attempt 2/3, lint passed, typecheck failed']);
  });

  it('idle with an all-null verify result logs nothing and shows no attempt', () => {
    const calls = translate({
      ...base,
      type: 'agent_state',
      agent: 'backend',
      state: 'idle',
      verify: { attempt: null, maxAttempts: null, checks: { lint: null, typecheck: null, test: null } },
    });
    expect(names(calls)).toEqual(['setState', 'say']);
    expect(calls[0][6]).toEqual({ attempt: '' });
  });

  it('handoff → sendDoc; usage → usage with the real numbers', () => {
    expect(translate({ ...base, type: 'handoff', from: 'qa', to: 'human', file: 'qa-report.md' })).toEqual([['sendDoc', 'qa', 'human', 'qa-report.md']]);
    const usage = translate({ ...base, type: 'usage', agent: 'planner', costUsd: 0.1133, tokens: null, durationMs: 27_305 });
    expect(usage[0]).toEqual(['usage', 'planner', { costUsd: 0.1133, tokens: null, durationMs: 27_305 }]);
    expect(usage[1][2]).toBe('Planner: finished ($0.1133, 27 s)');
  });

  it('run_finished maps each final status to its own status and human signal', () => {
    const finished = (finalStatus: 'SUCCESS' | 'NEEDS_HUMAN' | 'ERROR' | null, gate: 'qa' | null = null): Call[] =>
      translate({ ...base, type: 'run_finished', finalStatus, gate, superseded: finalStatus === null });

    expect(finished('SUCCESS').slice(0, 2)).toEqual([['setStatus', 'success'], ['setState', 'human', 'alert', 'Run finished', 'ok']]);
    expect(finished('NEEDS_HUMAN', 'qa').slice(0, 2)).toEqual([['setStatus', 'needs'], ['setState', 'human', 'alert', 'Something needs a look', 'bad']]);
    expect(finished('NEEDS_HUMAN', 'qa')[2][2]).toBe('final_status: NEEDS_HUMAN (QA gate)');
    expect(finished('NEEDS_HUMAN')[2][2]).toBe('final_status: NEEDS_HUMAN');
    expect(finished('ERROR')[0]).toEqual(['setStatus', 'error']);
    // A superseded attempt with no recorded status: no status is claimed.
    expect(names(finished(null))).toEqual(['log']);
  });

  it('the pr step lights the human desk green for a final PR, and only notes a Draft PR', () => {
    const final = translate({ ...base, type: 'step', step: 'pr', status: 'pass', note: 'PR #118', prNumber: 118 });
    expect(final).toContainEqual(['setState', 'human', 'alert', 'PR #118, ready for review', 'ok']);
    const draft = translate({ ...base, type: 'step', step: 'pr', status: 'pass', note: 'Draft PR #7', prNumber: 7 });
    expect(draft).toContainEqual(['say', 'human', 'Draft PR #7 waiting', 'bad']);
    expect(names(draft)).not.toContain('setState');
  });

  it('log times are the offset from the attempt start', () => {
    const calls = translate({ ...base, type: 'usage', agent: 'qa', costUsd: null, tokens: null, durationMs: null }, { runStartMs: T0 });
    expect(calls[1]).toEqual(['log', 'info', 'QA: finished', 60_000]);
  });

  it('never touches Docs: caf-documentation stays off duty for every event of a real-shaped run', () => {
    const run: PipelineRun = {
      id: 'ganjardbc/umkm-pos:GAN-1', repoId: 'ganjardbc/umkm-pos', ticketId: 'GAN-1', ticketTitle: 't',
      startedAt: at(0), endedAt: at(200), finalStatus: 'SUCCESS', attempt: 1, prNumber: 5,
    };
    const spec: Array<[string, AgentEvent['eventType'], AgentEvent['pivPhase']]> = [
      ['caf-planner', 'start', 'plan'], ['caf-planner', 'end', 'plan'],
      ['caf-backend', 'start', 'implement'], ['caf-backend', 'end', 'implement'],
      ['caf-qa', 'start', 'verify'], ['caf-qa', 'end', 'verify'],
      ['caf-qa', 'retry', 'verify'],
      ['caf-backend', 'start', 'implement'], ['caf-backend', 'end', 'implement'],
      ['caf-qa', 'start', 'verify'], ['caf-qa', 'end', 'verify'],
      ['caf-reviewer', 'start', 'verify'], ['caf-reviewer', 'end', 'verify'],
    ];
    const rows: AgentEvent[] = spec.map(([agentName, eventType, pivPhase], i) => ({
      id: i + 1, pipelineRunId: run.id, agentName, pivPhase, eventType,
      retryCount: eventType === 'retry' ? 1 : null, costUsd: eventType === 'end' ? 0.1 : null, artifactLink: null,
      createdAt: at((i + 1) * 10), attempt: 1, exitCode: eventType === 'end' ? 0 : null,
      outcome: eventType === 'end' ? 'OK' : null, verifyDetails: null,
    }));

    const calls = normalizeRun(run, rows, { retryLimits: { qa: 1 } }).flatMap((e) => translate(e, { runStartMs: T0 }));

    expect(calls.length).toBeGreaterThan(30);
    // Everything the translator emits is a function render.js actually exposes.
    expect(new Set(names(calls)).size).toBeGreaterThan(5);
    for (const fn of names(calls)) expect(PUBLIC_API).toContain(fn);
    expect(calls.some((c) => c.includes('docs'))).toBe(false);
    expect(calls.at(-1)).toEqual(['setState', 'human', 'alert', 'PR #5, ready for review', 'ok']);
  });
});

describe('replayDelay', () => {
  it('compresses real gaps 30x within bounds, and keeps same-row events close together', () => {
    expect(replayDelay(at(0), at(0))).toBe(120);
    expect(replayDelay(at(0), at(1))).toBe(350); // floor
    expect(replayDelay(at(0), at(60))).toBe(2000);
    expect(replayDelay(at(0), at(600))).toBe(3500); // cap
    expect(replayDelay(at(10), at(0))).toBe(120); // out-of-order timestamps never produce a negative wait
  });
});

// CAF-DASHBOARD-03 T6: PR review / fix-review runs.
describe('translate — PR review runs', () => {
  const started = (reviewMode: 'initial' | 'global' | 'scoped', attempt = 1): FloorEvent => ({
    ...base,
    attempt,
    type: 'run_started',
    ticket: 'GAN-1',
    ticketTitle: 'Some ticket',
    repo: 'ganjardbc/umkm-pos',
    branch: 'ai-agent/GAN-1',
    startedAt: at(0),
    kind: 'pr-review',
    reviewMode,
    prNumber: 42,
  });
  const finished = (mode: 'initial' | 'global', result: unknown, finalStatus: 'SUCCESS' | 'ERROR' = 'SUCCESS'): FloorEvent =>
    ({ ...base, type: 'run_finished', finalStatus, gate: null, superseded: false, review: { mode, result, prNumber: 42 } }) as FloorEvent;
  const find = (calls: Call[], fn: string, first?: unknown): Call | undefined =>
    calls.find((c) => c[0] === fn && (first === undefined || c[1] === first));

  it('run_started shows a single Review stage and says which PR is under review', () => {
    const calls = translate(started('initial'));
    expect(names(calls)).toEqual(['reset', 'setSteps', 'setRun', 'setStatus', 'log']);
    expect(find(calls, 'setSteps')).toEqual(['setSteps', [['review', 'Review']]]);
    expect(find(calls, 'setRun')?.[1]).toMatchObject({ title: 'GAN-1  Some ticket', meta: expect.stringContaining('Review of PR #42') });
    expect(find(calls, 'log')).toEqual(['log', 'info', 'Review started on PR #42', 0]);
  });

  it('run_started for a fix review names the mode, and a retry says so', () => {
    const calls = translate(started('global', 2));
    expect(find(calls, 'setSteps')).toEqual(['setSteps', [['review', 'Fix review']]]);
    expect(find(calls, 'setRun')?.[1]).toMatchObject({ meta: expect.stringMatching(/^Fix review \(global\) of PR #42.*attempt 2$/) });
    expect(find(calls, 'log')?.[2]).toBe('Fix review (global) restarted, attempt 2');
  });

  it('a pipeline run_started never calls setSteps', () => {
    const { kind: _kind, reviewMode: _mode, prNumber: _pr, ...pipeline } = started('initial') as Record<string, unknown>;
    expect(names(translate(pipeline as unknown as FloorEvent))).toEqual(['reset', 'setRun', 'setStatus', 'log']);
  });

  it('the fixing state is a working state with its own text', () => {
    const calls = translate({ ...base, type: 'agent_state', agent: 'reviewer', state: 'fixing' });
    expect(calls).toEqual([['setState', 'reviewer', 'fixing', 'Fixing review comments', 'info', 0, { checks: null }]]);
  });

  it('APPROVE: success pill reworded, manager notified positively', () => {
    const calls = translate(finished('initial', { type: 'verdict', verdict: 'APPROVE', postedAsComment: false }));
    expect(find(calls, 'setStatus')).toEqual(['setStatus', 'success', 'Review posted']);
    expect(find(calls, 'setState', 'human')).toEqual(['setState', 'human', 'alert', 'PR #42 approved', 'ok']);
    expect(find(calls, 'setState', 'reviewer')).toBeUndefined();
    expect(calls.filter((c) => c[0] === 'log').map((c) => c[2])).toEqual(['Verdict: APPROVE', 'final_status: SUCCESS']);
  });

  it('CHANGES REQUESTED: reviewer raises a hand and the manager is alerted, even though the job succeeded', () => {
    const calls = translate(finished('initial', { type: 'verdict', verdict: 'CHANGES_REQUESTED', postedAsComment: true }));
    expect(find(calls, 'setStatus')).toEqual(['setStatus', 'success', 'Review posted']);
    expect(find(calls, 'setState', 'reviewer')).toEqual(['setState', 'reviewer', 'blocked', 'Changes requested', 'warn']);
    expect(find(calls, 'setState', 'human')).toEqual(['setState', 'human', 'alert', 'Changes requested on PR #42', 'bad']);
    expect(find(calls, 'log')?.slice(1, 3)).toEqual(['warn', 'Verdict: CHANGES REQUESTED (posted as COMMENT)']);
  });

  it('DEFER: handed to the manager', () => {
    const calls = translate(finished('initial', { type: 'verdict', verdict: 'DEFER', postedAsComment: false }));
    expect(find(calls, 'setState', 'reviewer')?.[3]).toBe('Deferred to Manager');
    expect(find(calls, 'setState', 'human')?.slice(3)).toEqual(['Review deferred on PR #42', 'bad']);
  });

  it('fix review: counts in the log, manager notified', () => {
    const calls = translate(finished('global', { type: 'fix', fixed: 2, skipped: 1, notApplicable: 0 }));
    expect(find(calls, 'setStatus')).toEqual(['setStatus', 'success', 'Fix review posted']);
    expect(find(calls, 'setState', 'human')).toEqual(['setState', 'human', 'alert', 'Fix review posted on PR #42', 'ok']);
    expect(find(calls, 'log')?.slice(1, 3)).toEqual(['ok', 'Fix review: 2 fixed, 1 skipped, 0 n/a']);
  });

  it('ERROR on a review run is reported exactly like a pipeline ERROR', () => {
    const review = translate(finished('initial', null, 'ERROR'));
    const pipeline = translate({ ...base, type: 'run_finished', finalStatus: 'ERROR', gate: null, superseded: false });
    expect(review).toEqual(pipeline);
  });

  it('only ever calls the public render API (plus setSteps)', () => {
    const events = [
      started('initial'),
      started('scoped'),
      finished('initial', { type: 'verdict', verdict: 'APPROVE', postedAsComment: false }),
      finished('initial', { type: 'verdict', verdict: 'DEFER', postedAsComment: false }),
      finished('global', { type: 'fix', fixed: 0, skipped: 0, notApplicable: 0 }),
      finished('global', null),
    ];
    for (const event of events) {
      for (const call of translate(event)) expect([...PUBLIC_API, 'setSteps']).toContain(call[0]);
    }
  });
});
