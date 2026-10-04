import type { Database } from 'better-sqlite3';
import type { VerifyDetails } from '../reports/verify-report-details.js';

export type PivPhase = 'plan' | 'implement' | 'verify';
export type AgentEventType = 'start' | 'end' | 'retry' | 'gate_exhausted';
/** How an agent process ended — recorded on 'end' events (CAF-DASHBOARD-02 T1). */
export type AgentOutcome = 'OK' | 'FAILED' | 'KILLED' | 'TIMEOUT';

/** What a pipeline_runs row represents: a ticket pipeline run, or a PR review/fix-review job (CAF-DASHBOARD-03). */
export type RunKind = 'pipeline' | 'pr-review';
/** Same values as PrReviewJobPayload['mode'] — `initial` is a full review, `global`/`scoped` respond to (fix) review comments. */
export type ReviewMode = 'initial' | 'global' | 'scoped';

/**
 * Outcome of a finished PR review job, kept on the row so the dashboard can
 * show it without reading the artifact (which lives in a workspace that is
 * gone by then). Counts and a verdict only — never comment or code content.
 */
export type ReviewResult =
  | { type: 'verdict'; verdict: 'APPROVE' | 'CHANGES_REQUESTED' | 'DEFER'; postedAsComment: boolean }
  | { type: 'fix'; fixed: number; skipped: number; notApplicable: number };

export interface PipelineRun {
  id: string;
  repoId: string;
  ticketId: string;
  ticketTitle: string;
  startedAt: string;
  endedAt: string | null;
  finalStatus: string | null;
  /** 1-based count of how many times this run has been started (BullMQ retry or resume). Null on rows written before CAF-DASHBOARD-02. */
  attempt: number | null;
  prNumber: number | null;
  /** 'pipeline' for every row written before CAF-DASHBOARD-03 (stored as NULL). */
  kind: RunKind;
  /** Null for a pipeline run. */
  reviewMode: ReviewMode | null;
  /** Null for a pipeline run, and for a review run that hasn't finished successfully. */
  reviewResult: ReviewResult | null;
}

export interface AgentEvent {
  id: number;
  pipelineRunId: string;
  agentName: string;
  pivPhase: PivPhase;
  eventType: AgentEventType;
  retryCount: number | null;
  costUsd: number | null;
  artifactLink: string | null;
  createdAt: string;
  /** The run's attempt number at the moment this event was written. Null on rows written before CAF-DASHBOARD-02. */
  attempt: number | null;
  exitCode: number | null;
  outcome: AgentOutcome | null;
  verifyDetails: VerifyDetails | null;
}

export interface UpsertPipelineRunInput {
  id: string;
  repoId: string;
  ticketId: string;
  ticketTitle: string;
  startedAt: string;
  endedAt?: string | null;
  finalStatus?: string | null;
  /** Omitted for a pipeline run. */
  kind?: RunKind;
  reviewMode?: ReviewMode | null;
  /** Only written when the row is created — a pipeline run's PR is recorded later via setPullRequestNumber. */
  prNumber?: number | null;
}

export interface InsertEventInput {
  pipelineRunId: string;
  agentName: string;
  pivPhase: PivPhase;
  eventType: AgentEventType;
  retryCount?: number | null;
  costUsd?: number | null;
  artifactLink?: string | null;
  createdAt: string;
  exitCode?: number | null;
  outcome?: AgentOutcome | null;
  verifyDetails?: VerifyDetails | null;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

interface PipelineRunRow {
  id: string;
  repo_id: string;
  ticket_id: string;
  ticket_title: string;
  started_at: string;
  ended_at: string | null;
  final_status: string | null;
  attempt: number | null;
  pr_number: number | null;
  kind: string | null;
  review_mode: string | null;
  review_result: string | null;
}

// Matches the predicate of the partial unique index in connection.ts.
const IS_PIPELINE_ROW = "(kind IS NULL OR kind = 'pipeline')";

interface AgentEventRow {
  id: number;
  pipeline_run_id: string;
  agent_name: string;
  piv_phase: PivPhase;
  event_type: AgentEventType;
  retry_count: number | null;
  cost_usd: number | null;
  artifact_link: string | null;
  created_at: string;
  attempt: number | null;
  exit_code: number | null;
  outcome: AgentOutcome | null;
  verify_details: string | null;
}

function parseVerifyDetails(raw: string | null): VerifyDetails | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as VerifyDetails;
  } catch {
    return null;
  }
}

