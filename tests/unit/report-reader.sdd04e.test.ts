import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFixReviewLog } from '../../src/infrastructure/reports/report-reader.js';

// CAF-SDD-04e: a `## ` line inside a comment block (quote before Status:, or a
// fenced code block in Notes:) must not drop the entry.

const dirs: string[] = [];

function workspaceWithLog(content: string): string {
  const workspacePath = mkdtempSync(join(tmpdir(), 'caf-orchestrator-sdd04e-'));
  dirs.push(workspacePath);
  const taskDir = join(workspacePath, '.caf', 'tasks', 'GAN-1');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'fix-review-log.md'), content);
  return workspacePath;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('AC-1: `## ` line between header and Status:', () => {
  it('still returns the entry with its status and note', async () => {
    const ws = workspaceWithLog(
      [
        '## Fix Review Log — GAN-1',
        'Triggered by: global',
        '',
        '### Comment 1 [GENERAL]',
        'Please rename the helper, see the quote:',
        '## Something',
        'more quoted text',
        'Status: FIXED',
        'Notes: renamed the helper',
        '',
        '### Comment 2 [INLINE src/a.ts:7]',
        'Status: SKIPPED',
        'Notes: out of scope',
      ].join('\n'),
    );

    const log = await readFixReviewLog(ws, 'GAN-1');

    expect(log?.entries).toEqual([
      { commentRef: '1', label: 'GENERAL', status: 'FIXED', note: 'renamed the helper' },
      { commentRef: '2', label: 'INLINE', path: 'src/a.ts', line: 7, status: 'SKIPPED', note: 'out of scope' },
    ]);
  });
});

describe('AC-2: `## ` line inside a fenced code block in Notes:', () => {
  it('keeps the note lines around it and still parses the next comment', async () => {
    const ws = workspaceWithLog(
      [
        '### Comment 1 [GENERAL]',
        'Status: FIXED',
        'Notes: added the heading',
        '```md',
        '## Example heading',
        'after the heading',
        '```',
        '',
        '### Comment 2 [GENERAL]',
        'Status: NOT_APPLICABLE',
        'Notes: nothing to do',
      ].join('\n'),
    );

    const log = await readFixReviewLog(ws, 'GAN-1');

    expect(log?.entries).toHaveLength(2);
    expect(log?.entries[0].note).toBe('added the heading ```md ## Example heading after the heading ```');
    expect(log?.entries[1]).toMatchObject({ commentRef: '2', status: 'NOT_APPLICABLE', note: 'nothing to do' });
  });
});
