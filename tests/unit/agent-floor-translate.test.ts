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
    expect(calls[3]).toEqual(['log', 'info', 'Run diulang, attempt 2', 0]);
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
    expect(known[0]).toEqual(['setState', 'qa', 'retrying', 'Menolak, retry 1/1', 'warn', 0, { checks: null }]);
    expect(known[1]).toEqual(['log', 'warn', 'QA: gate QA menolak, retry 1/1', 0]);

    const unknown = translate({ ...base, type: 'agent_state', agent: 'reviewer', state: 'retrying', gate: 'reviewer', retry: { count: 1, max: null } });
    expect(unknown[0][3]).toBe('Menolak, retry 1/?');
    expect(JSON.stringify([known, unknown])).not.toContain('/3');
  });

  it('blocked and error use the blocked/error states with the gate or outcome named', () => {
    expect(translate({ ...base, type: 'agent_state', agent: 'backend', state: 'blocked', gate: 'implementation' })).toEqual([
      ['setState', 'backend', 'blocked', 'Butuh Ganjar', 'bad'],
      ['log', 'bad', 'Backend: NEEDS_HUMAN di gate implementasi', 0],
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
    expect(calls[2].slice(0, 3)).toEqual(['log', 'info', 'Backend: verify percobaan 2/3, lint lolos, typecheck gagal']);
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
    expect(usage[1][2]).toBe('Planner: selesai ($0.1133, 27 dtk)');
  });

  it('run_finished maps each final status to its own status and human signal', () => {
    const finished = (finalStatus: 'SUCCESS' | 'NEEDS_HUMAN' | 'ERROR' | null, gate: 'qa' | null = null): Call[] =>
      translate({ ...base, type: 'run_finished', finalStatus, gate, superseded: finalStatus === null });

    expect(finished('SUCCESS').slice(0, 2)).toEqual([['setStatus', 'success'], ['setState', 'human', 'alert', 'Run selesai', 'ok']]);
    expect(finished('NEEDS_HUMAN', 'qa').slice(0, 2)).toEqual([['setStatus', 'needs'], ['setState', 'human', 'alert', 'Ada yang perlu dicek', 'bad']]);
    expect(finished('NEEDS_HUMAN', 'qa')[2][2]).toBe('final_status: NEEDS_HUMAN (gate QA)');
    expect(finished('NEEDS_HUMAN')[2][2]).toBe('final_status: NEEDS_HUMAN');
    expect(finished('ERROR')[0]).toEqual(['setStatus', 'error']);
    // A superseded attempt with no recorded status: no status is claimed.
    expect(names(finished(null))).toEqual(['log']);
  });

  it('the pr step lights the human desk green for a final PR, and only notes a Draft PR', () => {
    const final = translate({ ...base, type: 'step', step: 'pr', status: 'pass', note: 'PR #118', prNumber: 118 });
    expect(final).toContainEqual(['setState', 'human', 'alert', 'PR #118, siap direview', 'ok']);
    const draft = translate({ ...base, type: 'step', step: 'pr', status: 'pass', note: 'Draft PR #7', prNumber: 7 });
    expect(draft).toContainEqual(['say', 'human', 'Draft PR #7 menunggu', 'bad']);
    expect(names(draft)).not.toContain('setState');
  });

  it('log times are the offset from the attempt start', () => {
    const calls = translate({ ...base, type: 'usage', agent: 'qa', costUsd: null, tokens: null, durationMs: null }, { runStartMs: T0 });
    expect(calls[1]).toEqual(['log', 'info', 'QA: selesai', 60_000]);
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
    expect(calls.at(-1)).toEqual(['setState', 'human', 'alert', 'PR #5, siap direview', 'ok']);
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
