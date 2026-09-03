# Tasks: CAF-WSMODE-01 — Workspace Mode

> Urutan wajib sekuensial. Task 0 adalah gate — tidak boleh lanjut ke Task 1 tanpa
> ketiga STOP item dijawab oleh user.

## Task 0 — Resolusi STOP Items (BLOCKER, bukan tugas coding)
- [ ] User konfirmasi skema path subfolder persistent (Opsi A/B di `design.md`, atau
      alternatif lain)
- [ ] User konfirmasi deployment topology (single instance vs kemungkinan scale-out)
      → menentukan in-memory lock vs Redis-based lock
- [ ] User konfirmasi behavior saat lock terpegang (reject vs queue-with-timeout)

**Tidak boleh lanjut ke Task 1 tanpa ketiganya terjawab eksplisit.**

## Task 1 — Config Schema
- [ ] Tambah field `mode` (enum `ephemeral`/`persistent`, default `ephemeral`) di
      `src/config/schema.ts`, di dalam objek `workspace` yang sudah ada
- [ ] Update file contoh config (cek nama file aktual di repo dulu)
- [ ] Verify: `pnpm typecheck` pass, existing config tanpa field `mode` tetap valid
      (backward compatible)

## Task 2 — Lock Mechanism
- [ ] Implementasi lock sesuai keputusan Task 0 (in-memory atau Redis-based)
- [ ] Fungsi acquire/release, dipanggil di titik masuk job (sebelum workspace dipakai)
- [ ] Behavior saat lock gagal di-acquire sesuai keputusan Task 0 (reject/queue)
- [ ] Unit test: 2 job simulasi rebutan lock yang sama → hanya satu yang jalan
      bersamaan

## Task 3 — Pre-flight Cleanup Logic
- [ ] Implementasi urutan cleanup sesuai `design.md` bagian 4 (fetch → cek
      uncommitted → checkout base → reset hard → clean)
- [ ] Log audit trail SEBELUM destructive reset (branch, status, HEAD commit) ke
      lokasi yang sudah diputuskan (`design.md` bagian 4)
- [ ] Unit test: workspace dengan uncommitted changes → log tercatat dengan benar
      sebelum reset
- [ ] Unit test: workspace bersih (tidak ada uncommitted changes) → cleanup jalan
      tanpa log audit trail yang tidak perlu (jangan spam log untuk kasus normal)

## Task 4 — Percabangan Ephemeral vs Persistent (REVISI setelah Attempt 1 / NEEDS_HUMAN)

> Attempt 1 STOP di sini karena integrasi penuh butuh sentuhan ke 2 file yang saat
> itu masih out-of-scope. Scope sudah resmi diperluas (lihat `requirements.md`
> bagian "Scope Resmi Diperluas") — sub-task di bawah ini gantikan task asli.
> Task 1–3 dari attempt sebelumnya SUDAH SELESAI dan tidak perlu diulang — cek
> `verify-report.md` attempt 1 untuk lokasi kode yang sudah ada:
> `src/infrastructure/git/workspace-lock.ts`, `GitService.preflightCleanup()`,
> `WorkspaceLockError`.

### Task 4a — Tambah parameter `workspacePurpose` di layer domain
- [ ] Tambah type `WorkspacePurpose = 'ticket-pipeline' | 'pr-review'` (lokasi:
      `src/domain/interfaces/git.interface.ts`, dekat interface lain yang sudah
      ditambah di attempt 1)
- [ ] `WorkspaceManager`/`GitService` — fungsi yang relevan (`createWorkspace`,
      `cleanupWorkspace`, `clone`) menerima `workspacePurpose` sebagai parameter
      (BUKAN baca `config.workspace.mode` secara internal — ini sengaja eksplisit
      per-call supaya jelas kelihatan di call-site, bukan behavior tersembunyi)
- [ ] Logic: `persistent` behavior (skip cleanup, reuse folder, acquire lock) HANYA
      aktif kalau `workspacePurpose === 'ticket-pipeline'` DAN
      `config.workspace.mode === 'persistent'`. Kombinasi lain → behavior ephemeral
      seperti sekarang.
- [ ] Unit test: `workspacePurpose: 'pr-review'` + `config.workspace.mode:
      'persistent'` → tetap ephemeral (test ini yang membuktikan acceptance
      criteria baru soal PR-review tidak terpengaruh)

### Task 4b — Wiring di `run-agent-pipeline.use-case.ts` (4 perubahan, TERBATAS)

> Direvisi (semula 3 poin) — ditemukan saat implementasi Task 4a/4b bahwa clone
> call juga perlu jadi kondisional, bukan cuma cleanup. Konsekuensi logis langsung
> dari keputusan "workspace direuse saat persistent", bukan keputusan desain baru.

