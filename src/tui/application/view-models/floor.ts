import type { FloorAgent, FloorAgentState, FloorEvent, FloorStep } from '../../../presentation/web/agent-floor/event-normalizer.js';
import type { VerifyDetails } from '../../../infrastructure/reports/verify-report-details.js';

/**
 * Pure fold of a run's normalized floor events into what the TUI's Agent Floor
 * draws — the same information as the web Agent Floor (agent desks, step
 * ladder, Manager bubble, event log), minus the pixel art. Mirrors the
 * semantics of ui/agent-floor/translate.js; no blessed, no I/O.
 */

export type DeskId = FloorAgent | 'human';
export const DESKS: readonly DeskId[] = ['planner', 'frontend', 'backend', 'qa', 'reviewer', 'human'];

export const DESK_NAME: Record<DeskId, string> = {
  planner: 'Planner',
  frontend: 'Frontend',
  backend: 'Backend',
  qa: 'Validator',
  reviewer: 'Reviewer',
  human: 'Manager',
};

export type Tone = 'info' | 'ok' | 'warn' | 'bad';

export interface DeskView {
  id: DeskId;
  name: string;
  state: FloorAgentState | 'alert';
  /** Human text for the state, e.g. "Testing", "Rejected, retry 1/2". */
  text: string;
  tone: Tone;
  costUsd: number | null;
  durationMs: number | null;
  verify: VerifyDetails | null;
  /** True while the agent process is running — the only state the UI animates. */
  working: boolean;
}

export type StepStatus = 'pending' | 'active' | 'pass' | 'fail';
export interface StepView {
  step: FloorStep;
  status: StepStatus;
  note: string;
}

export interface FeedLine {
  tone: Tone;
  /** ms since the attempt started. */
  atMs: number;
  text: string;
}

export type RunPhase = 'run' | 'success' | 'needs' | 'waiting' | 'error';

export interface FloorView {
  title: string;
  meta: string;
  startedAt: string | null;
  phase: RunPhase;
  pill: string;
  desks: DeskView[];
  steps: StepView[];
  /** 0..1 — share of steps passed. */
  progress: number;
  lastHandoff: { from: DeskId; to: DeskId | 'outbox'; file: string } | null;
  ac: { pass: number; fail: number; unverified: number; total: number; allUnverified: boolean } | null;
  feed: FeedLine[];
  isReview: boolean;
}

const WORK_TEXT: Partial<Record<FloorAgentState, string>> = {
  planning: 'Planning',
  implementing: 'Implementing',
  verifying: 'Testing',
  reviewing: 'Reviewing',
  fixing: 'Fixing review',
};
const WORKING: ReadonlySet<string> = new Set(['planning', 'implementing', 'verifying', 'reviewing', 'fixing']);
const GATE_NAME = { implementation: 'implementation', qa: 'Validator', reviewer: 'Reviewer' } as const;
const WAITING_TEXT = {
  clarify: { pill: 'Waiting for answers', bubble: 'Need your answers', log: 'Spec needs clarification: answer the BLOCKING questions on the ticket, then trigger it again' },
  'spec-approval': { pill: 'Waiting for spec approval', bubble: 'Approve the spec', log: 'Spec awaiting approval: comment /caf-approve-spec on the Draft PR' },
} as const;

const DEFAULT_STEPS: readonly FloorStep[] = ['plan', 'impl', 'qa', 'review', 'pr'];
const MAX_FEED = 200;

function blankDesk(id: DeskId): DeskView {
  return { id, name: DESK_NAME[id], state: 'idle', text: 'Idle', tone: 'info', costUsd: null, durationMs: null, verify: null, working: false };
}

function attemptText(v: VerifyDetails): string {
  if (v.attempt === null) return '';
  return `${v.attempt}${v.maxAttempts ? `/${v.maxAttempts}` : ''}`;
}

export function checksText(v: VerifyDetails): string {
  const parts: string[] = [];
  for (const k of ['lint', 'typecheck', 'test'] as const) {
    if (v.checks[k] === 'pass') parts.push(`${k} ✔`);
    else if (v.checks[k] === 'fail') parts.push(`${k} ✘`);
  }
  return parts.join(' ');
}

function prText(n: number | null | undefined): string {
  return n ? `PR #${n}` : 'the PR';
}

