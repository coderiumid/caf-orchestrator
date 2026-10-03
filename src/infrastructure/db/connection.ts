import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../../config/index.js';

// This file compiles to CommonJS (see tsconfig.json / package.json — no "type":
// "module"), so __dirname is the ambient CJS global, not import.meta.url.
const schemaSql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');

// CAF-DASHBOARD-02 T1: columns added after the first release. schema.sql
// already declares them for a fresh database; a database created before T1
// gets them here. Additive and nullable only — the CHECK constraints on
// piv_phase/event_type are deliberately left alone (changing those means
// rebuilding the table).
const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, type: string]> = [
  ['pipeline_runs', 'attempt', 'INTEGER'],
  ['pipeline_runs', 'pr_number', 'INTEGER'],
  ['agent_events', 'attempt', 'INTEGER'],
  ['agent_events', 'exit_code', 'INTEGER'],
  ['agent_events', 'outcome', 'TEXT'],
  ['agent_events', 'verify_details', 'TEXT'],
];

function addColumnIfMissing(db: Database.Database, table: string, column: string, type: string): void {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    // The web server and the worker both open (and migrate) the same file —
    // losing that race to the other process is not an error.
    if (!(err instanceof Error) || !/duplicate column name/i.test(err.message)) throw err;
  }
}

/** Applies schema.sql to the given database handle, then any missing added columns. Idempotent — safe to call on every open. */
export function migrate(db: Database.Database): void {
  db.exec(schemaSql);
  for (const [table, column, type] of ADDED_COLUMNS) {
    addColumnIfMissing(db, table, column, type);
  }
}

/**
 * Opens (creating if needed) the SQLite file at `path` and applies the schema.
 * `:memory:` is supported for tests. Callers own the returned handle's lifecycle
 * (close it when done) except for the shared `db` singleton below.
 */
export function openDb(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

let sharedDb: Database.Database | undefined;

/** Lazily-opened singleton backed by config.db.path — the handle used at pipeline runtime. */
export function getDb(): Database.Database {
  if (!sharedDb) {
    sharedDb = openDb(config.db.path);
  }
  return sharedDb;
}
