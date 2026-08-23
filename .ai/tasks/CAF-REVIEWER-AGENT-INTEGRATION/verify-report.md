## Ticket: CAF-REVIEWER-AGENT-INTEGRATION
## Agent: implementation (per plan.md)
## Status: SUCCESS

## Yang diimplementasi

1. `src/infrastructure/reports/report-reader.ts`
   - Tambah `ReviewerVerdict`, `ReviewerReport`, `readReviewerReport()`.
   - Verdict diekstrak HANYA dari baris yang match `Verdict:` (regex
     `VERDICT_LINE = /^.*Verdict:\s*(.+)$/im`), bukan scan bebas seluruh
     dokumen — mencegah false-positive dari kata "approve"/"defer" di
     narasi review-notes.md.
   - Cek "CHANGES REQUESTED" dulu sebelum APPROVE/DEFER (substring safety).
   - Default fail-safe: `CHANGES_REQUESTED` kalau baris Verdict tidak
     ketemu — block pipeline, bukan lolos diam-diam.

2. `src/application/use-cases/run-agent-pipeline.use-case.ts`
   - `MAX_REVIEWER_RETRIES = 1`.
   - Method baru `runReviewerGate()`, mirror `runQaGate()` — run agent
     `'reviewer'`, log result, throw kalau signal/exitCode != 0, baca
     `review-notes.md` via `readReviewerReport`, throw kalau tidak ada.
   - Gate ditaruh SETELAH QA PASS, SEBELUM Docs Tasks check.
   - Retry loop (`while`, sejajar pola QA): `CHANGES_REQUESTED` →
     `runImplementationAgents()` ulang (Frontend/Backend) →
     `runReviewerGate()` lagi — TANPA memanggil `runQaGate()` ulang.
   - Kalau masih `CHANGES_REQUESTED` setelah retry → postComment
     NEEDS_HUMAN, pipeline stop (tanpa commit/push).
   - `APPROVE`/`DEFER` → lanjut ke Docs Tasks check seperti biasa.
   - Comment sukses akhir menyertakan `reviewerReport.raw` selain
     `qaReport.raw`.

3. `tests/unit/run-agent-pipeline.use-case.test.ts`
   - Mock `readReviewerReportMock`, default `APPROVE` di `beforeEach`.
   - 5 test case baru:
     - APPROVE first try → docs → success
     - DEFER first try → docs → success (tanpa retry)
     - CHANGES_REQUESTED sekali → retry → APPROVE → success, QA
       tidak dipanggil ulang (`qaCalls` length 1)
     - CHANGES_REQUESTED dua kali → NEEDS_HUMAN, no commit/push, QA
       tidak dipanggil ulang
     - Missing `review-notes.md` → throws `/No review-notes.md produced/`

## Verifikasi

- `tsc --noEmit` — PASS, no errors.
- `vitest run` — PASS (35 tests, 0 failed).
- `eslint src --ext .ts` (via `rtk proxy` karena rtk filter default
  eslint sempat OOM di wrapper) — PASS, no lint errors (hanya warning
  ESM/CJS module-type pre-existing, tidak terkait perubahan ini).

## Deviasi dari plan.md

- Regex verdict diperketat ke baris `Verdict:` saja (bukan scan bebas
  seluruh raw text) sesuai instruksi perbaikan di prompt implementasi —
  plan.md draf awal pakai regex bebas tanpa anchor baris.
