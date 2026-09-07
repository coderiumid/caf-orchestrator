-- CAF-DASHBOARD-01: pipeline history store.
-- Applied idempotently (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
-- so re-running the migration against an already-migrated DB is a no-op.

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id           TEXT PRIMARY KEY,
  repo_id      TEXT NOT NULL,
  ticket_id    TEXT NOT NULL,
  ticket_title TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  final_status TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_repo_ticket
  ON pipeline_runs (repo_id, ticket_id);

CREATE TABLE IF NOT EXISTS agent_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id  TEXT NOT NULL REFERENCES pipeline_runs (id),
  agent_name       TEXT NOT NULL,
  piv_phase        TEXT NOT NULL CHECK (piv_phase IN ('plan', 'implement', 'verify')),
  event_type       TEXT NOT NULL CHECK (event_type IN ('start', 'end', 'retry', 'gate_exhausted')),
  retry_count      INTEGER,
  cost_usd         REAL,
  artifact_link    TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_events_pipeline_run_id
  ON agent_events (pipeline_run_id);
