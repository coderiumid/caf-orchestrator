## Verify Report — CAF-ORCH-PRREVIEW-03
Status: SUCCESS

**Riwayat**: menggantikan `CAF-ORCH-PRREVIEW-01` (dibatalkan, premis salah total) dan
`CAF-ORCH-PRREVIEW-02` (STOPPED di Task 1, premis "1 titik output" salah). Ticket ini
diinvestigasi ulang dari Task 1 (tidak mengasumsikan temuan `-02` final) — premis kali ini
terkonfirmasi benar di kode: `buildReviewerPrompt()` di `run-pr-review.use-case.ts` memang
memperlakukan mode `initial` sama seperti `scoped`/`global` (fix-review-log, bukan INITIAL
sungguhan), sebelum perubahan ini.

## Acceptance Criteria — bukti

- **Mode `initial` menjalankan `caf-reviewer` mode INITIAL sungguhan, dibuktikan lewat prompt**
  `run-pr-review.use-case.ts` — `buildReviewerPrompt()` bercabang: `mode === 'initial'` →
  `buildInitialReviewPrompt()` (prompt eksplisit "Mode INITIAL", instruksi menulis
  `review-notes.md` format Verdict/Security Audit/Qualitative Review/Verdict Rationale/For
  Developer). Test: `tests/unit/run-pr-review.use-case.test.ts` — "sends an INITIAL-mode prompt
  (empty commentContext, review-notes.md instructions) distinct from fix-review-log".

- **`review-notes.md` terbaca benar, Verdict ter-ekstrak**
  `src/infrastructure/reports/report-reader.ts` — `readInitialReviewReport()` baru (terpisah
  dari `readReviewerReport()` yang sudah ada, dipakai pre-PR gate — tidak disentuh). Test:
  `tests/unit/report-reader.test.ts` — extract 3 verdict value + toleransi markdown emphasis.

- **Verdict → event mapping identik `review-command.js`**
  `VERDICT_TO_EVENT` di `run-pr-review.use-case.ts`: APPROVE→APPROVE, CHANGES_REQUESTED→
  REQUEST_CHANGES, DEFER→COMMENT — persis tabel di `caf-initiator/src/templates/
  review-command.js` (dibaca langsung dari sumbernya di Task 1, bukan diinterpretasi ulang).
  Test: parametrized 3 kasus di `run-pr-review.use-case.test.ts`.

- **PR Review object terposting via `POST pulls/{number}/reviews`**
  `IVcsClient.createPullRequestReview()` baru + `GithubService` implementasi (fetch POST ke
  `/repos/{owner}/{repo}/pulls/{number}/reviews`). Test: `github-service.test.ts` — endpoint +
  payload dicek eksplisit.

- **422 self-review ditangani, tidak crash/mati diam-diam**
  `SelfReviewRejectedError` (domain/errors) dilempar `GithubService.createPullRequestReview()`
  saat body 422 mengandung salah satu dari 2 pesan self-review persis (dikonfirmasi dari
  `review-command.js`). `RunPrReviewUseCase.postInitialReview()` menangkapnya, auto-fallback
  `event: COMMENT` dengan Verdict asli dinyatakan eksplisit di baris pertama body — sesuai
  Keputusan Final requirements.md (2026-09-04), tanpa langkah interaktif. Test: "auto-falls back
  to event COMMENT with the real Verdict stated explicitly when GitHub rejects a self-review
  (422)" + `github-service.test.ts` 422-detection test (2 event × pesan spesifik).

- **Mode `scoped`/`global` TIDAK berubah — regression test eksplisit**
  `buildFixReviewPrompt()` (rename dari `buildReviewerPrompt()` lama, body tidak diubah sama
  sekali) hanya reachable untuk `scoped`/`global`. `postFixReview()` (extract method, logic
  identik) — sama persis: `readFixReviewLog` → reply INLINE → `postIssueComment`. Semua test
  regresi existing (7 test lama untuk fix-review-log contract) tetap pass tanpa modifikasi
  assertion, plus 1 test baru eksplisit membandingkan prompt `scoped` vs `global` tidak
  mengandung jejak kontrak `initial`.

