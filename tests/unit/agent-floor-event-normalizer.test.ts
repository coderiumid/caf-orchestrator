import { describe, it, expect } from 'vitest';
import type { AgentEvent, PipelineRun } from '../../src/infrastructure/db/pipeline-run.repository.js';
import {
  normalizeRun,
  eventsAfter,
  parseCursor,
  type FloorEvent,
} from '../../src/presentation/web/agent-floor/event-normalizer.js';

// CAF-DASHBOARD-02 T2: table cases for the pure row → contract-event
// normalizer shared by the live and replay paths.

const T0 = Date.parse('2026-09-08T09:00:00.000Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'ganjardbc/umkm-pos:GAN-1',
    repoId: 'ganjardbc/umkm-pos',
    ticketId: 'GAN-1',
    ticketTitle: 'Some ticket',
    startedAt: at(0),
    endedAt: null,
    finalStatus: null,
    attempt: 1,
    prNumber: null,
    ...overrides,
  };
}

type RowSpec = [agentName: string, eventType: AgentEvent['eventType'], extra?: Partial<AgentEvent>];

const PHASE: Record<string, AgentEvent['pivPhase']> = {
  'caf-planner': 'plan',
  'caf-frontend': 'implement',
  'caf-backend': 'implement',
  'implementation-agents': 'implement',
  'caf-qa': 'verify',
  'caf-reviewer': 'verify',
};

/** Rows with ids 1..n, ten seconds apart, attempt 1 unless overridden. */
function makeRows(specs: RowSpec[], runId = 'ganjardbc/umkm-pos:GAN-1'): AgentEvent[] {
  return specs.map(([agentName, eventType, extra], index) => ({
    id: index + 1,
    pipelineRunId: runId,
    agentName,
    pivPhase: PHASE[agentName] ?? 'implement',
    eventType,
    retryCount: null,
    costUsd: eventType === 'end' ? 0.1 : null,
    artifactLink: null,
    createdAt: at((index + 1) * 10),
    attempt: 1,
    exitCode: eventType === 'end' ? 0 : null,
    outcome: eventType === 'end' ? 'OK' : null,
    verifyDetails: null,
    ...extra,
  }));
}

const HAPPY: RowSpec[] = [
  ['caf-planner', 'start'],
  ['caf-planner', 'end'],
  ['caf-backend', 'start'],
  ['caf-backend', 'end'],
  ['caf-qa', 'start'],
  ['caf-qa', 'end'],
  ['caf-reviewer', 'start'],
  ['caf-reviewer', 'end'],
];

/** Compact, order-preserving view of a sequence for readable assertions. */
function summarize(events: FloorEvent[]): string[] {
  return events.map((e) => {
    switch (e.type) {
      case 'run_started':
        return `run_started#${e.attempt}`;
      case 'agent_state':
        return `state ${e.agent}=${e.state}`;
      case 'handoff':
        return `handoff ${e.from}>${e.to} ${e.file}`;
      case 'step':
        return `step ${e.step}=${e.status}${e.note ? ` (${e.note})` : ''}`;
      case 'usage':
        return `usage ${e.agent}`;
      case 'run_finished':
        return `run_finished#${e.attempt} ${e.finalStatus}`;
    }
  });
}

function expectStrictlyIncreasingCursors(events: FloorEvent[]): void {
  const keys = events.map((e) => parseCursor(e.cursor));
  expect(keys.every((k) => k !== undefined)).toBe(true);
  for (let i = 1; i < keys.length; i += 1) {
    const [prevRow, prevSub] = keys[i - 1]!;
    const [row, sub] = keys[i]!;
    expect(row > prevRow || (row === prevRow && sub > prevSub), `cursor ${events[i].cursor} after ${events[i - 1].cursor}`).toBe(true);
  }
}

