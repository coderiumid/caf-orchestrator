## Ticket: CAF-WSMODE-01
## Status: NEEDS_HUMAN

## Attempt Log
- Task 0 (STOP items): dijawab user langsung (bukan trial), dicatat di `requirements.md`
  bagian "Pertanyaan Terbuka" (2026-09-03):
  1. Path scheme: Opsi B (nama repo GitHub).
  2. Topology: single VPS instance → lock in-memory.
  3. Lock-busy behavior: reject langsung + comment ke ticket.
- Task 1 (Config Schema): berhasil first attempt. `pnpm typecheck`/`lint`/`test` pass.
- Task 2 (Lock Mechanism): berhasil first attempt. Diimplementasi sebagai unit
  `WorkspaceLock` (in-memory `Map`) yang berdiri sendiri — TIDAK diwiring ke titik
  masuk job, sengaja ditunda ke Task 4 karena wiring itu eksplisit tugas Task 4 di
  `tasks.md`. `pnpm typecheck`/`lint`/`test` pass (229/229 → 5 test baru).
- Task 3 (Pre-flight Cleanup): berhasil first attempt. `GitService.preflightCleanup()`
  diuji pakai repo git nyata (bare remote + clone lokal, bukan mock), sesuai prinsip
  "fixture passing ≠ safe" di `design.md`. `pnpm typecheck`/`lint`/`test` pass
  (231/231 → 2 test baru).
- Task 4 (Percabangan Ephemeral vs Persistent): **STOP sebelum coding apapun** —
  ditemukan gap desain yang bikin task ini tidak bisa diselesaikan tanpa menyentuh
  file yang eksplisit out-of-scope. Detail di bagian "Catatan" di bawah. User diberi
  3 opsi (perluas scope / diam-diam mode-aware tanpa comment ke ticket / stop dan
  laporkan) — user memilih **stop dan laporkan sebagai NEEDS_HUMAN**.
- Task 5, 6: tidak dikerjakan — bergantung pada Task 4.

## Acceptance Criteria
(dari `requirements.md`)

- [x] `workspace.mode` bisa diset `ephemeral`/`persistent` di `caf.config.yaml`,
      divalidasi via zod — bukti: `src/config/schema.ts` (`workspace.mode:
      z.enum(['ephemeral','persistent']).default('ephemeral')`, di dalam blok
      `workspace` yang sudah ada)
- [x] `workspace.mode` di-omit → behavior identik dengan sebelum perubahan (default
      `ephemeral`) — bukti: `caf.config.yaml` (config aktual project ini) tidak
      punya field `mode` sama sekali dan tetap valid via default zod; `pnpm test`
      224→229→231 pass sepanjang Task 1–3 tanpa regresi
- [ ] Mode `persistent`: job kedua untuk repo yang sama TIDAK bisa mulai eksekusi
      selama lock dipegang job pertama — **primitive lock sudah ada dan teruji**
      (`src/infrastructure/git/workspace-lock.ts`,
      `tests/unit/workspace-lock.test.ts`), TAPI belum diwiring ke titik masuk job
      nyata (blocked di Task 4, lihat Catatan)
- [ ] Mode `persistent`: pre-flight cleanup (fetch + reset + clean) hasilnya di-log
      eksplisit — **logic sudah ada dan teruji dengan repo git nyata**
      (`GitService.preflightCleanup()` di `src/infrastructure/git/git.service.ts`,
      `tests/unit/git-preflight-cleanup.test.ts`), TAPI belum dipanggil dari alur
      job nyata (blocked di Task 4)
- [ ] Mode `persistent`: job `NEEDS_HUMAN` dengan uncommitted/unpushed changes →
      pre-flight cleanup tidak diam-diam menghapus tanpa jejak — **audit-trail
      logging sudah diimplementasi & diverifikasi** (`logger.warn` sebelum
      `reset --hard`, dites di `git-preflight-cleanup.test.ts`: kasus dirty vs
      clean), TAPI belum terhubung ke skenario end-to-end nyata (blocked di Task 4)
- [x] `caf-initiator` — TIDAK ADA perubahan (repo terpisah, tidak pernah dibuka/
      disentuh sesi ini)
- [x] Dokumentasi: `caf.config.example.yaml` diupdate — bukti:
      `caf.config.example.yaml` blok `workspace:` (komentar penjelasan
      `ephemeral` vs `persistent`)

## Quality Gate
- Lint: PASS
- Typecheck: PASS
- Test: PASS (231/231 — Task 1–3 saja; Task 4 tidak menambah kode produksi)

## Catatan

### Kenapa Task 4 di-STOP (gap desain, bukan kegagalan implementasi)

