import type { AgentEvent, AgentOutcome, PipelineRun } from '../../../infrastructure/db/pipeline-run.repository.js';
import type { VerifyDetails } from '../../../infrastructure/reports/verify-report-details.js';

/**
 * CAF-DASHBOARD-02 T2: turns one pipeline_runs row plus its agent_events into
 * the contract events of requirements.md section 7. Pure — no I/O, no clock,
 * no config import — so the live path (new rows arriving) and the replay path
 * (a finished run read back) go through exactly the same code and produce
 * exactly the same sequence for the same rows.
 *
 * The sequence is append-only: rows added later only ever add events at the
 * end, so a client that remembers the cursor of the last event it handled can
 * ask for "everything after this" and never see an event twice.
 *
 * Nothing here is inferred beyond what the rows state, with two exceptions
 * that are marked in the output: handoffs (derived from the order agents ran
 * in — the pipeline doesn't record them) and the final status of a superseded
 * attempt (pipeline_runs only keeps the latest attempt's status; see
 * `superseded` on RunFinishedEvent).
 */

export type FloorAgent = 'planner' | 'frontend' | 'backend' | 'qa' | 'reviewer';
export type FloorAgentState =
  | 'idle'
  | 'planning'
  | 'implementing'
  | 'verifying'
  | 'retrying'
  | 'reviewing'
  | 'celebrating'
  | 'blocked'
  | 'error'
  | 'offduty';
export type FloorStep = 'plan' | 'impl' | 'qa' | 'review' | 'pr';
export type FloorStepStatus = 'active' | 'pass' | 'fail';
export type FloorGate = 'implementation' | 'qa' | 'reviewer';
export type FloorFinalStatus = 'SUCCESS' | 'NEEDS_HUMAN' | 'ERROR';

interface FloorEventBase {
  /** Opaque, strictly increasing position of this event within its run. Pass the last one seen back as `after`. */
  cursor: string;
  runId: string;
  /** 1-based attempt this event belongs to. Rows written before attempts were recorded all count as attempt 1. */
  attempt: number;
  /** Server-side time of the underlying write (ISO 8601). */
  timestamp: string;
}

export interface RunStartedEvent extends FloorEventBase {
  type: 'run_started';
  ticket: string;
  ticketTitle: string;
  repo: string;
  branch: string;
  startedAt: string;
}

export interface AgentStateEvent extends FloorEventBase {
  type: 'agent_state';
  agent: FloorAgent;
  state: FloorAgentState;
  /** Set on `retrying`/`blocked`: which gate, and for a retry its counter and configured limit (null if the limit isn't known). */
  gate?: FloorGate;
  retry?: { count: number; max: number | null };
  /** Set when an implementation agent finishes and its verify-report.md could be read. */
  verify?: VerifyDetails;
  /** Set on `error`: how the agent process ended. */
  outcome?: AgentOutcome;
}

export interface HandoffEvent extends FloorEventBase {
  type: 'handoff';
  from: FloorAgent;
  to: FloorAgent | 'human' | 'outbox';
  file: string;
}

export interface StepEvent extends FloorEventBase {
  type: 'step';
  step: FloorStep;
  status: FloorStepStatus;
  note?: string;
  prNumber?: number;
}

export interface UsageEvent extends FloorEventBase {
  type: 'usage';
  agent: FloorAgent;
  costUsd: number | null;
  /** Always null for now: token counts are not stored (deferred, see audit.md G1). */
  tokens: number | null;
  durationMs: number | null;
}

/**
 * Deliberately has no `prNumber`: the pipeline records the PR only after it
 * has finalized the run, so a live client would see this event without the
 * number and a replay would see it with one. The PR is reported by the
 * `step` event for `pr` that follows instead (see StepEvent.prNumber), which
 * only exists once the number does — identical live and on replay.
 */
export interface RunFinishedEvent extends FloorEventBase {
  type: 'run_finished';
  /** Null only for a superseded attempt whose status was overwritten by the next attempt and can't be recovered. */
  finalStatus: FloorFinalStatus | null;
  /** The gate that stopped the run, when a gate_exhausted row says so. Null for any other stop. */
  gate: FloorGate | null;
  /** True when a later attempt exists — this attempt's end is reconstructed, not read from pipeline_runs. */
  superseded: boolean;
}

export type FloorEvent = RunStartedEvent | AgentStateEvent | HandoffEvent | StepEvent | UsageEvent | RunFinishedEvent;

export interface NormalizeOptions {
  /** Configured retry limit per gate (agents.qa.maxRetries / agents.reviewer.maxRetries), if known. */
  retryLimits?: { qa?: number | null; reviewer?: number | null };
}