function parseReviewResult(raw: string | null): ReviewResult | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ReviewResult;
  } catch {
    return null;
  }
}

function toPipelineRun(row: PipelineRunRow): PipelineRun {
  return {
    id: row.id,
    repoId: row.repo_id,
    ticketId: row.ticket_id,
    ticketTitle: row.ticket_title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    finalStatus: row.final_status,
    attempt: row.attempt,
    prNumber: row.pr_number,
    kind: row.kind === 'pr-review' ? 'pr-review' : 'pipeline',
    reviewMode: row.review_mode as ReviewMode | null,
    reviewResult: parseReviewResult(row.review_result),
  };
}

function toAgentEvent(row: AgentEventRow): AgentEvent {
  return {
    id: row.id,
    pipelineRunId: row.pipeline_run_id,
    agentName: row.agent_name,
    pivPhase: row.piv_phase,
    eventType: row.event_type,
    retryCount: row.retry_count,
    costUsd: row.cost_usd,
    artifactLink: row.artifact_link,
    createdAt: row.created_at,
    attempt: row.attempt,
    exitCode: row.exit_code,
    outcome: row.outcome,
    verifyDetails: parseVerifyDetails(row.verify_details),
  };
}

/**
 * Thin repository over the pipeline_runs/agent_events tables. Query-layer only —
 * callers (the pipeline use-case, wired in Task 3) are responsible for wrapping
 * writes in try/catch so a DB failure never throws into the main pipeline.
 */
export class PipelineRunRepository {
  constructor(private readonly db: Database) {}

  /**
   * Creates the pipeline_runs row if it doesn't exist yet (attempt 1),
   * otherwise updates the mutable fields and bumps `attempt` — every call is
   * the start of a new attempt (see recordPipelineStarted, the only runtime
   * caller). A row written before the attempt column existed counts its
   * prior history as attempt 1.
   */
  upsertPipelineRun(input: UpsertPipelineRunInput): void {
    this.db
      .prepare(
        `INSERT INTO pipeline_runs (id, repo_id, ticket_id, ticket_title, started_at, ended_at, final_status, attempt, kind, review_mode, pr_number)
         VALUES (@id, @repoId, @ticketId, @ticketTitle, @startedAt, @endedAt, @finalStatus, 1, @kind, @reviewMode, @prNumber)
         ON CONFLICT (id) DO UPDATE SET
           ticket_title = excluded.ticket_title,
           ended_at = excluded.ended_at,
           final_status = excluded.final_status,
           review_result = NULL,
           attempt = COALESCE(pipeline_runs.attempt, 1) + 1`,
      )
      .run({
        id: input.id,
        repoId: input.repoId,
        ticketId: input.ticketId,
        ticketTitle: input.ticketTitle,
        startedAt: input.startedAt,
        endedAt: input.endedAt ?? null,
        finalStatus: input.finalStatus ?? null,
        // Pipeline rows keep kind NULL, exactly as before CAF-DASHBOARD-03.
        kind: input.kind === 'pr-review' ? 'pr-review' : null,
        reviewMode: input.reviewMode ?? null,
        prNumber: input.prNumber ?? null,
      });
  }

  /** Marks a pipeline_runs row as concluded (success, a gate stop, or an error) without touching started_at. No-op if the row doesn't exist yet. */
  finalizePipelineRun(id: string, endedAt: string, finalStatus: string): void {
    this.db
      .prepare('UPDATE pipeline_runs SET ended_at = ?, final_status = ? WHERE id = ?')
      .run(endedAt, finalStatus, id);
  }

  /** Stores the outcome of a finished PR review job. No-op if the row doesn't exist. */
  setReviewResult(id: string, result: ReviewResult): void {
    this.db.prepare('UPDATE pipeline_runs SET review_result = ? WHERE id = ?').run(JSON.stringify(result), id);
  }

