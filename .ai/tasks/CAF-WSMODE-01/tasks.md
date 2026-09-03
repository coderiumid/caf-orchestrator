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

## Task 4 — Percabangan Ephemeral vs Persistent di `workspace.manager.ts`
- [ ] Baca `workspace.mode` dari config
- [ ] `ephemeral` → behavior identik dengan sekarang, tidak ada jalur baru dieksekusi
- [ ] `persistent` → resolve path sesuai keputusan Task 0, acquire lock, jalankan
      pre-flight cleanup, baru checkout branch baru untuk ticket

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
- Ketiga STOP item di Task 0 terjawab dan terekam (di `requirements.md` atau
  komentar ticket)
- `caf-initiator` tidak tersentuh sama sekali — verifikasi dengan `git diff --stat`
  di akhir untuk memastikan tidak ada file `caf-initiator` yang ikut berubah
  (task ini hanya menyentuh repo `caf-orchestrator`)
- Tidak ada perubahan di `report-reader.ts`, `run-agent-pipeline.use-case.ts`,
  `RunPrReviewUseCase` (verifikasi via `git diff --stat`)