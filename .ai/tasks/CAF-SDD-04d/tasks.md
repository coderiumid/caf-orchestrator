# CAF-SDD-04d — Tasks

Eksekusi di `caf-orchestrator`. Hanya commit lokal. Jangan push, jangan merge.

## Frontend Tasks
(none)

## Backend Tasks
- T1 (baca dulu, sebelum menyentuh `src/`): verifikasi Assumptions A-1..A-4 dan Findings F-1..F-6 terhadap kode. STOP dan laporkan bila ada temuan yang bertentangan dengan sebuah AC. Catat deviasi bentuk (tidak mengubah AC) di `verify-report.md`.
  - Untuk F-4: daftar setiap jalur di `execute()` yang menolak/berhenti tanpa menjalankan agent pada job `isRetry`/`approveSpec`, termasuk jalur `checkAndConsumeRetryBudget` yang ditolak. Gunakan daftar itu sebagai himpunan AC-14.
  - Untuk A-2: tulis bentuk respons GET PR dan mutasi GraphQL yang dipakai, sebagai fixture test (bukan panggilan jaringan).
- T2 (AC-1..AC-4): ringkasan AC dan Q-1 hanya bila `validationGate === VALIDATOR_GATE`. Untuk gate lain `acSummary` undefined dan `acSummaryText` kosong. Jangan ubah `ac-summary.ts`.
- T3 (AC-5..AC-7): di `stopForSpecIfNeeded`, `DRAFT` dengan `findUnansweredBlockingQuestions(spec).length > 0` menuju `stopForClarification`, sebelum cek label. `APPROVED` dan `NEEDS_HUMAN` tidak berubah (D-6).
- T4 (AC-13..AC-16): pindahkan `recordPipelineStarted` untuk job `isRetry`/`approveSpec` ke titik tepat sebelum agent pertama berjalan (atau sebelum langkah yang menulis ke dashboard), dan hapus `finalizePipelineRun` dari jalur ditolak yang tidak menjalankan agent. Job pertama (bukan resume) tetap memanggilnya seperti sekarang. Komentar penjelasan di PR/ticket tetap diposting, notifier tetap dipanggil bila sudah begitu.
- T5 (AC-8..AC-12): tambah `markPullRequestReadyForReview({ owner, repo, prNumber })` ke `IVcsClient` dan `GithubService` (GET PR → `draft`, `node_id`; bila draft, mutasi GraphQL). Panggil di jalur sukses setelah `updatePullRequest` pada run lanjutan, dibungkus try/catch: kegagalan dicatat (`logger.error`) dan ditambahkan satu kalimat ke komentar sukses. Tidak boleh melempar. Perbarui semua mock/implementasi `IVcsClient` yang ada agar typecheck lulus.
- T6 (AC-3 dan semua AC bertipe test): tulis test sesuai `Verify:`. Setiap perubahan pada test lama dicatat di `verify-report.md` beserta alasannya. Golden/snapshot tidak diubah.
- T7 (AC-17): perbarui `CLAUDE.md` dan `README.md` sesuai AC-17. Ubah kalimat di CLAUDE.md bagian "AC summary" dan "Clarify" yang bertentangan dengan perilaku baru, termasuk baris "The spec Draft PR stays a Draft after success".
- T8 (AC-18): jalankan `pnpm typecheck && pnpm lint && pnpm test`. Tulis `verify-report.md` dengan baris `Status:` polos (`SUCCESS` atau `NEEDS_HUMAN`), tabel per AC (id | status | metode | bukti), dan bagian `### Notes` (deviasi, usulan perubahan spec di baris `Proposed Spec Changes:`).

## Docs Tasks
(none)

## Skip Agents
(none)