/** Folds events (chronological, as returned by normalizeRun) into the view. Safe on an empty list. */
export function buildFloor(events: readonly FloorEvent[]): FloorView {
  let desks = new Map<DeskId, DeskView>(DESKS.map((d) => [d, blankDesk(d)]));
  let steps = new Map<FloorStep, StepView>();
  let feed: FeedLine[] = [];
  let title = '';
  let meta = '';
  let startedAt: string | null = null;
  let startMs = 0;
  let phase: RunPhase = 'run';
  let pill = 'Waiting for a run';
  let lastHandoff: FloorView['lastHandoff'] = null;
  let ac: FloorView['ac'] = null;
  let isReview = false;
  let waiting: keyof typeof WAITING_TEXT | null = null;

  const at = (ts: string) => Math.max(0, Date.parse(ts) - startMs);
  const log = (tone: Tone, ts: string, text: string) => {
    feed.push({ tone, atMs: at(ts), text });
    if (feed.length > MAX_FEED) feed = feed.slice(-MAX_FEED);
  };
  const desk = (id: DeskId) => desks.get(id)!;
  const setDesk = (id: DeskId, patch: Partial<DeskView>) => desks.set(id, { ...desk(id), ...patch });

  for (const e of events) {
    switch (e.type) {
      case 'run_started': {
        // A new attempt starts from a clean floor, like the web page's reset().
        desks = new Map(DESKS.map((d) => [d, blankDesk(d)]));
        steps = new Map();
        lastHandoff = null;
        ac = null;
        waiting = null;
        isReview = e.kind === 'pr-review';
        startMs = Date.parse(e.startedAt);
        startedAt = e.startedAt;
        title = `${e.ticket}  ${e.ticketTitle}`;
        meta = isReview
          ? `${e.reviewMode === 'initial' ? 'Review' : `Fix review (${e.reviewMode})`} of ${prText(e.prNumber)} · ${e.repo}`
          : `${e.repo} · ${e.branch}`;
        if (e.attempt > 1) meta += ` · attempt ${e.attempt}`;
        phase = 'run';
        pill = 'Running';
        if (isReview) steps.set('review', { step: 'review', status: 'pending', note: '' });
        log('info', e.timestamp, e.attempt > 1 ? `Run restarted, attempt ${e.attempt}` : `Run started, branch ${e.branch}`);
        break;
      }
      case 'agent_state': {
        const name = DESK_NAME[e.agent];
        if (WORKING.has(e.state)) {
          setDesk(e.agent, { state: e.state, text: WORK_TEXT[e.state] ?? e.state, tone: 'info', working: true });
        } else if (e.state === 'retrying') {
          const r = e.retry ?? { count: 1, max: null };
          const rt = `retry ${r.count}/${r.max ?? '?'}`;
          setDesk(e.agent, { state: 'retrying', text: `Rejected, ${rt}`, tone: 'warn', working: false });
          log('warn', e.timestamp, `${name}: ${e.gate ? GATE_NAME[e.gate] : 'gate'} gate rejected, ${rt}`);
        } else if (e.state === 'blocked') {
          setDesk(e.agent, { state: 'blocked', text: 'Need Manager', tone: 'bad', working: false });
          log('bad', e.timestamp, `${name}: NEEDS_HUMAN at the ${e.gate ? GATE_NAME[e.gate] : 'unknown'} gate`);
        } else if (e.state === 'error') {
          setDesk(e.agent, { state: 'error', text: `Error${e.outcome ? `: ${e.outcome}` : ''}`, tone: 'bad', working: false });
          log('bad', e.timestamp, `${name}: agent process failed${e.outcome ? ` (${e.outcome})` : ''}`);
        } else if (e.state === 'celebrating') {
          setDesk(e.agent, { state: 'celebrating', text: 'Done', tone: 'ok', working: false });
        } else if (e.state === 'idle') {
          setDesk(e.agent, { state: 'idle', text: 'Idle', tone: 'info', working: false, verify: e.verify ?? desk(e.agent).verify });
          if (e.verify) {
            const bits = [attemptText(e.verify) && `attempt ${attemptText(e.verify)}`, checksText(e.verify)].filter(Boolean);
            if (bits.length) log('info', e.timestamp, `${name}: verify ${bits.join(', ')}`);
          }
        } else {
          setDesk(e.agent, { state: e.state, text: e.state === 'offduty' ? 'Off duty' : e.state, tone: 'info', working: false });
        }
        break;
      }
      case 'handoff':
        lastHandoff = { from: e.from, to: e.to === 'human' ? 'human' : e.to, file: e.file };
        break;
      case 'step': {
        steps.set(e.step, { step: e.step, status: e.status, note: e.note ?? '' });
        if (e.step === 'spec' && e.note && e.note in WAITING_TEXT) log('warn', e.timestamp, WAITING_TEXT[e.note as keyof typeof WAITING_TEXT].log);
        if (e.step === 'pr' && e.status === 'pass') {
          log('ok', e.timestamp, `${e.note ?? 'PR'} opened`);
          if (/^PR /.test(e.note ?? '')) setDesk('human', { state: 'alert', text: `${e.note}, ready for review`, tone: 'ok' });
          else if (waiting) setDesk('human', { state: 'alert', text: `${e.note} holds the spec`, tone: 'warn' });
          else setDesk('human', { state: 'alert', text: `${e.note} waiting`, tone: 'bad' });
        }
        break;
      }
      case 'usage': {
        setDesk(e.agent, { costUsd: e.costUsd, durationMs: e.durationMs });
        const bits = [e.costUsd !== null && `$${e.costUsd.toFixed(4)}`, e.durationMs !== null && `${Math.round(e.durationMs / 1000)} s`].filter(Boolean);
        log('info', e.timestamp, `${DESK_NAME[e.agent]}: finished${bits.length ? ` (${bits.join(', ')})` : ''}`);
        break;
      }
      case 'run_finished': {
        for (const d of desks.values()) if (d.working) setDesk(d.id, { working: false });
        if (e.acSummary) {
          ac = e.acSummary;
          log(
            e.acSummary.allUnverified ? 'warn' : e.acSummary.fail ? 'bad' : 'ok',
            e.timestamp,
            `Criteria: ${e.acSummary.pass} pass, ${e.acSummary.fail} fail, ${e.acSummary.unverified} unverified${e.acSummary.allUnverified ? ', none proven, a PASS does not count' : ''}`,
          );
        }
        if (e.waitingFor && e.finalStatus === 'NEEDS_HUMAN') {
          waiting = e.waitingFor;
          phase = 'waiting';
          pill = WAITING_TEXT[e.waitingFor].pill;
          setDesk('human', { state: 'alert', text: WAITING_TEXT[e.waitingFor].bubble, tone: 'warn' });
          log('warn', e.timestamp, 'final_status: NEEDS_HUMAN (waiting, not failed)');
        } else if (e.review && e.finalStatus === 'SUCCESS') {
          phase = 'success';
          const res = e.review.result;
          const fix = e.review.mode === 'global' || e.review.mode === 'scoped';
          pill = fix ? 'Fix review posted' : 'Review posted';
          const pr = prText(e.review.prNumber);
          if (res?.type === 'verdict') {
            const posted = res.postedAsComment ? ' (posted as COMMENT)' : '';
            if (res.verdict === 'APPROVE') {
              setDesk('human', { state: 'alert', text: `${pr} approved`, tone: 'ok' });
              log('ok', e.timestamp, `Verdict: APPROVE${posted}`);
            } else {
              const deferred = res.verdict === 'DEFER';
              setDesk('reviewer', { state: 'blocked', text: deferred ? 'Deferred to Manager' : 'Changes requested', tone: 'warn' });
              setDesk('human', { state: 'alert', text: `${deferred ? 'Review deferred on' : 'Changes requested on'} ${pr}`, tone: 'bad' });
              log('warn', e.timestamp, `Verdict: ${res.verdict.replace('_', ' ')}${posted}`);
            }
          } else if (res?.type === 'fix') {
            setDesk('human', { state: 'alert', text: `Fix review posted on ${pr}`, tone: 'ok' });
            log('ok', e.timestamp, `Fix review: ${res.fixed} fixed, ${res.skipped} skipped, ${res.notApplicable} n/a`);
          } else {
            setDesk('human', { state: 'alert', text: 'Review finished', tone: 'ok' });
          }
          log('ok', e.timestamp, 'final_status: SUCCESS');
        } else if (e.finalStatus === 'SUCCESS') {
          phase = 'success';
          pill = 'Success';
          setDesk('human', { state: 'alert', text: 'Run finished', tone: 'ok' });
          log('ok', e.timestamp, 'final_status: SUCCESS');
        } else if (e.finalStatus === 'NEEDS_HUMAN') {
          phase = 'needs';
          pill = 'Needs a human';
          setDesk('human', { state: 'alert', text: 'Something needs a look', tone: 'bad' });
          log('bad', e.timestamp, `final_status: NEEDS_HUMAN${e.gate ? ` (${GATE_NAME[e.gate]} gate)` : ''}`);
        } else if (e.finalStatus === 'ERROR') {
          phase = 'error';
          pill = 'Error';
          log('bad', e.timestamp, 'final_status: ERROR, BullMQ may retry the job');
        } else {
          log('warn', e.timestamp, `Attempt ${e.attempt} ended, its final status was not recorded`);
        }
        break;
      }
    }
  }

  // Agents that never got work on a finished run are off duty; on a live run they are just waiting.
  const finished = phase !== 'run';
  const deskList = DESKS.map((id) => {
    const d = desk(id);
    if (finished && id !== 'human' && d.state === 'idle' && d.costUsd === null) return { ...d, state: 'offduty' as const, text: 'Off duty' };
    return d;
  });

  const seen = new Set(steps.keys());
  const order: FloorStep[] = isReview ? ['review'] : seen.has('spec') ? ['plan', 'spec', 'impl', 'qa', 'review', 'pr'] : [...DEFAULT_STEPS];
  const stepList: StepView[] = order.map((s) => steps.get(s) ?? { step: s, status: 'pending', note: '' });
  const passed = stepList.filter((s) => s.status === 'pass').length;

  return {
    title,
    meta,
    startedAt,
    phase,
    pill,
    desks: deskList,
    steps: stepList,
    progress: stepList.length === 0 ? 0 : passed / stepList.length,
    lastHandoff,
    ac,
    feed,
    isReview,
  };
}
