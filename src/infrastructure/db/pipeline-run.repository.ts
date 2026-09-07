import type { Database } from 'better-sqlite3';

export type PivPhase = 'plan' | 'implement' | 'verify';
export type AgentEventType = 'start' | 'end' | 'retry' | 'gate_exhausted';

export interface PipelineRun {
  id: string;
  repoId: string;
  ticketId: string;
  ticketTitle: string;
  startedAt: string;
  endedAt: string | null;
  finalStatus: string | null;
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
}

export interface UpsertPipelineRunInput {
  id: string;
  repoId: string;
  ticketId: string;
  ticketTitle: string;
  startedAt: string;
  endedAt?: string | null;
  finalStatus?: string | null;
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
}

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
  };
}

/**
 * Thin repository over the pipeline_runs/agent_events tables. Query-layer only —
 * callers (the pipeline use-case, wired in Task 3) are responsible for wrapping
 * writes in try/catch so a DB failure never throws into the main pipeline.
 */
export class PipelineRunRepository {
  constructor(private readonly db: Database) {}

  /** Creates the pipeline_runs row if it doesn't exist yet, otherwise updates the mutable fields. */
  upsertPipelineRun(input: UpsertPipelineRunInput): void {
    this.db
      .prepare(
        `INSERT INTO pipeline_runs (id, repo_id, ticket_id, ticket_title, started_at, ended_at, final_status)
         VALUES (@id, @repoId, @ticketId, @ticketTitle, @startedAt, @endedAt, @finalStatus)
         ON CONFLICT (id) DO UPDATE SET
           ticket_title = excluded.ticket_title,
           ended_at = excluded.ended_at,
           final_status = excluded.final_status`,
      )
      .run({
        id: input.id,
        repoId: input.repoId,
        ticketId: input.ticketId,
        ticketTitle: input.ticketTitle,
        startedAt: input.startedAt,
        endedAt: input.endedAt ?? null,
        finalStatus: input.finalStatus ?? null,
      });
  }

  insertEvent(input: InsertEventInput): AgentEvent {
    const result = this.db
      .prepare(
        `INSERT INTO agent_events (pipeline_run_id, agent_name, piv_phase, event_type, retry_count, cost_usd, artifact_link, created_at)
         VALUES (@pipelineRunId, @agentName, @pivPhase, @eventType, @retryCount, @costUsd, @artifactLink, @createdAt)`,
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
      });

    const row = this.db
      .prepare('SELECT * FROM agent_events WHERE id = ?')
      .get(result.lastInsertRowid) as AgentEventRow;
    return toAgentEvent(row);
  }

  /** Lists pipeline runs, newest first, optionally filtered by repoId. */
  getPipelineRuns(repoId?: string, pagination: PaginationOptions = {}): PipelineRun[] {
    const limit = pagination.limit ?? 50;
    const offset = pagination.offset ?? 0;

    const rows = repoId
      ? (this.db
          .prepare(
            'SELECT * FROM pipeline_runs WHERE repo_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?',
          )
          .all(repoId, limit, offset) as PipelineRunRow[])
      : (this.db
          .prepare('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ? OFFSET ?')
          .all(limit, offset) as PipelineRunRow[]);

    return rows.map(toPipelineRun);
  }

  /** Returns one pipeline run plus all its agent_events (chronological), or undefined if not found. */
  getPipelineDetail(
    repoId: string,
    ticketId: string,
  ): { run: PipelineRun; events: AgentEvent[] } | undefined {
    const runRow = this.db
      .prepare('SELECT * FROM pipeline_runs WHERE repo_id = ? AND ticket_id = ?')
      .get(repoId, ticketId) as PipelineRunRow | undefined;

    if (!runRow) return undefined;

    const eventRows = this.db
      .prepare('SELECT * FROM agent_events WHERE pipeline_run_id = ? ORDER BY created_at ASC, id ASC')
      .all(runRow.id) as AgentEventRow[];

    return { run: toPipelineRun(runRow), events: eventRows.map(toAgentEvent) };
  }
}