const AGENT_BY_NAME: Record<string, FloorAgent> = {
  'caf-planner': 'planner',
  'caf-frontend': 'frontend',
  'caf-backend': 'backend',
  'caf-qa': 'qa',
  'caf-reviewer': 'reviewer',
};

const STEP_OF: Record<FloorAgent, FloorStep> = {
  planner: 'plan',
  frontend: 'impl',
  backend: 'impl',
  qa: 'qa',
  reviewer: 'review',
};

const RUNNING_STATE: Record<FloorAgent, FloorAgentState> = {
  planner: 'planning',
  frontend: 'implementing',
  backend: 'implementing',
  qa: 'verifying',
  reviewer: 'reviewing',
};

const GATE_BY_AGENT_NAME: Record<string, FloorGate> = {
  'implementation-agents': 'implementation',
  'caf-qa': 'qa',
  'caf-reviewer': 'reviewer',
};

/** The report each agent leaves behind — what travels to the PR box when that agent was the last to run. */
const OUTPUT_FILE: Record<FloorAgent, string> = {
  planner: 'tasks.md',
  frontend: 'verify-report.md',
  backend: 'verify-report.md',
  qa: 'qa-report.md',
  reviewer: 'review-notes.md',
};

const GATE_STEP: Record<FloorGate, FloorStep> = { implementation: 'impl', qa: 'qa', reviewer: 'review' };
const GATE_ARTIFACT: Record<FloorGate, string> = {
  implementation: 'verify-report.md',
  qa: 'qa-report.md',
  reviewer: 'review-notes.md',
};

// Sub-positions for the events that have no agent_events row of their own:
// the start of an attempt, the events that close it, its run_finished, and
// its PR. Row-derived events use 0, 1, 2, ... on their own row; these sit
// after all of them and grow with the attempt number, so "end of attempt N"
// always sorts before "start of attempt N+1" even when both are anchored to
// the same row (an attempt that wrote no rows at all).
const SYNTHETIC_BASE = 1000;
const SYNTHETIC_SPAN = 100;
const START_SLOT = 0;
const CLOSING_SLOT = 1;
const FINISHED_SLOT = 80;
const PR_SLOT = 81;
// An attempt can be finalized SUCCESS and then ERROR (the commit/push/PR step
// after the SUCCESS write throws). The ERROR ending gets later positions than
// the SUCCESS one, so a live client that already consumed the SUCCESS ending
// still receives the ERROR as something new instead of never hearing of it.
const ERROR_CLOSING_SLOT = 90;
const ERROR_FINISHED_SLOT = 99;
const syntheticSub = (attempt: number, slot: number): number => SYNTHETIC_BASE + attempt * SYNTHETIC_SPAN + slot;

const CURSOR_PATTERN = /^(\d+)\.(\d+)$/;

/** Parses a cursor produced by this module. Undefined for anything else. */
export function parseCursor(cursor: string): [rowId: number, sub: number] | undefined {
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2])];
}

function compareCursors(a: string, b: string): number {
  const [aRow, aSub] = parseCursor(a) ?? [0, 0];
  const [bRow, bSub] = parseCursor(b) ?? [0, 0];
  return aRow - bRow || aSub - bSub;
}