- [ ] Baris ~149: pass `workspacePurpose: 'ticket-pipeline'` di pemanggilan
      `createWorkspace()`
- [ ] Bungkus pemanggilan `createWorkspace()` dengan `try/catch` khusus
      `WorkspaceLockError` (saat ini di luar blok `try` utama baris 159) →
      `postComment` ke Linear ("workspace busy") lalu `return` (bukan `throw`)
- [ ] Baris ~515 (blok `finally`): panggilan `cleanupWorkspace()` jadi conditional,
      skip kalau `workspacePurpose === 'ticket-pipeline'` DAN mode `persistent`
- [ ] **[BARU]** Baris ~160: clone call jadi conditional — kalau
      `workspacePurpose === 'ticket-pipeline'`, mode `persistent`, DAN workspace
      untuk repo ini sudah pernah di-clone sebelumnya (folder ada) → skip clone,
      panggil `gitService.preflightCleanup()` sebagai gantinya. Selain kombinasi
      itu (termasuk persistent tapi belum pernah di-clone/first-run) → clone
      seperti biasa.
- [ ] **Checkpoint wajib**: tampilkan FULL diff file ini sebelum lanjut, user
      review manual line-by-line (bukan cuma `--stat`) — pastikan TIDAK ada
      perubahan di luar 4 poin di atas, terutama tidak menyentuh retry logic
      (`qaRetryCount`/`reviewerRetryCount`) yang ada di file yang sama

### Task 4c — Wiring di `run-pr-review.use-case.ts` (1 perubahan, TERBATAS)
- [ ] Pass `workspacePurpose: 'pr-review'` di titik pemanggilan
      `WorkspaceManager`/`GitService` yang sesuai
- [ ] **Checkpoint wajib**: tampilkan FULL diff file ini sebelum lanjut, user
      review manual — pastikan hanya 1 baris/parameter ini yang berubah, tidak ada
      logic review lain tersentuh

### Task 4d — Test Integrasi Lintas-Purpose
- [ ] Jalankan skenario: `workspace.mode: persistent`, lalu trigger 1 ticket-
      pipeline job + 1 PR-review job untuk repo yang sama secara berurutan.
      Verifikasi: ticket-pipeline job reuse folder (tidak clone ulang), PR-review
      job tetap clone fresh + cleanup seperti biasa
- [ ] Verifikasi comment "workspace busy" benar-benar terkirim ke Linear saat lock
      ditolak (bukan cuma unit test lock-nya sendiri, tapi end-to-end sampai
      comment API call)

## Task 5 — Verifikasi Regresi
- [ ] Jalankan `pnpm typecheck`, `pnpm lint`, `pnpm test`
- [ ] Regression test end-to-end dengan `mode: ephemeral` (atau field di-omit) —
      pastikan behavior 100% sama dengan sebelum perubahan (bandingkan dengan run
      sebelum ticket ini, kalau ada log/artifact pembanding)
- [ ] Integration test real-repo dengan `mode: persistent` — 2 job berurutan pada
      repo yang sama, verifikasi tidak ada state bocor antar job

## Task 6 — Dokumentasi
- [ ] Update dokumentasi config yaml (contoh + penjelasan kapan pakai `ephemeral`
      vs `persistent`)
- [ ] Catat di PR description / commit message: konfirmasi eksplisit bahwa
      destructive cleanup (`reset --hard`, `clean -fd`) HANYA berlaku di scratch
      space milik orchestrator, bukan folder kerja manusia — sesuai prinsip
      "no auto-clear, no force-overwrite without explicit decision"

## Definition of Done
- Semua quality gate (Task 5) PASS
- Ketiga STOP item di Task 0 terjawab dan terekam (sudah selesai di attempt 1)
- `caf-initiator` tidak tersentuh sama sekali — verifikasi dengan `git diff --stat`
- Tidak ada perubahan di `report-reader.ts` atau retry logic
  (`qaRetryCount`/`reviewerRetryCount`) di `run-agent-pipeline.use-case.ts` —
  verifikasi via `git diff` FULL (bukan cuma `--stat`, karena file ini memang
  berubah sekarang — yang dicek adalah bagian mana yang berubah, bukan apakah
  file ini muncul di daftar)
- Perubahan di `run-agent-pipeline.use-case.ts` PERSIS 4 poin di Task 4b, tidak
  lebih — dikonfirmasi via review manual (Task 4b checkpoint)
- Perubahan di `run-pr-review.use-case.ts` PERSIS 1 poin di Task 4c, tidak lebih —
  dikonfirmasi via review manual (Task 4c checkpoint)
- Acceptance criteria baru soal `workspacePurpose` (PR-review tetap ephemeral) dan
  comment saat lock busy — keduanya PASS dengan bukti test (Task 4a & 4d)