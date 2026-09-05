import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readOrchestrationState,
  recordGateFailure,
  resetOrchestrationState,
} from '../../src/infrastructure/reports/orchestration-state.js';

const dirs: string[] = [];

function makeWorkspace(): string {
  const workspacePath = mkdtempSync(join(tmpdir(), 'caf-orchestrator-orch-state-test-'));
  dirs.push(workspacePath);
  return workspacePath;
}

function statePath(workspacePath: string, ticketKey: string): string {
  return join(workspacePath, '.caf', 'tasks', ticketKey, 'orchestration-state.json');
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('readOrchestrationState', () => {
  it('returns undefined when no file exists', async () => {
    const workspacePath = makeWorkspace();
    expect(await readOrchestrationState(workspacePath, 'GAN-1')).toBeUndefined();
  });

  it('parses an existing file', async () => {
    const workspacePath = makeWorkspace();
    const dir = join(workspacePath, '.caf', 'tasks', 'GAN-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'orchestration-state.json'),
      JSON.stringify({ orchestrationRetryCount: 1, lastFailedGate: 'qa', lastFailedAt: '2026-01-01T00:00:00.000Z', lastKnownCommitSha: 'abc123' }),
    );

    const state = await readOrchestrationState(workspacePath, 'GAN-1');
    expect(state?.orchestrationRetryCount).toBe(1);
    expect(state?.lastFailedGate).toBe('qa');
    expect(state?.lastKnownCommitSha).toBe('abc123');
  });
});

describe('recordGateFailure', () => {
  it('creates the task dir and writes the state file when none existed', async () => {
    const workspacePath = makeWorkspace();
    await recordGateFailure(workspacePath, 'GAN-2', 'implementation', 'sha-1');

    const state = await readOrchestrationState(workspacePath, 'GAN-2');
    expect(state?.orchestrationRetryCount).toBe(0);
    expect(state?.lastFailedGate).toBe('implementation');
    expect(state?.lastKnownCommitSha).toBe('sha-1');
    expect(typeof state?.lastFailedAt).toBe('string');
  });

  it('preserves orchestrationRetryCount from an existing state instead of resetting it', async () => {
    const workspacePath = makeWorkspace();
    const dir = join(workspacePath, '.caf', 'tasks', 'GAN-3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'orchestration-state.json'),
      JSON.stringify({ orchestrationRetryCount: 2, lastFailedGate: 'implementation', lastFailedAt: '2026-01-01T00:00:00.000Z', lastKnownCommitSha: 'old-sha' }),
    );

    await recordGateFailure(workspacePath, 'GAN-3', 'reviewer', 'new-sha');

    const state = await readOrchestrationState(workspacePath, 'GAN-3');
    expect(state?.orchestrationRetryCount).toBe(2);
    expect(state?.lastFailedGate).toBe('reviewer');
    expect(state?.lastKnownCommitSha).toBe('new-sha');
  });

  it('does not leak state between 2 different tickets in the same workspace', async () => {
    const workspacePath = makeWorkspace();
    await recordGateFailure(workspacePath, 'GAN-4', 'qa', 'sha-a');
    await recordGateFailure(workspacePath, 'GAN-5', 'reviewer', 'sha-b');

    const stateA = await readOrchestrationState(workspacePath, 'GAN-4');
    const stateB = await readOrchestrationState(workspacePath, 'GAN-5');
    expect(stateA?.lastFailedGate).toBe('qa');
    expect(stateA?.lastKnownCommitSha).toBe('sha-a');
    expect(stateB?.lastFailedGate).toBe('reviewer');
    expect(stateB?.lastKnownCommitSha).toBe('sha-b');
  });
});

describe('resetOrchestrationState', () => {
  it('deletes an existing state file', async () => {
    const workspacePath = makeWorkspace();
    await recordGateFailure(workspacePath, 'GAN-6', 'qa', 'sha-1');
    expect(existsSync(statePath(workspacePath, 'GAN-6'))).toBe(true);

    await resetOrchestrationState(workspacePath, 'GAN-6');

    expect(existsSync(statePath(workspacePath, 'GAN-6'))).toBe(false);
  });

  it('is a no-op (does not throw) when no state file exists', async () => {
    const workspacePath = makeWorkspace();
    await expect(resetOrchestrationState(workspacePath, 'GAN-7')).resolves.toBeUndefined();
  });
});
