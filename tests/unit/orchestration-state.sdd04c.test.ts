import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readOrchestrationState,
  recordWaitingState,
  clearWaitingState,
  recordGateFailure,
} from '../../src/infrastructure/reports/orchestration-state.js';

// CAF-SDD-04c A4: a waiting marker on orchestration-state.json that old files lack.

const dirs: string[] = [];
const makeWorkspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'caf-orch-state-04c-'));
  dirs.push(dir);
  return dir;
};
const statePath = (ws: string) => join(ws, '.caf', 'tasks', 'GAN-1', 'orchestration-state.json');
const ctx = { ticketTitle: 'T', ticketDescription: 'D' };

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('waiting marker', () => {
  it('a state file written before 04c reads without a waitingFor', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, '.caf', 'tasks', 'GAN-1'), { recursive: true });
    writeFileSync(statePath(ws), JSON.stringify({ orchestrationRetryCount: 1, lastFailedGate: 'qa', lastFailedAt: null, lastKnownCommitSha: 'a', ticketTitle: 'x', ticketDescription: 'y' }));
    const state = await readOrchestrationState(ws, 'GAN-1');
    expect(state?.waitingFor).toBeUndefined();
    expect(state?.orchestrationRetryCount).toBe(1);
  });

  it('recordWaitingState keeps the retry count and failed gate of an existing state', async () => {
    const ws = makeWorkspace();
    await recordGateFailure(ws, 'GAN-1', 'reviewer', 'sha1', ctx);
    await recordWaitingState(ws, 'GAN-1', 'clarify', 'sha2', ctx);
    const state = await readOrchestrationState(ws, 'GAN-1');
    expect(state).toMatchObject({ waitingFor: 'clarify', orchestrationRetryCount: 0, lastFailedGate: 'reviewer', lastKnownCommitSha: 'sha2', ticketTitle: 'T' });
  });

  it('recordWaitingState on a fresh workspace starts at count 0 with no failed gate', async () => {
    const ws = makeWorkspace();
    await recordWaitingState(ws, 'GAN-1', 'spec-approval', 'sha', ctx);
    expect(await readOrchestrationState(ws, 'GAN-1')).toMatchObject({ waitingFor: 'spec-approval', orchestrationRetryCount: 0, lastFailedGate: null });
  });

  it('recordGateFailure drops the waiting marker', async () => {
    const ws = makeWorkspace();
    await recordWaitingState(ws, 'GAN-1', 'spec-approval', 'sha', ctx);
    await recordGateFailure(ws, 'GAN-1', 'implementation', 'sha', ctx);
    expect((await readOrchestrationState(ws, 'GAN-1'))?.waitingFor).toBeUndefined();
  });

  it('clearWaitingState removes a file that only existed to wait, and strips the marker from one that carries history', async () => {
    const ws = makeWorkspace();
    await recordWaitingState(ws, 'GAN-1', 'clarify', 'sha', ctx);
    await clearWaitingState(ws, 'GAN-1');
    expect(existsSync(statePath(ws))).toBe(false);

    await recordGateFailure(ws, 'GAN-1', 'reviewer', 'sha', ctx);
    await recordWaitingState(ws, 'GAN-1', 'clarify', 'sha', ctx);
    await clearWaitingState(ws, 'GAN-1');
    expect(await readOrchestrationState(ws, 'GAN-1')).toMatchObject({ lastFailedGate: 'reviewer' });
    expect((await readOrchestrationState(ws, 'GAN-1'))?.waitingFor).toBeUndefined();
  });
});
