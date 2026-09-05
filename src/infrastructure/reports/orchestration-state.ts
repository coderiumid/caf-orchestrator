import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { taskDir } from './report-reader.js';

// Cross-invocation retry state for CAF-RETRYPIPELINE-01. Unlike the other
// artifacts in this directory (verify-report.md, qa-report.md, ...), this
// file is written by the orchestrator itself, not an agent — structured
// JSON, not loose-regex-over-markdown, since there's no agent-authoring
// contract to stay compatible with.
export type OrchestrationGate = 'implementation' | 'qa' | 'reviewer';

export interface OrchestrationState {
  orchestrationRetryCount: number;
  lastFailedGate: OrchestrationGate | null;
  lastFailedAt: string | null;
  lastKnownCommitSha: string | null;
}

function statePath(workspacePath: string, ticketKey: string): string {
  return join(taskDir(workspacePath, ticketKey), 'orchestration-state.json');
}

export async function readOrchestrationState(
  workspacePath: string,
  ticketKey: string,
): Promise<OrchestrationState | undefined> {
  let raw: string;
  try {
    raw = await readFile(statePath(workspacePath, ticketKey), 'utf-8');
  } catch {
    return undefined;
  }
  return JSON.parse(raw) as OrchestrationState;
}

/**
 * Stamps a gate-exhaustion failure (NEEDS_HUMAN at the implementation/QA/reviewer
 * gate). Preserves the existing `orchestrationRetryCount` rather than resetting
 * it — that counter is only ever incremented by the retry trigger
 * (`/caf-retry-pipeline` / Linear resume, CAF-RETRYPIPELINE-01 Task 4-5), never by
 * a gate failing again on the same attempt.
 */
export async function recordGateFailure(
  workspacePath: string,
  ticketKey: string,
  gate: OrchestrationGate,
  commitSha: string,
): Promise<void> {
  const existing = await readOrchestrationState(workspacePath, ticketKey);
  const state: OrchestrationState = {
    orchestrationRetryCount: existing?.orchestrationRetryCount ?? 0,
    lastFailedGate: gate,
    lastFailedAt: new Date().toISOString(),
    lastKnownCommitSha: commitSha,
  };

  const dir = taskDir(workspacePath, ticketKey);
  await mkdir(dir, { recursive: true });
  await writeFile(statePath(workspacePath, ticketKey), JSON.stringify(state, null, 2), 'utf-8');
}

/** Deletes orchestration-state.json on a full pipeline success — no unresolved failure to resume from, so absence of the file is the "clean" state resume logic (Task 6) checks for. */
export async function resetOrchestrationState(workspacePath: string, ticketKey: string): Promise<void> {
  await rm(statePath(workspacePath, ticketKey), { force: true });
}
