# Plan: Reviewer Agent gate ke pipeline

Retry rule: CHANGES_REQUESTED → retry Frontend/Backend 1x → reviewer lagi
(TANPA QA ulang). Kedua kali masih CHANGES_REQUESTED → NEEDS_HUMAN, stop.
APPROVE/DEFER → lanjut Docs Agent.

## 1. report-reader.ts — tambah readReviewerReport

Mirror `readQaReport` (src/infrastructure/reports/report-reader.ts:46).

```ts
export type ReviewerVerdict = 'APPROVE' | 'CHANGES_REQUESTED' | 'DEFER';

export interface ReviewerReport {
  verdict: ReviewerVerdict;
  raw: string;
}

export async function readReviewerReport(workspacePath: string, ticketKey: string): Promise<ReviewerReport | undefined> {
  const raw = await readIfExists(join(taskDir(workspacePath, ticketKey), 'review-notes.md'));
  if (raw === undefined) return undefined;

  let verdict: ReviewerVerdict = 'CHANGES_REQUESTED';
  if (/CHANGES REQUESTED/i.test(raw)) verdict = 'CHANGES_REQUESTED';
  else if (/\bAPPROVE\b/i.test(raw)) verdict = 'APPROVE';
  else if (/\bDEFER\b/i.test(raw)) verdict = 'DEFER';

  return { verdict, raw };
}
```

Cek "CHANGES REQUESTED" dulu (dua kata) sebelum APPROVE/DEFER — reviewer.md
template pakai wording `## Verdict: APPROVE / CHANGES REQUESTED / DEFER`,
jangan sampai regex APPROVE ke-match duluan di teks lain.

## 2. run-agent-pipeline.use-case.ts — runReviewerGate + retry loop

Import `readReviewerReport`, `type ReviewerReport` dari report-reader.js.

Constant baru: `const MAX_REVIEWER_RETRIES = 1;` (sejajar `MAX_QA_RETRIES`).

Method baru, mirror `runQaGate` (baris 260-300):

```ts
private async runReviewerGate(repoPath: string, job: JobPayload): Promise<ReviewerReport> {
  const { agentRunner } = this.deps;

  const reviewerPrompt = `Review implementasi untuk ticket ${job.ticketKey} sesuai .ai/tasks/${job.ticketKey}/ dan tulis .ai/tasks/${job.ticketKey}/review-notes.md.`;
  const reviewerResult = await agentRunner.run('reviewer', repoPath, reviewerPrompt);
  // log result + error sama pola runQaGate (info + error jika signal/exitCode!=0)
  if (reviewerResult.signal) throw new Error(`reviewer agent killed by signal ${reviewerResult.signal}`);
  if (reviewerResult.exitCode !== 0) throw new Error(`reviewer agent exited with code ${reviewerResult.exitCode}: ${reviewerResult.stderr}`);

  const reviewerReport = await readReviewerReport(repoPath, job.ticketKey);
  if (!reviewerReport) throw new Error('No review-notes.md produced');

  return reviewerReport;
}
```

Di `execute()`, tempatkan SETELAH QA PASS block (setelah baris 137, sebelum
`let docsNote = ...` baris 139):

```ts
let reviewerRetryCount = 0;
let reviewerReport = await this.runReviewerGate(repoPath, job);

if (reviewerReport.verdict === 'CHANGES_REQUESTED' && reviewerRetryCount < MAX_REVIEWER_RETRIES) {
  reviewerRetryCount += 1;
  logger.info('Reviewer requested changes — retrying implementation agents', undefined, {
    jobId: job.jobId,
    ticketKey: job.ticketKey,
    reviewerRetryCount,
  });
  await this.runImplementationAgents(agentsToRun, repoPath, implementationPrompt, job);
  reviewerReport = await this.runReviewerGate(repoPath, job); // TANPA runQaGate lagi
}

if (reviewerReport.verdict === 'CHANGES_REQUESTED') {
  await linearClient.postComment(
    job.ticketId,
    `Agent pipeline needs human review (reviewer requested changes after retry):\n\n${reviewerReport.raw}`,
  );
  logger.info('Pipeline stopped: reviewer requested changes after retry', undefined, {
    jobId: job.jobId,
    ticketKey: job.ticketKey,
    reviewerRetryCount,
  });
  return;
}
```