  /** Records the pull request opened (or reused) for this run. No-op if the row doesn't exist. */
  setPullRequestNumber(id: string, prNumber: number): void {
    this.db.prepare('UPDATE pipeline_runs SET pr_number = ? WHERE id = ?').run(prNumber, id);
  }

  insertEvent(input: InsertEventInput): AgentEvent {
    const result = this.db
      .prepare(
        `INSERT INTO agent_events (pipeline_run_id, agent_name, piv_phase, event_type, retry_count, cost_usd, artifact_link, created_at, attempt, exit_code, outcome, verify_details)
         VALUES (@pipelineRunId, @agentName, @pivPhase, @eventType, @retryCount, @costUsd, @artifactLink, @createdAt,
                 (SELECT attempt FROM pipeline_runs WHERE id = @pipelineRunId), @exitCode, @outcome, @verifyDetails)`,
      )
      .run({
        pipelineRunId: input.pipelineRunId,
        agentName: input.agentName,
        pivPhase: input.pivPhase,
        eventType: input.eventType,
        retryCount: input.retryCount ?? null,
        costUsd: input.costUsd ?? null,
        artifactLink: input.artifactLink ?? null,
        createdAt: input.createdAt,
        exitCode: input.exitCode ?? null,
        outcome: input.outcome ?? null,
        verifyDetails: input.verifyDetails ? JSON.stringify(input.verifyDetails) : null,
      });

    const row = this.db
      .prepare('SELECT * FROM agent_events WHERE id = ?')
      .get(result.lastInsertRowid) as AgentEventRow;
    return toAgentEvent(row);
  }

  /** Lists runs of every kind, newest first, optionally filtered by repoId and/or kind. */
  getPipelineRuns(repoId?: string, pagination: PaginationOptions = {}, kind?: RunKind): PipelineRun[] {
    const limit = pagination.limit ?? 50;
    const offset = pagination.offset ?? 0;

    const where: string[] = [];
    const params: Array<string | number> = [];
    if (repoId) {
      where.push('repo_id = ?');
      params.push(repoId);
    }
    if (kind === 'pipeline') where.push(IS_PIPELINE_ROW);
    else if (kind === 'pr-review') where.push("kind = 'pr-review'");

    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as PipelineRunRow[];

    return rows.map(toPipelineRun);
  }

  /** All agent_events for one pipeline_runs.id, chronological — the piece getPipelineDetail() already does by repoId+ticketId, exposed directly for callers (Task 6's summary aggregation) that already have the run's id. */
  getEventsForRun(pipelineRunId: string): AgentEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_events WHERE pipeline_run_id = ? ORDER BY created_at ASC, id ASC')
      .all(pipelineRunId) as AgentEventRow[];
    return rows.map(toAgentEvent);
  }

  /** Returns one run of any kind by its pipeline_runs.id, plus all its agent_events (chronological), or undefined if not found. */
  getRunById(id: string): { run: PipelineRun; events: AgentEvent[] } | undefined {
    const runRow = this.db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(id) as PipelineRunRow | undefined;
    if (!runRow) return undefined;
    return { run: toPipelineRun(runRow), events: this.getEventsForRun(runRow.id) };
  }

  /** Returns the ticket's pipeline run (never one of its PR-review runs) plus all its agent_events (chronological), or undefined if not found. */
  getPipelineDetail(
    repoId: string,
    ticketId: string,
  ): { run: PipelineRun; events: AgentEvent[] } | undefined {
    const runRow = this.db
      .prepare(`SELECT * FROM pipeline_runs WHERE repo_id = ? AND ticket_id = ? AND ${IS_PIPELINE_ROW}`)
      .get(repoId, ticketId) as PipelineRunRow | undefined;

    if (!runRow) return undefined;

    const eventRows = this.db
      .prepare('SELECT * FROM agent_events WHERE pipeline_run_id = ? ORDER BY created_at ASC, id ASC')
      .all(runRow.id) as AgentEventRow[];

    return { run: toPipelineRun(runRow), events: eventRows.map(toAgentEvent) };
  }
}
