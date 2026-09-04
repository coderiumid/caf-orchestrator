import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function taskDir(workspacePath: string, ticketKey: string): string {
  return join(workspacePath, '.caf', 'tasks', ticketKey);
}

export async function readRequirements(workspacePath: string, ticketKey: string): Promise<string | undefined> {
  return readIfExists(join(taskDir(workspacePath, ticketKey), 'requirements.md'));
}

export async function readTasks(workspacePath: string, ticketKey: string): Promise<string | undefined> {
  return readIfExists(join(taskDir(workspacePath, ticketKey), 'tasks.md'));
}

export type VerifyStatus = 'SUCCESS' | 'NEEDS_HUMAN';

export interface VerifyReport {
  status: VerifyStatus;
  raw: string;
}

export async function readVerifyReport(workspacePath: string, ticketKey: string): Promise<VerifyReport | undefined> {
  const raw = await readIfExists(join(taskDir(workspacePath, ticketKey), 'verify-report.md'));
  if (raw === undefined) return undefined;

  const status: VerifyStatus = /\bSUCCESS\b/.test(raw) ? 'SUCCESS' : 'NEEDS_HUMAN';
  return { status, raw };
}

export type QaStatus = 'PASS' | 'FAIL';

export interface QaReport {
  status: QaStatus;
  raw: string;
}

export async function readQaReport(workspacePath: string, ticketKey: string): Promise<QaReport | undefined> {
  const raw = await readIfExists(join(taskDir(workspacePath, ticketKey), 'qa-report.md'));
  if (raw === undefined) return undefined;

  const status: QaStatus = /\bPASS\b/.test(raw) ? 'PASS' : 'FAIL';
  return { status, raw };
}

export type ReviewerVerdict = 'APPROVE' | 'CHANGES_REQUESTED' | 'DEFER';

export interface ReviewerReport {
  verdict: ReviewerVerdict;
  raw: string;
}

const VERDICT_LINE = /^.*Verdict:\s*(.+)$/im;

export async function readReviewerReport(workspacePath: string, ticketKey: string): Promise<ReviewerReport | undefined> {
  const raw = await readIfExists(join(taskDir(workspacePath, ticketKey), 'review-notes.md'));
  if (raw === undefined) return undefined;

  const verdictLine = VERDICT_LINE.exec(raw)?.[1] ?? '';

  let verdict: ReviewerVerdict = 'CHANGES_REQUESTED';
  if (/CHANGES REQUESTED/i.test(verdictLine)) verdict = 'CHANGES_REQUESTED';
  else if (/\bAPPROVE\b/i.test(verdictLine)) verdict = 'APPROVE';
  else if (/\bDEFER\b/i.test(verdictLine)) verdict = 'DEFER';

  return { verdict, raw };
}

/**
 * Strict counterpart to readReviewerReport() — for the webhook mode `initial`
 * Verdict→event mapping (run-pr-review.use-case.ts), which per review-command.js
 * (caf-initiator) MUST STOP on an unrecognized/missing Verdict rather than default
 * silently to any event. Deliberately NOT used by run-agent-pipeline.use-case.ts's
 * pre-PR reviewer gate — that call site's existing default-to-CHANGES_REQUESTED
 * behavior is untouched, out of scope for this change.
 */
export type InitialReviewVerdict = 'APPROVE' | 'CHANGES_REQUESTED' | 'DEFER';

export interface InitialReviewReport {
  verdict: InitialReviewVerdict;
  raw: string;
}

export class UnrecognizedVerdictError extends Error {
  constructor(readonly rawVerdictLine: string | undefined) {
    super(
      rawVerdictLine === undefined
        ? 'review-notes.md has no Verdict line'
        : `review-notes.md has an unrecognized Verdict: "${rawVerdictLine}"`,
    );
    this.name = 'UnrecognizedVerdictError';
  }
}

export async function readInitialReviewReport(
  workspacePath: string,
  ticketKey: string,
): Promise<InitialReviewReport | undefined> {
  const raw = await readIfExists(join(taskDir(workspacePath, ticketKey), 'review-notes.md'));
  if (raw === undefined) return undefined;

  const verdictLine = VERDICT_LINE.exec(raw)?.[1]?.trim();
  if (!verdictLine) {
    throw new UnrecognizedVerdictError(undefined);
  }

  // Exact match after stripping markdown emphasis/backticks, per review-command.js:
  // "capitalization/spelling yang tidak match persis" → STOP, don't guess.
  const cleaned = verdictLine.replace(/^[*_`]+|[*_`]+$/g, '').trim().toUpperCase();

  let verdict: InitialReviewVerdict;
  if (cleaned === 'APPROVE') verdict = 'APPROVE';
  else if (cleaned === 'CHANGES REQUESTED') verdict = 'CHANGES_REQUESTED';
  else if (cleaned === 'DEFER') verdict = 'DEFER';
  else throw new UnrecognizedVerdictError(verdictLine);

  return { verdict, raw };
}

