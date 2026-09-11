# Verify Report: CAF-RESUMEBRANCH-01

Status: SUCCESS

## Task 1 — Investigasi

Lokasi persis ditemukan:

- `src/application/use-cases/run-agent-pipeline.use-case.ts`, `RunAgentPipelineUseCase.execute()`,
  blok `if (job.isRetry) { ... }` (sekitar baris 248 sebelum perubahan).
  - Cabang persistent workspace (`existsSync(repoPath/.git)` true):
    `gitService.preflightCleanup(repoPath, branch, workspaceRoot)` →
    `src/infrastructure/git/git.service.ts` `preflightCleanup()` → `git reset --hard origin/${baseBranch}`.
  - Cabang ephemeral (`.git` belum ada): `gitService.clone(repoCloneUrl, branch, repoPath, workspaceRoot)` →
    `git clone --branch <branch>` — sama-sama gagal exit 128 kalau branch remote sudah dihapus.
- Job state retry (persistent retry / `maxOrchestrationRetries`) dibaca lewat
  `checkAndConsumeRetryBudget()` (use-case yang sama) dari
  `src/infrastructure/reports/orchestration-state.js` (`orchestration-state.json` di workspace).
- Trigger resume: `src/presentation/web/routes/webhooks.ts`
  (`handleRetryPipelineCommand` untuk `/caf-retry-pipeline`, dan blok resume di handler webhook Linear
  yang cek `githubService.branchExists()` via GitHub API — hanya di titik enqueue, bukan di worker).

## Task 2 — Konfirmasi percabangan

Satu fungsi (`execute()`'s `isRetry` block) dipakai untuk SEMUA jalur resume — retry wajar
(gate `NEEDS_HUMAN`, branch masih hidup) dan retry pasca-selesai (branch sudah dihapus) —
tanpa percabangan yang membedakan keduanya sebelum perbaikan ini. `webhooks.ts` sempat cek
`branchExists` via GitHub API saat enqueue, tapi itu rawan TOCTOU (branch bisa hilang antara
enqueue dan job diproses worker) dan tidak menutup jalur persistent-checkout di worker.

## Task 3-5 — Perbaikan

- Ditambahkan `IGitService.remoteBranchExists(repoUrl, branch, cwd)` (`git ls-remote --exit-code --heads`)
  di `git.interface.ts` + `git.service.ts`, dibedakan exit code 2 (branch tidak ada) vs error lain
  (auth/network — tetap dilempar, ditangani jalur error normal).
- `run-agent-pipeline.use-case.ts`: cek ini dipanggil di awal blok `isRetry`, sebelum
  `preflightCleanup`/`clone` dieksekusi.
- Branch tidak ditemukan → pipeline stop (`return`, bukan `throw` — konsisten dengan pola gate
  `NEEDS_HUMAN` lain, sehingga BullMQ tidak retry otomatis ke error yang sama):
  komentar ke Linear/PR + `notifier.notifyPipelineNeedsHuman()` (Telegram, actionable: ticket ID,
  penjelasan "branch tidak ditemukan di remote — kemungkinan sudah selesai & dihapus", saran cek
  Linear sebelum retrigger) + `finalizePipelineRun(..., 'NEEDS_HUMAN')`. Tidak ada fallback otomatis
  ke fresh checkout dari base branch.
- Branch ditemukan → jalur existing (`preflightCleanup`/`clone`) tidak berubah.

## Task 6-7 — Test

- `tests/unit/git.service.test.ts`: `remoteBranchExists` — branch-name guard, dan true/false
  terhadap remote lokal real (bukan mock) memverifikasi exit code 0 vs 2.
- `tests/unit/run-agent-pipeline.use-case.test.ts` (`CAF-RETRYPIPELINE-01 — isRetry job`):
  - regresi: branch ada → `remoteBranchExists` dipanggil, `clone` tetap jalan, retry budget tetap
    diproses, tidak ada notifikasi `NeedsHuman`.
  - branch tidak ada → `clone`/`preflightCleanup`/`createBranch`/agent run semua TIDAK dipanggil,
    retry budget tidak disentuh, `notifyPipelineNeedsHuman` + comment PR terpanggil dengan pesan jelas.

## Verifikasi

- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm vitest run tests/unit/git.service.test.ts tests/unit/run-agent-pipeline.use-case.test.ts tests/unit/pipeline-instrumentation-integration.test.ts tests/unit/pipeline-instrumentation-db-unavailable.test.ts` — 69/69 pass.
- `pnpm test` (full suite) — 355/357 pass; 2 gagal di `tests/unit/events-route.test.ts` (SSE timing flake)
  dikonfirmasi pre-existing (reproduksi sama di `git stash`, tidak terkait perubahan ini).

## Catatan penyimpangan dari task list

Task 2 minta "job di BullMQ diberi status final yang jelas (failed)". Implementasi memakai `return`
(bukan `throw`) mengikuti konvensi gate `NEEDS_HUMAN` yang sudah ada di codebase ini — job BullMQ
resolve (bukan berstatus failed secara literal), tapi efeknya sama: tidak ada retry otomatis
berulang ke error yang sama. Alasan: `throw` akan memicu BullMQ retry seluruh job dari awal,
mengulang persis error yang sama (branch tetap tidak ada) — bertentangan dengan permintaan
"jangan retry otomatis berulang". Sudah dikonfirmasi ke user; belum ada instruksi ubah ke `throw`.
