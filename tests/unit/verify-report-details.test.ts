import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVerifyDetails, readVerifyDetails } from '../../src/infrastructure/reports/verify-report-details.js';

// CAF-DASHBOARD-02 T1: display-only, tolerant parser. The fixtures below are
// the shapes real target-repo agents actually write (umkm-pos /
// coderium-web-v2 verify-report.md files), not an idealised format.

describe('parseVerifyDetails', () => {
  it('reads a checkbox checklist with backticked commands (umkm-pos style)', () => {
    const raw = [
      '# Verification Report - GAN-137',
      '',
      'Status: SUCCESS',
      '',
      '4. **Unit Tests**:',
      '   - Updated `stock.controller.spec.ts` to test search query parameter forwarding.',
      '',
      '## Verification Checklist Results',
      '- [x] `pnpm --filter @umkm-pos/shared-types run typecheck` (Passed)',
      '- [x] `pnpm --filter umkm-pos-api run lint` (Passed)',
      '- [x] `pnpm --filter umkm-pos-api run test` (14/14 test suites passed, 189/189 tests passed)',
      '- [x] `pnpm --filter umkm-pos-api run build` (Passed)',
    ].join('\n');

    expect(parseVerifyDetails(raw)).toEqual({
      attempt: null,
      maxAttempts: null,
      checks: { lint: 'pass', typecheck: 'pass', test: 'pass' },
    });
  });

  it('reads dash-separated results and a prose "first attempt" note (coderium-web-v2 style)', () => {
    const raw = [
      '## Status: PASS',
      '## Verify Checklist — hasil',
      '- [x] `pnpm --filter coderium-api run typecheck` — PASS, tanpa error.',
      '- [x] `pnpm --filter coderium-api run build` — PASS (`nest build` sukses).',
      '## Retry',
      'Tidak perlu retry — semua verify lolos di percobaan pertama.',
    ].join('\n');

    expect(parseVerifyDetails(raw)).toEqual({
      attempt: 1,
      maxAttempts: null,
      checks: { lint: null, typecheck: 'pass', test: null },
    });
  });

  it('reads a markdown table and labelled lines', () => {
    const raw = [
      '| `pnpm typecheck` | PASS |',
      '| `pnpm lint` | FAIL |',
      '- **Test (`vitest run`):** PASSED',
    ].join('\n');

    expect(parseVerifyDetails(raw).checks).toEqual({ lint: 'fail', typecheck: 'pass', test: 'pass' });
  });

  it('lets one failing line win over passing lines for the same check', () => {
    const raw = ['- [x] `pnpm --filter api run test` (Passed)', '- [ ] `pnpm --filter web run test` — FAILED, 2 tests'].join('\n');
    expect(parseVerifyDetails(raw).checks.test).toBe('fail');
  });

  it('takes the highest "n/max" attempt and its limit', () => {
    const raw = ['## Attempt 1/3', 'lint failed', '## Attempt 2/3', 'Status: SUCCESS (percobaan 2 dari 3)'].join('\n');
    expect(parseVerifyDetails(raw)).toMatchObject({ attempt: 2, maxAttempts: 3 });
  });

  it('takes the highest bare attempt number when no limit is stated', () => {
    expect(parseVerifyDetails('### Attempt 1\n...\n### Attempt 2\n...')).toMatchObject({ attempt: 2, maxAttempts: null });
  });

  it('does not score an unchecked "not run" item, prose, or an unrelated mention', () => {
    const raw = [
      '- [ ] lint script — not run',
      'The typecheck passed on my machine.',
      '- Updated the spec to test the search filter (passed review)',
    ].join('\n');
    expect(parseVerifyDetails(raw).checks).toEqual({ lint: null, typecheck: null, test: null });
  });

  it('returns all-null for an empty or unrelated report', () => {
    const empty = { attempt: null, maxAttempts: null, checks: { lint: null, typecheck: null, test: null } };
    expect(parseVerifyDetails('')).toEqual(empty);
    expect(parseVerifyDetails('Status: NEEDS_HUMAN\n\nCould not finish.')).toEqual(empty);
  });
});

describe('readVerifyDetails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caf-dashboard-02-verify-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads .caf/tasks/<ticketKey>/verify-report.md', async () => {
    mkdirSync(join(dir, '.caf', 'tasks', 'GAN-1'), { recursive: true });
    writeFileSync(join(dir, '.caf', 'tasks', 'GAN-1', 'verify-report.md'), '- [x] `pnpm lint` (Passed)\n');
    expect((await readVerifyDetails(dir, 'GAN-1'))?.checks.lint).toBe('pass');
  });

  it('resolves to null (never rejects) when the file is missing', async () => {
    await expect(readVerifyDetails(dir, 'GAN-404')).resolves.toBeNull();
    await expect(readVerifyDetails('/nonexistent/path', 'GAN-1')).resolves.toBeNull();
  });
});
