import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../../config/index.js';

// This file compiles to CommonJS (see tsconfig.json / package.json — no "type":
// "module"), so __dirname is the ambient CJS global, not import.meta.url.
const schemaSql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');

/** Applies schema.sql to the given database handle. Idempotent — safe to call on every open. */
export function migrate(db: Database.Database): void {
  db.exec(schemaSql);
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