Catatan beda dari pola QA: QA pakai `while` (retry sampai MAX_QA_RETRIES
habis kalau tetap FAIL berkali-kali dalam 1 loop), reviewer di sini cukup
`if` sekali karena MAX_REVIEWER_RETRIES = 1 dan sudah eksplisit stop setelah
1x retry sesuai keputusan. Boleh pakai `while` juga demi simetri kalau mau
future-proof MAX_REVIEWER_RETRIES > 1 — pilih `while` supaya konsisten
dengan runQaGate.

Final postComment sukses (baris ~185-188) tambahkan info reviewer verdict,
opsional: sertakan `reviewerReport.raw` di pesan sukses juga (biar Linear
comment ada jejak review).

## 3. Tempat di alur execute()

```
verify NEEDS_HUMAN check (baris 100-110)
  ↓
QA gate + retry (baris 112-137)
  ↓
[BARU] Reviewer gate + retry (APPROVE/DEFER lanjut, CHANGES_REQUESTED retry 1x)
  ↓
Docs Tasks check (baris 139+)
  ↓
commit + push
```

## 4. Test — tests/unit/run-agent-pipeline.use-case.test.ts

Tambah mock `readReviewerReportMock` di vi.mock report-reader block (baris
28-35), default di beforeEach:
`readReviewerReportMock.mockResolvedValue({ verdict: 'APPROVE', raw: 'APPROVE: looks good' });`

Case baru (mirror pola QA di baris 281-339):

1. **Reviewer APPROVE first try → docs → success**
   - default mock sudah APPROVE, cek `agentRunner.run` dipanggil dengan
     `'reviewer'`, `gitService.commitAll` terpanggil 1x, tidak ada retry
     backend/frontend tambahan (backendCalls length 1).

2. **Reviewer DEFER first try → docs → success (tanpa retry)**
   - `readReviewerReportMock.mockResolvedValue({ verdict: 'DEFER', raw: 'DEFER: minor' })`
   - assert reviewerCalls length 1, backendCalls length 1, commitAll called.

3. **Reviewer CHANGES_REQUESTED sekali → retry → APPROVE → docs → success**
   - `readReviewerReportMock.mockResolvedValueOnce({ verdict: 'CHANGES_REQUESTED', raw: '...' }).mockResolvedValueOnce({ verdict: 'APPROVE', raw: 'APPROVE: fixed' })`
   - assert: reviewerCalls length 2, backendCalls length 2 (1 initial + 1
     retry-for-reviewer, di atas backend call dari QA retry kalau ada — pastikan
     QA tidak retry di case ini, jadi total backendCalls = 2), qaCalls length 1
     (PENTING: pastikan QA TIDAK dipanggil ulang saat reviewer retry).
   - commitAll called 1x, notifyPipelineComplete called 1x.

4. **Reviewer CHANGES_REQUESTED dua kali → NEEDS_HUMAN, no commit/push**
   - `readReviewerReportMock.mockResolvedValue({ verdict: 'CHANGES_REQUESTED', raw: 'CHANGES REQUESTED: still broken' })`
   - assert reviewerCalls length 2, backendCalls length 2, qaCalls length 1
     (QA tidak diulang), commitAll/push NOT called, notifyPipelineComplete
     NOT called, postComment berisi
     "needs human review (reviewer requested changes after retry)".

5. **Missing review-notes.md → throws**
   - `readReviewerReportMock.mockResolvedValue(undefined)`
   - `await expect(useCase.execute(makeJob())).rejects.toThrow(/No review-notes.md produced/)`
   - notifyPipelineFailed called 1x.

Semua case pakai `readQaReportMock` default PASS supaya reviewer gate
kepanggil (gate reviewer ada SETELAH QA PASS).

## Risiko / hal yang perlu dicek pas implementasi

- Regex verdict: pastikan "CHANGES REQUESTED" (spasi, dari template
  reviewer.md) match, bukan cuma varian underscore.
- Jangan panggil `runQaGate()` di jalur retry reviewer — beda dari asumsi
  awal kalau asal copy-paste pola while QA.
- `agentsToRun` dan `implementationPrompt` sudah ada di scope `execute()`
  (baris 86, 91) — reviewer retry re-use variable yang sama, tidak perlu
  re-route tasks.
