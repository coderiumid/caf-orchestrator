import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TicketComment } from '../../domain/interfaces/ticket-comment.interface.js';

// CAF-SDD-04c: reader for what the planner left in requirements.md — the
// anchored `Status:` line and the BLOCKING questions without an answer. Pure
// string-in/string-out apart from the two file helpers, loose regex over
// markdown like the rest of infrastructure/reports (CLAUDE.md "Report contract").
// Not in report-reader.ts: use-case tests mock that module with a closed factory.

export type SpecStatus = 'DRAFT' | 'NEEDS_CLARIFICATION' | 'APPROVED' | 'NEEDS_HUMAN';

const STATUS_LINE = /^(Status:[ \t]*)(DRAFT|NEEDS_CLARIFICATION|APPROVED|NEEDS_HUMAN)\b/m;
const QUESTION_LINE = /^\s*[-*]\s+\**(Q-\d+[a-z]?)\**\s*\[BLOCKING\]/i;
const BULLET_OR_HEADING = /^\s*([-*]\s|#)/;
const ANSWER = /Answer:\s*([\s\S]*)$/i;

/**
 * First line-anchored `Status:` with a known value; undefined when there is none
 * (no spec, or a spec that does not use the planner's status line), which callers
 * treat as "no Clarify, no gate" — the behavior before this ticket.
 */
export function parseSpecStatus(requirementsMd: string): SpecStatus | undefined {
  return STATUS_LINE.exec(requirementsMd)?.[2] as SpecStatus | undefined;
}

export interface SpecQuestion {
  id: string;
  /** The question line as written, without its leading bullet. */
  text: string;
}

/** `- Q-n [BLOCKING] ... — Answer:` bullets whose answer (same line or indented continuation) is empty or missing. */
export function findUnansweredBlockingQuestions(requirementsMd: string): SpecQuestion[] {
  const lines = requirementsMd.split('\n');
  const open: SpecQuestion[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = QUESTION_LINE.exec(lines[i]);
    if (!match) continue;

    const questionLine = lines[i];
    let block = questionLine;
    while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !BULLET_OR_HEADING.test(lines[i + 1])) {
      i += 1;
      block += `\n${lines[i]}`;
    }

    const answer = ANSWER.exec(block)?.[1].trim() ?? '';
    if (answer === '') {
      open.push({ id: match[1], text: questionLine.replace(/^\s*[-*]\s+/, '').trim() });
    }
  }
  return open;
}

/**
 * Rewrites only the value on the `Status:` line to APPROVED, keeping whatever
 * follows it. `changed: false` when it already was; undefined without a status line.
 */
export function setSpecStatusApproved(requirementsMd: string): { text: string; changed: boolean } | undefined {
  const match = STATUS_LINE.exec(requirementsMd);
  if (!match) return undefined;
  if (match[2] === 'APPROVED') return { text: requirementsMd, changed: false };
  return { text: requirementsMd.replace(STATUS_LINE, '$1APPROVED'), changed: true };
}

/** First line of every comment the orchestrator posts when it stops to ask — how the last Clarify round is found again. */
export const CLARIFY_COMMENT_MARKER = '❓ CAF-CLARIFY';

/**
 * The comments that answer the latest Clarify: human comments after the last
 * Clarify comment (bots and the Clarify comments themselves excluded). With no
 * Clarify comment to anchor on, every human comment counts.
 */
export function selectClarifyAnswers(comments: TicketComment[]): TicketComment[] {
  let lastClarify = -1;
  comments.forEach((comment, index) => {
    if (comment.body.includes(CLARIFY_COMMENT_MARKER)) lastClarify = index;
  });
  return comments.slice(lastClarify + 1).filter((comment) => !comment.authorIsBot);
}

function requirementsPath(workspacePath: string, ticketKey: string): string {
  return join(workspacePath, '.caf', 'tasks', ticketKey, 'requirements.md');
}

export async function readSpecText(workspacePath: string, ticketKey: string): Promise<string | undefined> {
  try {
    return await readFile(requirementsPath(workspacePath, ticketKey), 'utf-8');
  } catch {
    return undefined;
  }
}

export async function writeSpecText(workspacePath: string, ticketKey: string, text: string): Promise<void> {
  await writeFile(requirementsPath(workspacePath, ticketKey), text, 'utf-8');
}