/** The events strictly after `after`, in order. `after` undefined returns everything. */
export function eventsAfter(events: FloorEvent[], after: string | undefined): FloorEvent[] {
  if (after === undefined) return events;
  return events.filter((event) => compareCursors(event.cursor, after) > 0);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function isFinalStatus(value: string | null): value is FloorFinalStatus {
  return value === 'SUCCESS' || value === 'NEEDS_HUMAN' || value === 'ERROR';
}

/** State carried across the rows of one attempt. */
interface AttemptState {
  startedAtByAgent: Map<FloorAgent, string>;
  /** Agents with a `start` row and no `end` row yet. */
  running: Set<FloorAgent>;
  /** The agent whose `end` row came last — the sender of the next handoff. */
  lastEnded: FloorAgent | null;
  /** Implementation agents that ran in the current implementation round. */
  implRound: FloorAgent[];
  /** A gate retry was just recorded; the next implementation agent receives that gate's report. */
  pendingRetry: FloorGate | null;
  stepStatus: Partial<Record<FloorStep, FloorStepStatus>>;
  exhaustedGate: FloorGate | null;
}

function newAttemptState(): AttemptState {
  return {
    startedAtByAgent: new Map(),
    running: new Set(),
    lastEnded: null,
    implRound: [],
    pendingRetry: null,
    stepStatus: {},
    exhaustedGate: null,
  };
}

export function normalizeRun(run: PipelineRun, rows: AgentEvent[], options: NormalizeOptions = {}): FloorEvent[] {
  const out: FloorEvent[] = [];
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const currentAttempt = Math.max(run.attempt ?? 1, ...sorted.map((row) => row.attempt ?? 1));
  const branch = `ai-agent/${run.ticketId}`;

  let lastRowId = 0;
  let lastTimestamp = run.startedAt;

  for (let attempt = 1; attempt <= currentAttempt; attempt += 1) {
    const attemptRows = sorted.filter((row) => (row.attempt ?? 1) === attempt);
    const state = newAttemptState();
    const base = { runId: run.id, attempt };

    const startedAt = attempt === 1 ? run.startedAt : (attemptRows[0]?.createdAt ?? lastTimestamp);
    out.push({
      ...base,
      type: 'run_started',
      cursor: `${lastRowId}.${syntheticSub(attempt, START_SLOT)}`,
      timestamp: startedAt,
      ticket: run.ticketId,
      ticketTitle: run.ticketTitle,
      repo: run.repoId,
      branch,
      startedAt,
    });
    lastTimestamp = startedAt;

    for (const row of attemptRows) {
      let sub = 0;
      const at = { ...base, timestamp: row.createdAt };
      const nextCursor = (): string => `${row.id}.${sub++}`;
      const setStep = (step: FloorStep, status: FloorStepStatus, note?: string): void => {
        state.stepStatus[step] = status;
        out.push({ ...at, type: 'step', cursor: nextCursor(), step, status, ...(note === undefined ? {} : { note }) });
      };
      const passIfActive = (step: FloorStep, note?: string): void => {
        if (state.stepStatus[step] === 'active') setStep(step, 'pass', note);
      };
      const handoff = (from: FloorAgent, to: HandoffEvent['to'], file: string): void => {
        out.push({ ...at, type: 'handoff', cursor: nextCursor(), from, to, file });
      };

      lastRowId = row.id;
      lastTimestamp = row.createdAt;

      if (row.eventType === 'gate_exhausted') {
        const gate = GATE_BY_AGENT_NAME[row.agentName];
        if (!gate) continue;
        state.exhaustedGate = gate;
        const blocked: FloorAgent[] =
          gate === 'implementation' ? state.implRound : [gate === 'qa' ? 'qa' : 'reviewer'];
        setStep(GATE_STEP[gate], 'fail', 'NEEDS_HUMAN');
        for (const agent of blocked) {
          out.push({ ...at, type: 'agent_state', cursor: nextCursor(), agent, state: 'blocked', gate });
        }
        const sender = blocked[blocked.length - 1];
        if (sender) handoff(sender, 'human', row.artifactLink ? basename(row.artifactLink) : GATE_ARTIFACT[gate]);
        continue;
      }

      const agent = AGENT_BY_NAME[row.agentName];
      if (!agent) continue;

      if (row.eventType === 'retry') {
        const gate: FloorGate = agent === 'reviewer' ? 'reviewer' : 'qa';
        const max = options.retryLimits?.[gate] ?? null;
        const count = row.retryCount ?? 1;
        state.pendingRetry = gate;
        state.implRound = [];
        setStep(GATE_STEP[gate], 'active', `retry ${count}/${max ?? '?'}`);
        out.push({ ...at, type: 'agent_state', cursor: nextCursor(), agent, state: 'retrying', gate, retry: { count, max } });
        continue;
      }

      if (row.eventType === 'start') {
        state.startedAtByAgent.set(agent, row.createdAt);
        state.running.add(agent);
        const step = STEP_OF[agent];

        if (step === 'impl') {
          if (state.pendingRetry) {
            handoff(state.pendingRetry === 'qa' ? 'qa' : 'reviewer', agent, GATE_ARTIFACT[state.pendingRetry]);
            state.pendingRetry = null;
          } else if (state.lastEnded === 'planner') {
            handoff('planner', agent, 'requirements.md');
            handoff('planner', agent, 'tasks.md');
          } else if (state.lastEnded && STEP_OF[state.lastEnded] === 'impl') {
            handoff(state.lastEnded, agent, 'verify-report.md');
          }
          state.implRound.push(agent);
        } else if (step === 'qa') {
          passIfActive('impl', 'verify-report.md');
          if (state.lastEnded && STEP_OF[state.lastEnded] === 'impl') handoff(state.lastEnded, 'qa', 'verify-report.md');
        } else if (step === 'review') {
          passIfActive('impl', 'verify-report.md');
          passIfActive('qa', 'qa-report.md');
          if (state.lastEnded === 'qa') handoff('qa', 'reviewer', 'qa-report.md');
          else if (state.lastEnded && STEP_OF[state.lastEnded] === 'impl') handoff(state.lastEnded, 'reviewer', 'verify-report.md');
        }

        if (state.stepStatus[step] !== 'active') setStep(step, 'active');
        out.push({ ...at, type: 'agent_state', cursor: nextCursor(), agent, state: RUNNING_STATE[agent] });
        continue;
      }

      // 'end'
      const startedAtAgent = state.startedAtByAgent.get(agent);
      state.running.delete(agent);
      state.lastEnded = agent;
      out.push({
        ...at,
        type: 'usage',
        cursor: nextCursor(),
        agent,
        costUsd: row.costUsd,
        tokens: null,
        durationMs: startedAtAgent ? Math.max(0, Date.parse(row.createdAt) - Date.parse(startedAtAgent)) : null,
      });

      if (row.outcome !== null && row.outcome !== 'OK') {
        setStep(STEP_OF[agent], 'fail', row.outcome);
        out.push({ ...at, type: 'agent_state', cursor: nextCursor(), agent, state: 'error', outcome: row.outcome });
        continue;
      }

      if (agent === 'planner') setStep('plan', 'pass', 'tasks.md');
      out.push({
        ...at,
        type: 'agent_state',
        cursor: nextCursor(),
        agent,
        state: 'idle',
        ...(row.verifyDetails ? { verify: row.verifyDetails } : {}),
      });
    }

    // End of the attempt. For the current attempt that is whatever
    // pipeline_runs says (nothing yet, while it's still running); for an
    // earlier one, pipeline_runs has since been overwritten.
    const superseded = attempt < currentAttempt;
    const finalStatus: FloorFinalStatus | null = superseded
      ? state.exhaustedGate
        ? 'NEEDS_HUMAN'
        : null
      : isFinalStatus(run.finalStatus)
        ? run.finalStatus
        : null;
    if (!superseded && finalStatus === null) break;

    const finishedAt = superseded ? lastTimestamp : (run.endedAt ?? lastTimestamp);
    const finish = { ...base, timestamp: finishedAt };
    // At most 6 closing events on success (4 steps + outbox handoff +
    // celebrate) and 5 on error (one per agent) — both fit their slot ranges.
    let closingSlot = finalStatus === 'ERROR' ? ERROR_CLOSING_SLOT : CLOSING_SLOT;
    const closeCursor = (): string => `${lastRowId}.${syntheticSub(attempt, closingSlot++)}`;

    if (finalStatus === 'SUCCESS') {
      for (const step of ['plan', 'impl', 'qa', 'review'] as const) {
        if (state.stepStatus[step] === 'active') {
          out.push({ ...finish, type: 'step', cursor: closeCursor(), step, status: 'pass' });
        }
      }
      if (state.lastEnded) {
        out.push({
          ...finish,
          type: 'handoff',
          cursor: closeCursor(),
          from: state.lastEnded,
          to: 'outbox',
          file: OUTPUT_FILE[state.lastEnded],
        });
        out.push({ ...finish, type: 'agent_state', cursor: closeCursor(), agent: state.lastEnded, state: 'celebrating' });
      }
    } else if (finalStatus === 'ERROR') {
      // An agent with a start row and no end row never returned (the spawn itself threw).
      for (const agent of state.running) {
        out.push({ ...finish, type: 'agent_state', cursor: closeCursor(), agent, state: 'error' });
      }
    }

    out.push({
      ...finish,
      type: 'run_finished',
      cursor: `${lastRowId}.${syntheticSub(attempt, finalStatus === 'ERROR' ? ERROR_FINISHED_SLOT : FINISHED_SLOT)}`,
      finalStatus,
      gate: state.exhaustedGate,
      superseded,
    });

    // The final PR on success, or the Draft PR on a gate stop (see RunFinishedEvent).
    if (!superseded && run.prNumber !== null && (finalStatus === 'SUCCESS' || finalStatus === 'NEEDS_HUMAN')) {
      out.push({
        ...finish,
        type: 'step',
        cursor: `${lastRowId}.${syntheticSub(attempt, PR_SLOT)}`,
        step: 'pr',
        status: 'pass',
        note: `${finalStatus === 'SUCCESS' ? 'PR' : 'Draft PR'} #${run.prNumber}`,
        prNumber: run.prNumber,
      });
    }
  }

  return out;
}
