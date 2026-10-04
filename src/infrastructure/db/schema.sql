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
  final_status TEXT,
  -- CAF-DASHBOARD-02 T1. Existing databases get these via the guarded
  -- ALTER TABLE ADD COLUMN in connection.ts (CREATE TABLE IF NOT EXISTS
  -- never touches a table that already exists).
  attempt      INTEGER,
  pr_number    INTEGER,
  -- CAF-DASHBOARD-03 T1. kind is NULL for a ticket pipeline run (every row
  -- written before this ticket) and 'pr-review' for a PR review/fix-review
  -- job; review_mode/review_result are only set on the latter.
  kind          TEXT,
  review_mode   TEXT,
  review_result TEXT
);

-- The "one row per (repo_id, ticket_id)" unique index is created in
-- connection.ts, not here: since CAF-DASHBOARD-03 it is a partial index on
-- the kind column, which a database created before that ticket only gets
-- from the guarded ALTER TABLE that runs after this file.

CREATE TABLE IF NOT EXISTS agent_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id  TEXT NOT NULL REFERENCES pipeline_runs (id),
  agent_name       TEXT NOT NULL,
  piv_phase        TEXT NOT NULL CHECK (piv_phase IN ('plan', 'implement', 'verify')),
  event_type       TEXT NOT NULL CHECK (event_type IN ('start', 'end', 'retry', 'gate_exhausted')),
  retry_count      INTEGER,
  cost_usd         REAL,
  artifact_link    TEXT,
  created_at       TEXT NOT NULL,
  -- CAF-DASHBOARD-02 T1 (see pipeline_runs note above).
  attempt          INTEGER,
  exit_code        INTEGER,
  outcome          TEXT,
  verify_details   TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_events_pipeline_run_id
  ON agent_events (pipeline_run_id);
