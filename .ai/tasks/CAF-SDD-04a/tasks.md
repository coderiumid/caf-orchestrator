# CAF-SDD-04a — Tasks
Repo: `caf-orchestrator`. Baca `requirements.md` di folder ini dulu. Jangan menebak: bila pola kode tidak jelas, ikuti test existing dan catat di `verify-report.md`.

## Aturan umum
- Syarat mulai: `requirements.md` berstatus `Status: APPROVED` dan Q-1 sampai Q-3 terjawab. Bila belum, STOP `NEEDS_HUMAN`.
- Branch `ai-agent/CAF-SDD-04a` dari main terbaru, working tree bersih. Tidak ada push, PR, atau merge. Commit lokal per tahap bermakna.
- Test dulu (merah), baru implementasi. Perilaku repo target lama tidak boleh berubah.
- Bila temuan T1 bertentangan dengan sebuah AC, STOP `NEEDS_HUMAN` sebelum menyentuh `src/`.
- Test lama yang mengunci nama literal (`caf-qa`, `qa-report.md`) boleh diperbarui hanya bila perilakunya memang berubah; catat tiap perubahan beserta alasan.

## Tasks
- [ ] T1 (A2): Audit baca-saja, catat di `verify-report.md`: lokasi pembacaan tiap laporan di `report-reader.ts`; tempat nama `caf-qa`, `qa-report.md`, `caf-documentation` dipakai (use case, task-router, komentar, body PR, instrumentation, dashboard, watcher, notifikasi); bagaimana use case saat ini mengecek isi workspace; test yang mengunci hal itu; bentuk resume `lastFailedGate`; apakah task-router membaca heading `## Coverage` sebagai bagian tugas.
- [ ] T2 (AC-1 sampai AC-7, AC-9): Tulis test merah untuk tiap AC.
- [ ] T3 (AC-2 sampai AC-4): Perbarui `report-reader` (Status ter-anchor, fallback lama, `Notes:`/`Catatan:`).
- [ ] T4 (AC-1, AC-5, AC-6, AC-7): Pilih agent gate dan berkas laporan lewat pengecekan agent di workspace (lewat port), dan teruskan nama yang dipilih ke komentar, body PR, instrumentation, dan resume.
- [ ] T4b (AC-9): Pastikan task-router mengabaikan `## Coverage` (tanpa mengubah routing untuk `tasks.md` tanpa bagian itu).
- [ ] T5 (AC-8): Jalankan `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] T6: Perbarui README/CLAUDE.md (kontrak laporan menerima nama lama dan baru).
- [ ] T7: Tulis `verify-report.md` (format Layer 3, bukti per AC dengan nama test; AC ber-`command` dilaporkan sebagai `command`). Catat hasil T1, test lama yang diubah, hal tak terduga.

## Di luar tugas ini
Parsing AC, daftar `UNVERIFIED`, gerbang spec, Clarify, fix-review spec, perubahan di `caf-initiator`.

## Coverage
- AC-1, AC-5, AC-6, AC-7 → T2, T4
- AC-2, AC-3, AC-4 → T2, T3
- AC-9 → T2, T4b
- AC-8 → T5
