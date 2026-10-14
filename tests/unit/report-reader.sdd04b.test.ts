import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFixReviewLog } from '../../src/infrastructure/reports/report-reader.js';
import { readRequirementsText } from '../../src/infrastructure/reports/ac-summary.js';

// CAF-SDD-04b: a `## Proposed Spec Changes` section in fix-review-log.md must
// not leak into the last comment's note; requirements.md is read from the task dir.

const dirs: string[] = [];

function writeFile(fileName: string, content: string): string {
  const workspacePath = mkdtempSync(join(tmpdir(), 'caf-orchestrator-sdd04b-'));
  dirs.push(workspacePath);
  const taskDir = join(workspacePath, '.caf', 'tasks', 'GAN-1');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, fileName), content);
  return workspacePath;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('AC-14 support: fix-review-log.md with ## Proposed Spec Changes', () => {
  it('keeps the section out of the last comment note, even without a blank line before it', async () => {
    const ws = writeFile(
      'fix-review-log.md',
      [
        '## Fix Review Log — GAN-1',
        'Triggered by: global',
        '',
        '### Comment 1 [GENERAL]',
        'Status: SKIPPED',
        'Notes: spec change, recorded as a proposal',
        '## Proposed Spec Changes',
        '- AC-2: change the timeout to 5s',
      ].join('\n'),
    );

    const log = await readFixReviewLog(ws, 'GAN-1');

    expect(log?.entries).toEqual([
      { commentRef: '1', label: 'GENERAL', status: 'SKIPPED', note: 'spec change, recorded as a proposal' },
    ]);
  });
});

describe('A1: readRequirementsText', () => {
  it('reads .caf/tasks/<KEY>/requirements.md and returns undefined when missing', async () => {
    const ws = writeFile('requirements.md', '- AC-1: x');
    expect(await readRequirementsText(ws, 'GAN-1')).toBe('- AC-1: x');
    expect(await readRequirementsText(ws, 'GAN-2')).toBeUndefined();
  });
});