/**
 * Appends a "## Skipped Agents" note to verify-report.md, for agents the
 * orchestrator itself decided not to spawn (AGENT_SKIP_ENABLED path — see
 * run-agent-pipeline.use-case.ts). Only ever called after any implementation
 * agent that did run has already written its own verify-report.md, so this
 * appends rather than overwrites; creates the file if none of the agents
 * that ran happened to produce one.
 */
export async function appendSkipNote(workspacePath: string, ticketKey: string, lines: string[]): Promise<void> {
  const path = join(taskDir(workspacePath, ticketKey), 'verify-report.md');
  const block = ['', '## Skipped Agents', ...lines, ''].join('\n');
  await appendFile(path, block, 'utf-8');
}

export type FixReviewLogStatus = 'FIXED' | 'SKIPPED' | 'NOT_APPLICABLE';

export interface FixReviewLogEntry {
  // The identifier the reviewer agent echoed back in "### Comment {id} [...]" —
  // expected to be the GitHub comment id we gave it in the spawn prompt (see
  // run-pr-review.use-case.ts), but read as a raw string since the contract
  // (caf-initiator fix-review-command.js spawnSection()) allows "comment_id atau url".
  commentRef: string;
  label: 'INLINE' | 'GENERAL';
  path?: string;
  line?: number;
  status: FixReviewLogStatus;
  note: string;
}

export interface FixReviewLog {
  mode: 'scoped' | 'global' | undefined;
  entries: FixReviewLogEntry[];
  raw: string;
}

// Block format is fixed by caf-initiator's fix-review-command.js spawnSection()
// (CAF-PRREVIEW-01 Checkpoint A, `### Comment {id} [{INLINE path:line | GENERAL}]`,
// `Status:`, `Catatan:` lines) — loose-regex-over-markdown per CLAUDE.md "Report
// contract", not structured JSON.
const COMMENT_HEADER = /^###\s*Comment\s+(\S+)\s*\[(INLINE\s+([^\]:]+):(\d+)|GENERAL)\]\s*$/;
const STATUS_LINE = /^Status:\s*(FIXED|SKIPPED|NOT_APPLICABLE)\s*$/i;
const NOTE_LINE = /^Catatan:\s*(.*)$/i;
const TRIGGERED_BY_LINE = /^Triggered by:\s*(scoped|global)\s*$/im;

export async function readFixReviewLog(workspacePath: string, ticketKey: string): Promise<FixReviewLog | undefined> {
  const raw = await readIfExists(join(taskDir(workspacePath, ticketKey), 'fix-review-log.md'));
  if (raw === undefined) return undefined;

  const modeMatch = TRIGGERED_BY_LINE.exec(raw);
  const mode = modeMatch ? (modeMatch[1].toLowerCase() as 'scoped' | 'global') : undefined;

  const entries: FixReviewLogEntry[] = [];
  let current: Partial<FixReviewLogEntry> | undefined;
  // Catatan is free-form LLM prose and may wrap across multiple physical
  // lines (unlike Status/header, which are fixed short tokens) — collect
  // continuation lines here and join on flush, instead of only capturing
  // the first line, so a wrapped note doesn't get silently truncated.
  let noteLines: string[] = [];
  let inNote = false;

  const flush = (): void => {
    if (current?.commentRef && current.label && current.status) {
      entries.push({ note: noteLines.join(' ').trim(), ...current } as FixReviewLogEntry);
    }
    noteLines = [];
    inNote = false;
  };

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    const header = COMMENT_HEADER.exec(line);
    if (header) {
      flush();
      const [, commentRef, , inlinePath, inlineLine] = header;
      current = inlinePath
        ? { commentRef, label: 'INLINE', path: inlinePath, line: Number(inlineLine) }
        : { commentRef, label: 'GENERAL' };
      continue;
    }
    if (!current) continue;

    const statusMatch = STATUS_LINE.exec(line);
    if (statusMatch) {
      current.status = statusMatch[1].toUpperCase() as FixReviewLogStatus;
      inNote = false;
      continue;
    }

    const noteMatch = NOTE_LINE.exec(line);
    if (noteMatch) {
      noteLines = [noteMatch[1]];
      inNote = true;
      continue;
    }

    if (line.length === 0) {
      inNote = false;
      continue;
    }
    if (inNote) {
      noteLines.push(line);
    }
  }
  flush();

  return { mode, entries, raw };
}
