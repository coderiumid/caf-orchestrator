import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// CAF-SDD-04b: per-AC status of a gate report, counted against the AC ids in
// requirements.md. Pure string-in/string-out apart from readRequirementsText —
// no model call, same input gives the same output. Loose regex over markdown,
// like the rest of infrastructure/reports (CLAUDE.md "Report contract").

export type AcStatus = 'PASS' | 'FAIL' | 'UNVERIFIED';

export interface AcResult {
  id: string;
  status: AcStatus;
  reason: string;
}

export interface AcSummary {
  results: AcResult[];
  pass: number;
  fail: number;
  unverified: number;
  /** At least one AC and every one of them UNVERIFIED — nothing was proven (Q-1). */
  allUnverified: boolean;
  proposedSpecChanges?: string;
}

const AC_LINE = /^\s*[-*]\s+\**(AC-\d+[a-z]?)\**\s*:/i;
const AC_ID = /^AC-\d+[a-z]?$/i;
const NOT_REPORTED = 'tidak dilaporkan';
const NO_EVIDENCE = 'no evidence reported';

function normalizeId(id: string): string {
  const match = /^AC-(\d+)([a-z]?)$/i.exec(id)!;
  return `AC-${match[1]}${match[2].toLowerCase()}`;
}

/** AC ids from `- AC-n:` lines of requirements.md, in order of appearance, each once. */
export function parseRequirementAcs(requirementsMd: string): string[] {
  const ids: string[] = [];
  for (const line of requirementsMd.split('\n')) {
    const match = AC_LINE.exec(line);
    if (match) {
      const id = normalizeId(match[1]);
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '`') {
      // A `|` inside a backtick pair stays in the cell; an unpaired backtick is
      // an ordinary character (old behaviour).
      const close = line.indexOf('`', i + 1);
      if (close !== -1) {
        current += line.slice(i, close + 1).replace(/\\\|/g, '|');
        i = close;
        continue;
      }
      current += line[i];
    } else if (line[i] === '\\' && line[i + 1] === '|') {
      current += '|';
      i++;
    } else if (line[i] === '|') {
      cells.push(current);
      current = '';
    } else {
      current += line[i];
    }
  }
  cells.push(current);
  // A row starts and ends with a pipe, which leaves an empty first/last cell.
  return cells.slice(1, line.trimEnd().endsWith('|') ? -1 : undefined);
}

const clean = (cell: string): string => cell.replace(/[*`]/g, '').trim();

const SEVERITY: Record<AcStatus, number> = { PASS: 0, UNVERIFIED: 1, FAIL: 2 };

/**
 * Status and Evidence text per AC id from the gate report's per-AC table (id in
 * column 1, status in column 2, evidence in column 4). An unrecognised status
 * is UNVERIFIED, never PASS; if an AC has several rows the worst one wins.
 */
export function parseReportAcTable(reportRaw: string): Map<string, { status: AcStatus; reason: string }> {
  const table = new Map<string, { status: AcStatus; reason: string }>();
  for (const rawLine of reportRaw.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = splitRow(line).map(clean);
    if (cells.length < 2 || !AC_ID.test(cells[0])) continue;

    const id = normalizeId(cells[0]);
    const word = cells[1].toUpperCase();
    const status: AcStatus = word === 'PASS' || word === 'FAIL' ? word : 'UNVERIFIED';
    const evidence = cells[3] ?? '';
    const reason = status === 'UNVERIFIED' ? evidence || (word === 'UNVERIFIED' ? NO_EVIDENCE : `status tidak dikenali: ${cells[1]}`) : evidence;

    const existing = table.get(id);
    if (!existing || SEVERITY[status] > SEVERITY[existing.status]) table.set(id, { status, reason });
  }
  return table;
}

const NOTES_HEADING = /^#{2,4}\s*Notes\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const PROPOSED_LINE = /^[\s>*-]*\**Proposed Spec Changes:\**\s*(.*)$/i;
const NOTHING = /^(none|n\/a|-|tidak ada)\.?$/i;

function parseProposedSpecChanges(reportRaw: string): string | undefined {
  let inNotes = false;
  for (const rawLine of reportRaw.split('\n')) {
    const line = rawLine.trim();
    if (ANY_HEADING.test(line)) {
      inNotes = NOTES_HEADING.test(line);
      continue;
    }
    if (!inNotes) continue;
    const match = PROPOSED_LINE.exec(line);
    if (match) {
      const value = match[1].trim();
      return value && !NOTHING.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Counts every AC of requirements.md against the gate report. Undefined when
 * there is no requirements text or no `AC-n` line in it — the old-repo case
 * (AC-5), where nothing about the gate changes.
 */
export function summarizeAcs(requirementsMd: string | undefined, reportRaw: string): AcSummary | undefined {
  if (requirementsMd === undefined) return undefined;
  const ids = parseRequirementAcs(requirementsMd);
  if (ids.length === 0) return undefined;

  const table = parseReportAcTable(reportRaw);
  const results: AcResult[] = ids.map((id) => {
    const found = table.get(id);
    return found ? { id, ...found } : { id, status: 'UNVERIFIED', reason: NOT_REPORTED };
  });

  const count = (status: AcStatus): number => results.filter((r) => r.status === status).length;
  const summary: AcSummary = {
    results,
    pass: count('PASS'),
    fail: count('FAIL'),
    unverified: count('UNVERIFIED'),
    allUnverified: results.every((r) => r.status === 'UNVERIFIED'),
  };
  const proposed = parseProposedSpecChanges(reportRaw);
  if (proposed) summary.proposedSpecChanges = proposed;
  return summary;
}

/** The block placed at the top of a PR body (Q-3). */
export function renderAcSummary(summary: AcSummary): string {
  const lines = [
    '## AC Summary',
    `PASS: ${summary.pass} · FAIL: ${summary.fail} · UNVERIFIED: ${summary.unverified}`,
  ];
  const unverified = summary.results.filter((r) => r.status === 'UNVERIFIED');
  if (unverified.length > 0) {
    lines.push('', 'UNVERIFIED:', ...unverified.map((r) => `- ${r.id}: ${r.reason}`));
  }
  if (summary.proposedSpecChanges) {
    lines.push('', `Proposed Spec Changes: ${summary.proposedSpecChanges}`);
  }
  return lines.join('\n');
}

/**
 * requirements.md of the ticket, or undefined when the file is missing. Lives
 * here rather than in report-reader.ts so use-case tests that mock that module
 * wholesale are unaffected.
 */
export async function readRequirementsText(workspacePath: string, ticketKey: string): Promise<string | undefined> {
  try {
    return await readFile(join(workspacePath, '.caf', 'tasks', ticketKey, 'requirements.md'), 'utf-8');
  } catch {
    return undefined;
  }
}
