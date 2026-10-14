import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readFixReviewLog,
  readQaReport,
  readValidateReport,
  readVerifyReport,
} from '../../src/infrastructure/reports/report-reader.js';

// CAF-SDD-04a: report-reader accepts the old and the new artifact names/shapes.

const dirs: string[] = [];

function writeReport(fileName: string, content: string, ticketKey = 'GAN-1'): string {
  const workspacePath = mkdtempSync(join(tmpdir(), 'caf-orchestrator-sdd04a-'));
  dirs.push(workspacePath);
  const taskDir = join(workspacePath, '.caf', 'tasks', ticketKey);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, fileName), content);
  return workspacePath;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('AC-2: gate report Status line, for qa-report.md and validate-report.md', () => {
  const VALIDATE_REPORT = (status: string) =>
    [
      '## Validate Report — GAN-1',
      'Ticket: GAN-1',
      'Agent: caf-validator',
      `Status: ${status}`,
      'Unverified: 0 — none',
      '',
      '### Acceptance Criteria',
      '| AC | Status | Evidence kind | Evidence |',
      '|----|--------|---------------|----------|',
      '| AC-1 | PASS | automated-test | foo.test.ts::bar |',
    ].join('\n');

  const read = { 'qa-report.md': readQaReport, 'validate-report.md': readValidateReport } as const;

  for (const fileName of ['qa-report.md', 'validate-report.md'] as const) {
    describe(fileName, () => {
      it('anchored Status: PASS passes', async () => {
        const ws = writeReport(fileName, VALIDATE_REPORT('PASS'));
        expect((await read[fileName](ws, 'GAN-1'))?.status).toBe('PASS');
      });

      it('Status: FAIL fails', async () => {
        const ws = writeReport(fileName, VALIDATE_REPORT('FAIL'));
        expect((await read[fileName](ws, 'GAN-1'))?.status).toBe('FAIL');
      });

      it('Status: NEEDS_HUMAN fails', async () => {
        const ws = writeReport(fileName, VALIDATE_REPORT('NEEDS_HUMAN'));
        expect((await read[fileName](ws, 'GAN-1'))?.status).toBe('FAIL');
      });

      it('no Status: line fails, even with PASS in the table', async () => {
        const ws = writeReport(fileName, '## Report\n| AC-1 | PASS |\n');
        expect((await read[fileName](ws, 'GAN-1'))?.status).toBe('FAIL');
      });

      it('returns undefined when the file does not exist', async () => {
        const ws = writeReport('other.md', 'x');
        expect(await read[fileName](ws, 'GAN-1')).toBeUndefined();
      });
    });
  }

  it('readValidateReport reads validate-report.md only, never qa-report.md', async () => {
    const ws = writeReport('qa-report.md', 'Status: PASS');
    expect(await readValidateReport(ws, 'GAN-1')).toBeUndefined();
  });
});

describe('AC-3: verify-report.md Status line', () => {
  const statusOf = async (content: string) => (await readVerifyReport(writeReport('verify-report.md', content), 'GAN-1'))?.status;

  it('Status: SUCCESS passes', async () => {
    expect(await statusOf('# Verify Report\n\nStatus: SUCCESS\n\n## Checklist\n- [x] lint\n')).toBe('SUCCESS');
  });

  it('Status: NEEDS_HUMAN does not pass even when SUCCESS appears elsewhere in the file', async () => {
    expect(await statusOf('# Verify Report\n\nStatus: NEEDS_HUMAN\n\n## Notes\nlint SUCCESS, test failed\n')).toBe('NEEDS_HUMAN');
  });

  it('any other Status value does not pass', async () => {
    expect(await statusOf('Status: PASS\nall SUCCESS\n')).toBe('NEEDS_HUMAN');
  });

  it('an unfilled placeholder (Status: SUCCESS | NEEDS_HUMAN) does not pass', async () => {
    expect(await statusOf('# Verify Report\n\nStatus: SUCCESS | NEEDS_HUMAN\n')).toBe('NEEDS_HUMAN');
  });

  it('old heading form (## Status: SUCCESS) passes', async () => {
    expect(await statusOf('## Ticket: GAN-1\n## Status: SUCCESS\n\n## Attempt Log\n- Attempt 1: PASS\n')).toBe('SUCCESS');
  });

  it('old heading form (## Status: NEEDS_HUMAN) does not pass', async () => {
    expect(await statusOf('## Ticket: GAN-1\n## Status: NEEDS_HUMAN\n\n## Notes\nprevious attempt SUCCESS\n')).toBe('NEEDS_HUMAN');
  });

  it('tolerates markdown emphasis around the Status line', async () => {
    expect(await statusOf('**Status:** SUCCESS\n')).toBe('SUCCESS');
    expect(await statusOf('Status: **SUCCESS**\n')).toBe('SUCCESS');
  });

  it('a Status word inside another label (e.g. "Lint Status:") is not the report status', async () => {
    expect(await statusOf('- Lint Status: FAIL\nResult: SUCCESS\n')).toBe('SUCCESS');
  });

  it('no Status: line falls back to the old rule — SUCCESS anywhere passes', async () => {
    expect(await statusOf('Verification SUCCESS: all good\n')).toBe('SUCCESS');
  });

  it('no Status: line and no SUCCESS word does not pass (old rule)', async () => {
    expect(await statusOf('Verification failed\n')).toBe('NEEDS_HUMAN');
  });

  it('returns undefined when verify-report.md does not exist', async () => {
    expect(await readVerifyReport(writeReport('other.md', 'x'), 'GAN-1')).toBeUndefined();
  });
});

describe('AC-4: fix-review-log.md Notes: and Catatan: read the same', () => {
  const log = (label: string) =>
    [
      '## Fix Review Log — GAN-1',
      'Triggered by: global',
      '',
      '### Comment 123 [INLINE src/a.ts:10]',
      'Status: SKIPPED',
      `${label}: out of scope for this ticket,`,
      'tracked separately.',
      '',
      '### Comment 456 [GENERAL]',
      'Status: FIXED',
      `${label}: done`,
    ].join('\n');

  it('parses Notes: exactly like Catatan:', async () => {
    const notes = await readFixReviewLog(writeReport('fix-review-log.md', log('Notes')), 'GAN-1');
    const catatan = await readFixReviewLog(writeReport('fix-review-log.md', log('Catatan')), 'GAN-1');

    expect(notes?.entries).toEqual(catatan?.entries);
    expect(notes?.entries.map((e) => e.note)).toEqual(['out of scope for this ticket, tracked separately.', 'done']);
  });
});