- **NEEDS_HUMAN-style handling untuk Verdict tidak dikenali/tidak ada**
  `readInitialReviewReport()` melempar `UnrecognizedVerdictError` (bukan default ke event
  manapun) baik saat tidak ada baris `Verdict:` sama sekali maupun saat nilainya tidak persis
  cocok APPROVE/CHANGES REQUESTED/DEFER — sesuai `review-command.js` ("STOP, show raw Verdict,
  jangan default"). Error ini propagate lewat `execute()` catch → `notifyPrReviewFailed` +
  rethrow (pola STOP-on-crash yang sama dipakai error lain di file ini, mis. "No
  fix-review-log.md produced"). Test: 2 kasus di `report-reader.test.ts` + 1 kasus propagasi di
  `run-pr-review.use-case.test.ts`.

## Non-negotiable — bukti tambahan

- **Verdict→event mapping tidak diinterpretasi ulang**: dibaca langsung dari
  `caf-initiator/src/templates/review-command.js` baris 209-213 (mapping table) dan 242-263 (422
  detection: pesan `errors[]` persis, bukan cuma status code) sebelum implementasi, dikutip di
  komentar kode.
- **Verdict tak dikenal ≠ 422 self-review** — dua path terpisah di kode: `UnrecognizedVerdictError`
  (dilempar reader, sebelum event dihitung) vs `SelfReviewRejectedError` (dilempar GithubService,
  setelah event dihitung & POST gagal). Tidak digabung, komentar eksplisit di kode menyatakan ini.

## Test suite

```
pnpm typecheck   → clean
pnpm lint        → clean
pnpm test        → 262/262 pass (25 file), +21 test baru untuk ticket ini
```

## File diubah

**caf-orchestrator** (repo ini):
- `src/infrastructure/reports/report-reader.ts` — `readInitialReviewReport()`,
  `UnrecognizedVerdictError` baru; `readReviewerReport()` lama tidak disentuh
- `src/domain/errors/app-errors.ts` — `SelfReviewRejectedError` baru
- `src/domain/interfaces/vcs-client.interface.ts` — `createPullRequestReview` + tipe terkait
- `src/infrastructure/vcs/github.service.ts` — implementasi `createPullRequestReview` + deteksi
  422 self-review
- `src/application/use-cases/run-pr-review.use-case.ts` — percabangan prompt mode `initial` vs
  `scoped`/`global`, `postInitialReview()`/`postFixReview()` (extract), verdict mapping, 422
  fallback
- `tests/unit/run-pr-review.use-case.test.ts` — ditulis ulang: regresi `scoped`/`global` +
  test baru mode `initial`
- `tests/unit/report-reader.test.ts`, `tests/unit/github-service.test.ts` — test baru
- `tests/unit/run-agent-pipeline.use-case.test.ts`, `tests/unit/workspace-mode-integration.test.ts`
  — mock `IVcsClient`/`report-reader` dilengkapi field baru (tidak ada perubahan behavior test)

**caf-initiator** (repo terpisah, dokumentasi saja per Task 6):
- `src/templates/review-command.js` — update komentar Constraints: artifact-contract mismatch
  webhook vs `/caf-review` SUDAH selesai (ticket ini), actor-login idempotency gap MASIH terbuka
  (tidak diklaim ikut selesai)
- `.ai/tasks/CAF-PRREVIEW-01/open-items.md` — entry baru mencatat actor-login idempotency gap
  sebagai item terpisah, eksplisit di luar scope `CAF-ORCH-PRREVIEW-03`

## Eksplisit tidak dikerjakan (sesuai Batasan Scope)

- Idempotency actor-login gap (`caf-initiator`) — dicatat di `open-items.md`, bukan diperbaiki
- `caf-reviewer` agent definition — tidak disentuh sama sekali
- Priority A/B — tidak disentuh
