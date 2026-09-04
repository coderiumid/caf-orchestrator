import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFixReviewLog, readInitialReviewReport, UnrecognizedVerdictError } from '../../src/infrastructure/reports/report-reader.js';

const dirs: string[] = [];

function writeFixReviewLog(ticketKey: string, content: string): string {
  const workspacePath = mkdtempSync(join(tmpdir(), 'caf-orchestrator-report-reader-test-'));
  dirs.push(workspacePath);
  const taskDir = join(workspacePath, '.caf', 'tasks', ticketKey);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'fix-review-log.md'), content);
  return workspacePath;
}

function writeReviewNotes(ticketKey: string, content: string): string {
  const workspacePath = mkdtempSync(join(tmpdir(), 'caf-orchestrator-report-reader-test-'));
  dirs.push(workspacePath);
  const taskDir = join(workspacePath, '.caf', 'tasks', ticketKey);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'review-notes.md'), content);
  return workspacePath;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('readFixReviewLog', () => {
  it('captures a single-line Catatan note in full', async () => {
    const md = [
      '## Fix Review Log — GAN-114',
      'Triggered by: initial',
      '',
      '### Comment 123 [GENERAL]',
      '> quoted comment',
      'Status: FIXED',
      'Catatan: sudah diverifikasi ulang, tidak ada masalah.',
    ].join('\n');
    const workspacePath = writeFixReviewLog('GAN-114', md);

    const result = await readFixReviewLog(workspacePath, 'GAN-114');

    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0].note).toBe('sudah diverifikasi ulang, tidak ada masalah.');
  });

  it('joins a Catatan note that wraps across multiple physical lines instead of truncating it', async () => {
    // Regression for CAF-PRREVIEW-01: a wrapped Catatan note used to get cut
    // to just its first physical line, silently dropping the rest.
    const md = [
      '## Fix Review Log — GAN-114',
      'Triggered by: initial',
      '',
      '### Comment 456 [GENERAL]',
      '> quoted comment',
      'Status: SKIPPED',
      'Catatan: security audit sudah dilakukan ulang independen (bukan cuma baca artifact',
      'lama) dan hasilnya konsisten dengan temuan sebelumnya, jadi tidak ada perubahan',
      'yang diperlukan di sini.',
    ].join('\n');
    const workspacePath = writeFixReviewLog('GAN-114', md);

    const result = await readFixReviewLog(workspacePath, 'GAN-114');

    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0].note).toBe(
      'security audit sudah dilakukan ulang independen (bukan cuma baca artifact lama) dan hasilnya konsisten dengan temuan sebelumnya, jadi tidak ada perubahan yang diperlukan di sini.',
    );
  });

  it('stops accumulating a wrapped note at the next Comment header', async () => {
    const md = [
      '## Fix Review Log — GAN-114',
      'Triggered by: initial',
      '',
      '### Comment 1 [GENERAL]',
      'Status: FIXED',
      'Catatan: catatan panjang yang',
      'berlanjut ke baris kedua.',
      '### Comment 2 [GENERAL]',
      'Status: NOT_APPLICABLE',
      'Catatan: catatan kedua.',
    ].join('\n');
    const workspacePath = writeFixReviewLog('GAN-114', md);

    const result = await readFixReviewLog(workspacePath, 'GAN-114');

    expect(result?.entries).toHaveLength(2);
    expect(result?.entries[0].note).toBe('catatan panjang yang berlanjut ke baris kedua.');
    expect(result?.entries[1].note).toBe('catatan kedua.');
  });

  it('stops accumulating a wrapped note at the next Comment header even with no blank line between them', async () => {
    // Verifies header-match is checked before the note-continuation catch-all
    // in the same loop iteration — a header line must not get swallowed into
    // the previous entry's note, and the next entry must still parse cleanly.
    const md = [
      '## Fix Review Log — GAN-114',
      'Triggered by: initial',
      '',
      '### Comment 1 [GENERAL]',
      'Status: FIXED',
      'Catatan: catatan panjang yang',
      'berlanjut ke baris kedua tanpa blank line lalu',
      '### Comment 2 [GENERAL]',
      'Status: NOT_APPLICABLE',
      'Catatan: catatan kedua.',
    ].join('\n');
    const workspacePath = writeFixReviewLog('GAN-114', md);

    const result = await readFixReviewLog(workspacePath, 'GAN-114');

    expect(result?.entries).toHaveLength(2);
    expect(result?.entries[0].commentRef).toBe('1');
    expect(result?.entries[0].note).toBe('catatan panjang yang berlanjut ke baris kedua tanpa blank line lalu');
    expect(result?.entries[0].note).not.toContain('Comment');
    expect(result?.entries[1].commentRef).toBe('2');
    expect(result?.entries[1].status).toBe('NOT_APPLICABLE');
    expect(result?.entries[1].note).toBe('catatan kedua.');
  });

  it('stops accumulating a wrapped note at a blank line', async () => {
    const md = [
      '## Fix Review Log — GAN-114',
      'Triggered by: initial',
      '',
      '### Comment 1 [GENERAL]',
      'Status: FIXED',
      'Catatan: catatan yang',
      'berlanjut lalu berhenti.',
      '',
      'paragraf lain yang tidak boleh ikut masuk ke note.',
    ].join('\n');
    const workspacePath = writeFixReviewLog('GAN-114', md);

    const result = await readFixReviewLog(workspacePath, 'GAN-114');

    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0].note).toBe('catatan yang berlanjut lalu berhenti.');
  });
});

describe('readInitialReviewReport', () => {
  it.each([
    ['APPROVE', 'Verdict: APPROVE'],
    ['CHANGES_REQUESTED', 'Verdict: CHANGES REQUESTED'],
    ['DEFER', 'Verdict: DEFER'],
  ] as const)('extracts Verdict %s', async (expected, verdictLine) => {
    const md = ['## Review Notes — GAN-114', `Ticket: GAN-114`, 'Agent: caf-reviewer', verdictLine].join('\n');
    const workspacePath = writeReviewNotes('GAN-114', md);

    const result = await readInitialReviewReport(workspacePath, 'GAN-114');

    expect(result?.verdict).toBe(expected);
  });

  it('tolerates markdown emphasis around the verdict value', async () => {
    const md = ['## Review Notes — GAN-114', 'Verdict: **APPROVE**'].join('\n');
    const workspacePath = writeReviewNotes('GAN-114', md);

    const result = await readInitialReviewReport(workspacePath, 'GAN-114');

    expect(result?.verdict).toBe('APPROVE');
  });

  it('returns undefined when review-notes.md does not exist', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'caf-orchestrator-report-reader-test-'));
    dirs.push(workspacePath);

    const result = await readInitialReviewReport(workspacePath, 'GAN-114');

    expect(result).toBeUndefined();
  });

  it('STOPs (throws UnrecognizedVerdictError) on an unrecognized Verdict value, does not default', async () => {
    const md = ['## Review Notes — GAN-114', 'Verdict: NEEDS_HUMAN'].join('\n');
    const workspacePath = writeReviewNotes('GAN-114', md);

    await expect(readInitialReviewReport(workspacePath, 'GAN-114')).rejects.toBeInstanceOf(UnrecognizedVerdictError);
  });

  it('STOPs (throws UnrecognizedVerdictError) when there is no Verdict line at all, does not default', async () => {
    const md = ['## Review Notes — GAN-114', 'Security Audit: none'].join('\n');
    const workspacePath = writeReviewNotes('GAN-114', md);

    await expect(readInitialReviewReport(workspacePath, 'GAN-114')).rejects.toBeInstanceOf(UnrecognizedVerdictError);
  });
});
