import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * CAF-DASHBOARD-02: display-only details pulled out of an implementation
 * agent's verify-report.md — how many verify attempts it took and how its
 * lint/typecheck/test checks ended. Feeds the Agent Floor page and nothing
 * else.
 *
 * This is NOT the pipeline's gate. The gate is readVerifyReport() in
 * report-reader.ts (`SUCCESS` vs `NEEDS_HUMAN`), whose contract this file
 * neither uses nor changes. Target-repo agents write this report as free-form
 * markdown, so everything here is a best-effort heuristic: whatever can't be
 * recognised is reported as null, never guessed.
 */

export type VerifyCheckResult = 'pass' | 'fail';

export interface VerifyChecks {
  lint: VerifyCheckResult | null;
  typecheck: VerifyCheckResult | null;
  test: VerifyCheckResult | null;
}

export interface VerifyDetails {
  /** Which verify attempt produced the final result (1-based), or null if the report doesn't say. */
  attempt: number | null;
  /** The attempt limit as stated in the report (the "3" in "2/3"), or null if not stated. */
  maxAttempts: number | null;
  checks: VerifyChecks;
}

const CHECK_KEYWORDS: Record<keyof VerifyChecks, RegExp> = {
  lint: /\b(?:es)?lint\b/i,
  typecheck: /\btype-?check\b|\btsc\b/i,
  test: /\btests?\b|\bvitest\b|\bjest\b/i,
};

const FAIL_MARK = /\bfail(?:ed|s|ure)?\b|\bgagal\b|❌/i;
const PASS_MARK = /\bpass(?:ed|es)?\b|\blolos\b|\bsukses\b|✅|\[x\]/i;

// "attempt 2/3", "percobaan 2 dari 3", "Attempt #2 of 3"
const ATTEMPT_OF_MAX = /\b(?:attempt|percobaan|retry)\s*(?:ke-?\s*)?#?\s*(\d+)\s*(?:\/|of|dari)\s*(\d+)/gi;
// "## Attempt 2", "percobaan ke-2"
const ATTEMPT_NUMBER = /\b(?:attempt|percobaan)\s*(?:ke-?\s*)?#?\s*(\d+)\b/gi;
const FIRST_ATTEMPT = /\bfirst attempt\b|\bpercobaan pertama\b/i;

/**
 * The part of a checklist line that names what was checked: every backticked
 * command, plus an explicit label — the text before a colon ("Monorepo Lint:
 * ...") or the first cell of a table row. A bare sentence has neither, which
 * keeps prose such as "updated the spec to test the search filter (passed)"
 * from being read as a `test` check.
 */
function checkSubject(line: string): string {
  const isTableRow = /^\s*\|/.test(line);
  const body = line.replace(/^\s*(?:[-*+]|\d+\.|\|)\s*(?:\[[ xX]\]\s*)?/, '');
  const backticked = (body.match(/`[^`]*`/g) ?? []).join(' ');
  const withoutBackticks = body.replace(/`[^`]*`/g, ' ');
  const separator = isTableRow ? '|' : ':';
  const label = withoutBackticks.includes(separator) ? withoutBackticks.split(separator)[0] : '';
  return `${backticked} ${label}`;
}

function parseChecks(raw: string): VerifyChecks {
  const checks: VerifyChecks = { lint: null, typecheck: null, test: null };

  for (const line of raw.split('\n')) {
    // Only list items and table rows — verify checklists are always one or
    // the other; free prose is too ambiguous to score.
    if (!/^\s*(?:[-*+]|\d+\.|\|)\s/.test(line)) continue;

    const result: VerifyCheckResult | null = FAIL_MARK.test(line) ? 'fail' : PASS_MARK.test(line) ? 'pass' : null;
    if (result === null) continue;

    const subject = checkSubject(line);
    for (const key of Object.keys(CHECK_KEYWORDS) as Array<keyof VerifyChecks>) {
      if (!CHECK_KEYWORDS[key].test(subject)) continue;
      // One failing line outweighs any number of passing ones for the same check.
      if (checks[key] !== 'fail') checks[key] = result;
    }
  }

  return checks;
}

function parseAttempt(raw: string): Pick<VerifyDetails, 'attempt' | 'maxAttempts'> {
  let attempt: number | null = null;
  let maxAttempts: number | null = null;

  for (const match of raw.matchAll(ATTEMPT_OF_MAX)) {
    const n = Number(match[1]);
    const max = Number(match[2]);
    if (n < 1 || max < n) continue;
    if (attempt === null || n > attempt) {
      attempt = n;
      maxAttempts = max;
    }
  }
  if (attempt !== null) return { attempt, maxAttempts };

  for (const match of raw.matchAll(ATTEMPT_NUMBER)) {
    const n = Number(match[1]);
    if (n >= 1 && (attempt === null || n > attempt)) attempt = n;
  }
  if (attempt !== null) return { attempt, maxAttempts: null };

  return { attempt: FIRST_ATTEMPT.test(raw) ? 1 : null, maxAttempts: null };
}

/** Pure, never throws. Sections the report doesn't have come back as null. */
export function parseVerifyDetails(raw: string): VerifyDetails {
  return { ...parseAttempt(raw), checks: parseChecks(raw) };
}

/**
 * Reads `.caf/tasks/<ticketKey>/verify-report.md` (same location as
 * report-reader.ts's taskDir) and parses it. Never throws and never rejects:
 * a missing or unreadable file is simply "no details" — this runs inside the
 * pipeline purely for instrumentation and must not be able to fail a run.
 */
export async function readVerifyDetails(workspacePath: string, ticketKey: string): Promise<VerifyDetails | null> {
  try {
    const raw = await readFile(join(workspacePath, '.caf', 'tasks', ticketKey, 'verify-report.md'), 'utf-8');
    return parseVerifyDetails(raw);
  } catch {
    return null;
  }
}
