# Verify Report — Fix 2 Gap dari audit-report.md

Tanggal: 2026-07-04. `tsc --noEmit`: no errors.

## 1. BullMQ retry attempts: 2 → 3

File: `src/infrastructure/queue/client.ts:22`
- Diubah `attempts: 2` → `attempts: 3`, sesuai pola PIV retry-max-3x.
- Komentar di atasnya diupdate (line 18-21) buat reflect angka baru.
- Status: FIXED.

## 2. Caller spawnAgentService.run() — stdout/stderr logging

Caller ditemukan: `src/application/use-cases/run-agent-pipeline.use-case.ts`
(dipanggil via `agentRunner.run(...)`, interface `IAgentRunner` di
`src/domain/interfaces/agent-runner.interface.ts`, implementasi
`SpawnAgentService` di `src/infrastructure/agent/spawn-agent.service.ts`).

Temuan sebelum fix: saat `plannerResult.signal` atau `exitCode !== 0`
(line 44-49, dan loop agent lain line 63-68 lama), cuma `throw new Error(...)`
yang isi pesannya `stderr` doang (dipotong jadi string di dalam Error
message). `stdout` TIDAK PERNAH di-log sama sekali — hilang total kalau
agent gagal tapi nulis error/context penting ke stdout (bukan stderr).
Error di-log ulang di `catch` block (line 105-111 lama) tapi cuma
`err.message`, jadi stdout tetap gak ke-capture di manapun.

Fix diterapkan (`run-agent-pipeline.use-case.ts`):
- Sebelum `throw` di planner block dan di loop `agentsToRun`, ditambahkan
  `logger.error(...)` eksplisit dengan structured fields: `jobId`,
  `ticketKey`, `agentName`, `exitCode`, `signal`, `timedOut`, `stdout`,
  `stderr` (full, bukan dipotong).
- Ini jalan SEBELUM `throw`, jadi ke-log walau BullMQ retry job (attempt
  1, 2, 3 masing-masing bakal punya log entry sendiri dengan stdout/stderr
  lengkap — bukan cuma error message generik dari BullMQ `job.failed` event
  di `worker.ts`).

Persistensi log: logger pakai pino (`src/infrastructure/logging/logger.ts`),
nulis ke stdout proses worker. Belum ada file transport eksplisit di kode
ini — persistensi jangka panjang (rotasi/retention) tergantung gimana
proses worker dijalankan di deploy (systemd journal, docker log driver,
dsb), itu di luar scope kode aplikasi. Kalau butuh guarantee lebih kuat
(misal log tetap ada meski proses/container hilang), perlu keputusan
terpisah soal log shipping — bukan bagian dari fix ini.

Status: FIXED (structured logging ditambahkan). Persistensi storage log
di luar kode tetap tanggung jawab ops/deploy config, dicatat sebagai
catatan bukan gap kode.

## 3. lockDuration buffer (minor, opsional)

File: `src/infrastructure/queue/worker.ts:12`
- `LOCK_DURATION_MS` diubah dari `30 * 60_000` → `35 * 60_000` (35 menit),
  kasih buffer 5 menit di atas `CLAUDE_AGENT_TIMEOUT_MS` default (30 menit)
  supaya BullMQ gak flag job stalled pas spawn-agent lagi di jendela
  SIGTERM→SIGKILL escalation (10 detik) + overhead lain.
- Komentar diupdate jelasin alasan angka 35 menit.
- Status: FIXED.

## Ringkasan

| # | Item | Status |
|---|------|--------|
| 1 | attempts 2→3 (client.ts:22) | FIXED |
| 2 | stdout/stderr logging di caller (run-agent-pipeline.use-case.ts) | FIXED |
| 3 | lockDuration 30→35 menit (worker.ts:12) | FIXED |

## Test Suite (`pnpm test`)

Dijalankan `pnpm test` (`vitest run`): **exit code 1 — "No test files found"**.
Bukan test failure — repo belum punya file `*.test.ts`/`*.spec.ts` sama
sekali (`tests/` cuma berisi fixture JSON, dikonfirmasi di audit
sebelumnya). Ini state pre-existing sebelum 3 perubahan di atas (project
belum ada commit sama sekali — `git status`: "No commits yet on main"),
bukan regresi dari fix ini.

Karena gak ada test file, gak ada nilai hardcoded `attempts`/`lockDuration`
di test manapun yang perlu disesuaikan (poin #2 dari instruksi) — dicek
via grep, nol match di luar source file yang memang diubah.

Verifikasi pengganti yang dijalankan:
- `pnpm typecheck` (`tsc --noEmit`) → **PASS**, no errors.
- `pnpm lint` (`eslint src --ext .ts`) → **PASS**, 0 error/warning
  (cuma warning Node soal `MODULE_TYPELESS_PACKAGE_JSON` di eslint
  config loader, gak related ke source code, pre-existing).

## Update — Unit Test Ditambahkan

Ketiga file "belum ada test" di atas sekarang punya coverage:

- `tests/unit/security.test.ts` — `verifyLinearSignature` (valid, wrong
  secret, tampered body, missing header, malformed hex, length-mismatch
  no-crash) + `isLinearTimestampFresh` (now, boundary tepat 60s, 1ms
  lewat boundary, future clock skew, missing header, non-numeric).
  Pakai fixture `tests/fixtures/linear-issue-update-ready-for-ai.json`
  sebagai raw body yang beneran ditandatangani ulang di test (bukan
  re-stringify), jadi test juga memverifikasi kontrak "sign raw bytes".
- `tests/unit/delivery-dedupe.test.ts` — `claimDelivery` dengan fake
  in-memory Redis (mock `getRedisClient`, implementasi `SET NX EX`
  yang sama semantiknya): UUID baru → claim sukses, UUID sama → reject,
  TTL habis (advance waktu palsu 24h+1ms) → boleh claim lagi.
- `tests/unit/run-agent-pipeline.use-case.test.ts` — 3 skenario:
  exitCode 0 (full success path, notifier.notifyPipelineComplete
  terpanggil, tidak ada logger.error), exitCode non-zero (assert
  logger.error terpanggil dengan field `stdout`/`stderr` full-text,
  bukan cuma potongan di Error message — ini yang langsung verifikasi
  fix gap #2 dari audit), dan signal SIGKILL (assert field `signal`+
  `timedOut` ke-log, retry policy diverifikasi via reject-throw yang
  akan bikin BullMQ retry, bukan resume-from-step).

Tambahan infrastruktur test: `tests/setup.ts` (env var default biar
`src/config/index.ts` bisa load pas test tanpa `.env` asli) di-wire
lewat `vitest.config.ts` `setupFiles`.

Hasil run: `pnpm test` → **3 test files, 18 tests, semua PASS**, exit
code 0. `pnpm typecheck` PASS, `pnpm lint` PASS.

## Kesimpulan sebelum commit

| Check | Result |
|---|---|
| `pnpm test` | PASS — 3 files / 18 tests |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |

Rekomendasi: aman untuk commit. History note: 3 fix (client.ts,
worker.ts, run-agent-pipeline.use-case.ts) sudah kebawa gabung di commit
`3f0f0be` ("first commit") sebelum sempat dipisah — user memutuskan
skip history rewrite, tes baru di atas jadi commit terpisah berikutnya.