Saat mulai Task 4 (baca `workspace.mode`, branch ephemeral/persistent di
`workspace.manager.ts`), ditemukan bahwa integrasi penuh **tidak bisa dilakukan
tanpa menyentuh salah satu file yang eksplisit out-of-scope**:

1. **`run-agent-pipeline.use-case.ts:515`** memanggil
   `workspaceManager.cleanupWorkspace(workspacePath, workspaceRoot)` di blok
   `finally` — unconditional, jalan tiap job selesai (sukses maupun gagal).
   Implementasi `cleanupWorkspace()` saat ini `rm -rf` seluruh workspace. Mode
   `persistent` butuh workspace **tetap ada** untuk direuse job berikutnya — jadi
   perilaku ini harus berbeda tergantung mode, tapi titik panggilnya ada di file
   terlarang.

2. **Efek rambatan ke `RunPrReviewUseCase`** (juga eksplisit out-of-scope):
   `WorkspaceManager` dan `GitService` adalah singleton yang dipakai bersama oleh
   `run-agent-pipeline.use-case.ts` DAN `run-pr-review.use-case.ts`. Cara satu-
   satunya menghindari edit ke 2 file itu adalah membuat `createWorkspace()` /
   `cleanupWorkspace()` / `clone()` di `workspace.manager.ts` /`git.service.ts`
   baca `config.workspace.mode` sendiri secara internal — tapi itu berarti begitu
   `workspace.mode: persistent` di-set secara global, behavior PR-review job (yang
   pakai instance `WorkspaceManager`/`GitService` yang sama) ikut berubah diam-diam,
   walau filenya sendiri tidak pernah diedit. `requirements.md` mengasumsikan
   fitur ini scope-nya "single-repo-per-instance" tapi tidak membahas bahwa
   `RunPrReviewUseCase` berbagi infrastruktur yang sama.

3. **`createWorkspace()` dipanggil sebelum blok `try` dimulai**
   (`run-agent-pipeline.use-case.ts:149` vs `try` di baris 159). Kalau lock reject
   (`WorkspaceLockError`) dilempar dari situ sesuai keputusan Task 0 ("reject
   langsung + comment ke ticket"), exception itu propagate uncaught — tidak ada
   comment yang pernah terkirim ke Linear. Ia cuma numpang ke retry generik BullMQ
   (`jobAttempts: 3`) lalu job mati kalau lock masih dipegang saat retry terakhir.
   Acceptance criteria "reject + comment" secara harfiah tidak bisa dipenuhi tanpa
   menambah try/catch di file itu.

### Kode yang SUDAH ada dan aman dipakai
Task 1–3 selesai penuh, teruji, tidak menyentuh file terlarang, dan tidak mengubah
behavior `ephemeral` (default) sama sekali — semuanya siap dipakai begitu keputusan
scope di atas dibuat:
- `src/config/schema.ts` — `workspace.mode` field
- `src/infrastructure/git/workspace-lock.ts` — `WorkspaceLock` (in-memory,
  reject-immediately)
- `src/infrastructure/git/git.service.ts` — `preflightCleanup()` (fetch, audit-trail
  log, checkout+reset+clean)
- `src/domain/interfaces/git.interface.ts` — `IWorkspaceLock`,
  `PreflightCleanupResult`, `IGitService.preflightCleanup`
- `src/domain/errors/app-errors.ts` — `WorkspaceLockError`

### Rekomendasi
Ticket ini butuh keputusan scope eksplisit sebelum Task 4 bisa lanjut — salah satu:
(a) izinkan sentuhan minimal & terisolasi ke `run-agent-pipeline.use-case.ts`
(skip cleanup saat persistent + catch `WorkspaceLockError` → comment), dengan
`RunPrReviewUseCase` tetap tidak disentuh; atau
(b) terima bahwa `workspace.mode: persistent` akan mempengaruhi `RunPrReviewUseCase`
secara behavior (walau filenya tidak diedit) dan longgarkan syarat "reject +
comment" jadi "reject via retry BullMQ tanpa comment eksplisit"; atau
(c) revisi requirements.md dulu untuk mendefinisikan ulang batas scope ini secara
sadar, baru lanjut implementasi.

Diff akhir sesi ini (`git status --short`):
```
 M caf.config.example.yaml
 M src/config/schema.ts
 M src/domain/errors/app-errors.ts
 M src/domain/interfaces/git.interface.ts
 M src/infrastructure/git/git.service.ts
?? src/infrastructure/git/workspace-lock.ts
?? tests/unit/git-preflight-cleanup.test.ts
?? tests/unit/workspace-lock.test.ts
```
Tidak ada file `caf-initiator`, `report-reader.ts`, `run-agent-pipeline.use-case.ts`,
atau `RunPrReviewUseCase`/`run-pr-review.use-case.ts` dalam daftar di atas —
dikonfirmasi.