describe('normalizeRun', () => {
  it('SUCCESS: full happy path in pipeline order, ending with the PR', () => {
    const run = makeRun({ finalStatus: 'SUCCESS', endedAt: at(90), prNumber: 118 });
    const events = normalizeRun(run, makeRows(HAPPY));

    expect(summarize(events)).toEqual([
      'run_started#1',
      'step plan=active',
      'state planner=planning',
      'usage planner',
      'step plan=pass (tasks.md)',
      'state planner=idle',
      'handoff planner>backend requirements.md',
      'handoff planner>backend tasks.md',
      'step impl=active',
      'state backend=implementing',
      'usage backend',
      'state backend=idle',
      'step impl=pass (verify-report.md)',
      'handoff backend>qa verify-report.md',
      'step qa=active',
      'state qa=verifying',
      'usage qa',
      'state qa=idle',
      'step qa=pass (qa-report.md)',
      'handoff qa>reviewer qa-report.md',
      'step review=active',
      'state reviewer=reviewing',
      'usage reviewer',
      'state reviewer=idle',
      'step review=pass',
      'handoff reviewer>outbox review-notes.md',
      'state reviewer=celebrating',
      'run_finished#1 SUCCESS',
      'step pr=pass (PR #118)',
    ]);
    expectStrictlyIncreasingCursors(events);

    expect(events[0]).toMatchObject({
      type: 'run_started',
      runId: 'ganjardbc/umkm-pos:GAN-1',
      ticket: 'GAN-1',
      repo: 'ganjardbc/umkm-pos',
      branch: 'ai-agent/GAN-1',
      startedAt: at(0),
    });
    expect(events.find((e) => e.type === 'run_finished')).toMatchObject({ gate: null, superseded: false, timestamp: at(90) });
    expect(events.at(-1)).toMatchObject({ type: 'step', step: 'pr', prNumber: 118 });
    expect(events.every((e) => typeof e.timestamp === 'string' && !Number.isNaN(Date.parse(e.timestamp)))).toBe(true);
  });

  it('usage carries the real cost and the start→end duration, and never invents tokens', () => {
    const events = normalizeRun(makeRun(), makeRows([['caf-planner', 'start'], ['caf-planner', 'end', { costUsd: 0.1133 }]]));
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ agent: 'planner', costUsd: 0.1133, durationMs: 10_000, tokens: null });
  });

  it('a run that is still going has no run_finished', () => {
    const events = normalizeRun(makeRun(), makeRows(HAPPY.slice(0, 3)));
    expect(events.some((e) => e.type === 'run_finished')).toBe(false);
    expect(summarize(events).at(-1)).toBe('state backend=implementing');
  });

  it('run without a PR: SUCCESS is reported and the pr step is never claimed', () => {
    const events = normalizeRun(makeRun({ finalStatus: 'SUCCESS', endedAt: at(90) }), makeRows(HAPPY));
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', finalStatus: 'SUCCESS' });
    expect(events.at(-1)).not.toHaveProperty('prNumber');
    expect(events.some((e) => e.type === 'step' && e.step === 'pr')).toBe(false);
  });

  describe('NEEDS_HUMAN', () => {
    it('implementation gate: the implementation agents are blocked and the verify report goes to the human', () => {
      const rows = makeRows([
        ['caf-planner', 'start'],
        ['caf-planner', 'end'],
        ['caf-frontend', 'start'],
        ['caf-frontend', 'end'],
        ['caf-backend', 'start'],
        ['caf-backend', 'end'],
        ['implementation-agents', 'gate_exhausted', { artifactLink: '.caf/tasks/GAN-1/verify-report.md' }],
      ]);
      const events = normalizeRun(makeRun({ finalStatus: 'NEEDS_HUMAN', endedAt: at(70), prNumber: 7 }), rows);

      expect(summarize(events).slice(-7)).toEqual([
        'state backend=idle',
        'step impl=fail (NEEDS_HUMAN)',
        'state frontend=blocked',
        'state backend=blocked',
        'handoff backend>human verify-report.md',
        'run_finished#1 NEEDS_HUMAN',
        'step pr=pass (Draft PR #7)',
      ]);
      expect(events.find((e) => e.type === 'run_finished')).toMatchObject({ gate: 'implementation' });
      // frontend hands its report to backend when both run
      expect(summarize(events)).toContain('handoff frontend>backend verify-report.md');
    });

    it('QA gate after its one retry: distinguishable from the implementation gate by `gate`', () => {
      const rows = makeRows([
        ['caf-planner', 'start'],
        ['caf-planner', 'end'],
        ['caf-backend', 'start'],
        ['caf-backend', 'end'],
        ['caf-qa', 'start'],
        ['caf-qa', 'end'],
        ['caf-qa', 'retry', { retryCount: 1 }],
        ['caf-backend', 'start'],
        ['caf-backend', 'end'],
        ['caf-qa', 'start'],
        ['caf-qa', 'end'],
        ['caf-qa', 'gate_exhausted', { artifactLink: '.caf/tasks/GAN-1/qa-report.md' }],
      ]);
      const events = normalizeRun(makeRun({ finalStatus: 'NEEDS_HUMAN', endedAt: at(120) }), rows, { retryLimits: { qa: 1 } });
      const summary = summarize(events);

      expect(summary.slice(summary.indexOf('usage qa') + 1, summary.indexOf('usage qa') + 7)).toEqual([
        'state qa=idle',
        'step qa=active (retry 1/1)',
        'state qa=retrying',
        'handoff qa>backend qa-report.md',
        'step impl=active',
        'state backend=implementing',
      ]);
      expect(events.find((e) => e.type === 'agent_state' && e.state === 'retrying')).toMatchObject({
        agent: 'qa',
        gate: 'qa',
        retry: { count: 1, max: 1 },
      });
      expect(summary.slice(-4)).toEqual([
        'step qa=fail (NEEDS_HUMAN)',
        'state qa=blocked',
        'handoff qa>human qa-report.md',
        'run_finished#1 NEEDS_HUMAN',
      ]);
      expect(events.find((e) => e.type === 'run_finished')).toMatchObject({ gate: 'qa' });
    });

    it('reviewer gate: retry limit unknown is reported as null, never assumed', () => {
      const rows = makeRows([
        ...HAPPY,
        ['caf-reviewer', 'retry', { retryCount: 1 }],
        ['caf-backend', 'start'],
        ['caf-backend', 'end'],
        ['caf-reviewer', 'start'],
        ['caf-reviewer', 'end'],
        ['caf-reviewer', 'gate_exhausted', { artifactLink: '.caf/tasks/GAN-1/review-notes.md' }],
      ]);
      const events = normalizeRun(makeRun({ finalStatus: 'NEEDS_HUMAN', endedAt: at(200) }), rows);
      const summary = summarize(events);

      expect(events.find((e) => e.type === 'agent_state' && e.state === 'retrying')).toMatchObject({
        agent: 'reviewer',
        gate: 'reviewer',
        retry: { count: 1, max: null },
      });
      expect(summary).toContain('step review=active (retry 1/?)');
      expect(summary).toContain('handoff reviewer>backend review-notes.md');
      expect(summary).toContain('handoff backend>reviewer verify-report.md');
      expect(summary.slice(-4)).toEqual([
        'step review=fail (NEEDS_HUMAN)',
        'state reviewer=blocked',
        'handoff reviewer>human review-notes.md',
        'run_finished#1 NEEDS_HUMAN',
      ]);
    });

    it('a stop with no gate_exhausted row (retry budget, 429, dirty workspace…) reports gate null instead of guessing one', () => {
      const events = normalizeRun(makeRun({ finalStatus: 'NEEDS_HUMAN', endedAt: at(5) }), []);
      expect(summarize(events)).toEqual(['run_started#1', 'run_finished#1 NEEDS_HUMAN']);
      expect(events[1]).toMatchObject({ gate: null });
      expect(events.some((e) => e.type === 'agent_state' && e.state === 'blocked')).toBe(false);
    });
  });

  describe('ERROR', () => {
    it('points at the agent whose process failed, with its outcome', () => {
      const rows = makeRows([
        ['caf-planner', 'start'],
        ['caf-planner', 'end'],
        ['caf-backend', 'start'],
        ['caf-backend', 'end', { outcome: 'TIMEOUT', exitCode: null }],
      ]);
      const events = normalizeRun(makeRun({ finalStatus: 'ERROR', endedAt: at(41) }), rows);

      expect(summarize(events).slice(-4)).toEqual([
        'usage backend',
        'step impl=fail (TIMEOUT)',
        'state backend=error',
        'run_finished#1 ERROR',
      ]);
      expect(events.find((e) => e.type === 'agent_state' && e.state === 'error')).toMatchObject({ agent: 'backend', outcome: 'TIMEOUT' });
    });

    it('marks an agent that started and never returned', () => {
      const events = normalizeRun(makeRun({ finalStatus: 'ERROR', endedAt: at(35) }), makeRows(HAPPY.slice(0, 3)));
      expect(summarize(events).slice(-2)).toEqual(['state backend=error', 'run_finished#1 ERROR']);
    });

    it('an ERROR that replaces an already-reported SUCCESS still arrives as new events for a live client', () => {
      const rows = makeRows(HAPPY);
      const asSuccess = normalizeRun(makeRun({ finalStatus: 'SUCCESS', endedAt: at(90) }), rows);
      const asError = normalizeRun(makeRun({ finalStatus: 'ERROR', endedAt: at(95) }), rows);

      const lastSeen = asSuccess.at(-1)!.cursor;
      expect(summarize(eventsAfter(asError, lastSeen))).toEqual(['run_finished#1 ERROR']);
      expectStrictlyIncreasingCursors(asError);
    });
  });

  describe('implementation verify attempts 1–3 (read from verify-report.md)', () => {
    const checks = { lint: 'pass', typecheck: 'pass', test: 'pass' } as const;

    it.each([1, 2, 3])('attempt %i/3 is passed through on the implementation agent\'s end', (n) => {
      const rows = makeRows([
        ['caf-backend', 'start'],
        ['caf-backend', 'end', { verifyDetails: { attempt: n, maxAttempts: 3, checks } }],
      ]);
      const done = normalizeRun(makeRun(), rows).find((e) => e.type === 'agent_state' && e.state === 'idle');
      expect(done).toMatchObject({ agent: 'backend', verify: { attempt: n, maxAttempts: 3, checks } });
    });

    it('omits `verify` entirely when the report could not be read — no "n/3" is made up', () => {
      const done = normalizeRun(makeRun(), makeRows([['caf-backend', 'start'], ['caf-backend', 'end']])).find(
        (e) => e.type === 'agent_state' && e.state === 'idle',
      );
      expect(done).toBeDefined();
      expect(done).not.toHaveProperty('verify');
    });
  });

  describe('attempts', () => {
    const failedFirst: RowSpec[] = [
      ['caf-planner', 'start'],
      ['caf-planner', 'end'],
      ['caf-backend', 'start'],
      ['caf-backend', 'end', { outcome: 'FAILED', exitCode: 1 }],
    ];
    const rows = makeRows([...failedFirst, ...HAPPY.map(([a, t]): RowSpec => [a, t, { attempt: 2 }])]);

    it('separates attempts with their own run_started / run_finished, in order', () => {
      const events = normalizeRun(makeRun({ attempt: 2, finalStatus: 'SUCCESS', endedAt: at(130), prNumber: 9 }), rows);
      const markers = summarize(events).filter((line) => line.startsWith('run_'));

      expect(markers).toEqual(['run_started#1', 'run_finished#1 null', 'run_started#2', 'run_finished#2 SUCCESS']);
      expect(events.filter((e) => e.type === 'run_finished')).toEqual([
        expect.objectContaining({ attempt: 1, superseded: true, finalStatus: null }),
        expect.objectContaining({ attempt: 2, superseded: false, finalStatus: 'SUCCESS' }),
      ]);
      expect(events.every((e) => e.attempt === 1 || e.attempt === 2)).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'step', step: 'pr', attempt: 2, prNumber: 9 });
      expectStrictlyIncreasingCursors(events);
    });

    it('a superseded attempt that ended at a gate is NEEDS_HUMAN (the gate row says so); a resume skips the planner', () => {
      const resumed = makeRows([
        ['caf-backend', 'start'],
        ['caf-backend', 'end'],
        ['implementation-agents', 'gate_exhausted', { artifactLink: '.caf/tasks/GAN-1/verify-report.md' }],
        ['caf-backend', 'start', { attempt: 2 }],
      ]);
      const events = normalizeRun(makeRun({ attempt: 2 }), resumed);

      expect(events.find((e) => e.type === 'run_finished')).toMatchObject({ attempt: 1, finalStatus: 'NEEDS_HUMAN', gate: 'implementation', superseded: true });
      expect(summarize(events).slice(-3)).toEqual(['run_started#2', 'step impl=active', 'state backend=implementing']);
    });

    it('attempts that wrote no rows still get distinct, ordered cursors', () => {
      const events = normalizeRun(makeRun({ attempt: 3, finalStatus: 'NEEDS_HUMAN', endedAt: at(5) }), []);
      expect(summarize(events)).toEqual([
        'run_started#1',
        'run_finished#1 null',
        'run_started#2',
        'run_finished#2 null',
        'run_started#3',
        'run_finished#3 NEEDS_HUMAN',
      ]);
      expectStrictlyIncreasingCursors(events);
    });

    it('rows written before attempts were recorded (attempt null) all count as attempt 1', () => {
      const legacy = makeRows(HAPPY.map(([a, t]): RowSpec => [a, t, { attempt: null, outcome: null, exitCode: null }]));
      const events = normalizeRun(makeRun({ attempt: null, finalStatus: 'SUCCESS', endedAt: at(90) }), legacy);

      expect(events.every((e) => e.attempt === 1)).toBe(true);
      expect(summarize(events).filter((line) => line.startsWith('run_'))).toEqual(['run_started#1', 'run_finished#1 SUCCESS']);
      expect(events.some((e) => e.type === 'agent_state' && e.state === 'error')).toBe(false);
    });
  });

  it('multi-repo: two runs for the same ticket key stay separate — every event names its own run and repo', () => {
    const umkm = normalizeRun(makeRun(), makeRows(HAPPY.slice(0, 2)));
    const coderium = normalizeRun(
      makeRun({ id: 'ganjardbc/coderium-web-v2:GAN-1', repoId: 'ganjardbc/coderium-web-v2' }),
      makeRows(HAPPY.slice(0, 2), 'ganjardbc/coderium-web-v2:GAN-1'),
    );

    expect(new Set(umkm.map((e) => e.runId))).toEqual(new Set(['ganjardbc/umkm-pos:GAN-1']));
    expect(new Set(coderium.map((e) => e.runId))).toEqual(new Set(['ganjardbc/coderium-web-v2:GAN-1']));
    expect(umkm[0]).toMatchObject({ repo: 'ganjardbc/umkm-pos' });
    expect(coderium[0]).toMatchObject({ repo: 'ganjardbc/coderium-web-v2' });
  });

  it('ignores rows from an agent it does not know (never caf-documentation, which writes none)', () => {
    const events = normalizeRun(makeRun(), makeRows([['caf-documentation', 'start'], ['caf-documentation', 'end']]));
    expect(summarize(events)).toEqual(['run_started#1']);
  });

  describe('live and replay agree', () => {
    const rows = makeRows([
      ...HAPPY.slice(0, 6),
      ['caf-qa', 'retry', { retryCount: 1 }],
      ['caf-backend', 'start'],
      ['caf-backend', 'end'],
      ['caf-qa', 'start'],
      ['caf-qa', 'end'],
      ['caf-reviewer', 'start'],
      ['caf-reviewer', 'end'],
    ]);
    const finished = makeRun({ finalStatus: 'SUCCESS', endedAt: at(140), prNumber: 12 });
    const replay = normalizeRun(finished, rows);

    it('is deterministic and does not mutate its input', () => {
      const frozenRows = JSON.stringify(rows);
      expect(normalizeRun(finished, rows)).toEqual(replay);
      expect(JSON.stringify(rows)).toBe(frozenRows);
    });

    it('every in-flight prefix is a prefix of the finished sequence (append-only)', () => {
      for (let n = 0; n <= rows.length; n += 1) {
        const live = normalizeRun(makeRun(), rows.slice(0, n));
        expect(live).toEqual(replay.slice(0, live.length));
      }
    });

    it('polling row by row with the last cursor yields the replay sequence exactly once', () => {
      const seen: FloorEvent[] = [];
      let cursor: string | undefined;
      const poll = (run: PipelineRun, upTo: number): void => {
        const fresh = eventsAfter(normalizeRun(run, rows.slice(0, upTo)), cursor);
        seen.push(...fresh);
        cursor = seen.at(-1)?.cursor ?? cursor;
      };

      for (let n = 0; n <= rows.length; n += 1) {
        poll(makeRun(), n);
        poll(makeRun(), n); // a reconnect asking again must add nothing
      }
      poll(makeRun({ finalStatus: 'SUCCESS', endedAt: at(140) }), rows.length); // finalized, PR not yet recorded
      poll(finished, rows.length);
      poll(finished, rows.length);

      expect(seen).toEqual(replay);
      expect(new Set(seen.map((e) => e.cursor)).size).toBe(seen.length);
    });
  });

  it('eventsAfter returns everything for no cursor and nothing past the end', () => {
    const events = normalizeRun(makeRun({ finalStatus: 'SUCCESS', endedAt: at(90) }), makeRows(HAPPY));
    expect(eventsAfter(events, undefined)).toEqual(events);
    expect(eventsAfter(events, events.at(-1)!.cursor)).toEqual([]);
    expect(eventsAfter(events, events[0].cursor)).toEqual(events.slice(1));
  });

  it('parseCursor rejects anything that is not one of its own cursors', () => {
    expect(parseCursor('12.3')).toEqual([12, 3]);
    for (const bad of ['', '12', 'abc', '1.2.3', '-1.0', '1.x']) expect(parseCursor(bad)).toBeUndefined();
  });
});
