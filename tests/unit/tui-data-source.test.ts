import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { PipelineRunRepository } from '../../src/infrastructure/db/pipeline-run.repository.js';
import type { TuiSettings } from '../../src/tui/domain/models/settings.js';
import { TuiDataSource } from '../../src/tui/infrastructure/data/tui-data-source.js';

let dir: string;
let settings: TuiSettings;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caf-tui-'));
  settings = {
    repoRoot: dir,
    serverPort: 1,
    redisUrl: 'redis://127.0.0.1:1',
    dbPath: join(dir, 'db.sqlite'),
    agentTimeoutMs: 1000,
    retryLimits: { qa: 1, reviewer: 1 },
    pipelineTriggerEnabled: null,
    tunnel: null,
    tunnelError: null,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('TuiDataSource', () => {
  it('returns empty data while the database file does not exist yet', async () => {
    const ds = new TuiDataSource(settings);
    expect(ds.listRuns()).toEqual([]);
    expect(ds.getRunDetail('nope')).toBeUndefined();
    await ds.close();
  });

  it('reads runs and details read-only from an existing database', async () => {
    // connection.ts imports config (needs the real caf.config.yaml), so build the schema directly.
    const writer = new Database(settings.dbPath);
    writer.exec(readFileSync(join(__dirname, '../../src/infrastructure/db/schema.sql'), 'utf-8'));
    new PipelineRunRepository(writer).upsertPipelineRun({
      id: 'o/r#ABC-1',
      repoId: 'o/r',
      ticketId: 'ABC-1',
      ticketTitle: 'T',
      startedAt: new Date().toISOString(),
    });
    writer.close();
    const run = { id: 'o/r#ABC-1' };

    const ds = new TuiDataSource(settings);
    const runs = ds.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ticketId: 'ABC-1', status: 'RUNNING' });
    expect(ds.getRunDetail(run.id)?.api.runId).toBe(run.id);
    await ds.close();
  });
});
