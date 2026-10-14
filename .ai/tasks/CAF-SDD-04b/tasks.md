# CAF-SDD-04b — Tasks
Repo: `caf-orchestrator`. Baca `requirements.md` di folder ini dulu. Jangan menebak: bila pola kode tidak jelas, ikuti test existing dan catat di `verify-report.md`.

## Aturan umum
- Syarat mulai: `requirements.md` berstatus `Status: APPROVED` dan Q-1 sampai Q-6 terjawab. Bila belum, STOP `NEEDS_HUMAN`.
- Branch `ai-agent/CAF-SDD-04b` dari main terbaru (setelah 04a ter-merge), working tree bersih. Tidak ada push, PR, atau merge. Commit lokal satu per tahap bermakna.
- Use case hanya bergantung pada port. Ringkasan dibangun tanpa model.
- Bila temuan T1 bertentangan dengan sebuah AC atau asumsi A2/A4 salah, STOP `NEEDS_HUMAN` sebelum menyentuh `src/`.
- Test lama yang mengunci nama gate `qa` atau teks yang memang berubah boleh diperbarui; catat tiap perubahan beserta alasan di `verify-report.md`. Cari teks yang berubah di semua berkas test, bukan hanya test yang namanya jelas terkait.

## Tasks
- [ ] T1 (A1 sampai A4): Audit baca-saja, catat di `verify-report.md`: lokasi `requirements.md` di workspace; bentuk tabel per AC di fixture/contoh laporan (bila tidak ada contoh nyata, tulis fixture sesuai A2 dan catat); semua tempat `lastFailedGate`, nama gate `qa`, dan `gate` dipakai (state, resume, dashboard, SQLite, notifier); pembangun body PR normal dan Draft PR gate; tempat prompt fix-review per mode dan pembaca `fix-review-log.md`; siapa penulis `fix-review-log.md`; test yang mengunci hal itu.
- [ ] T2 (AC-1 sampai AC-14): Tulis test merah untuk tiap AC.
- [ ] T3 (AC-1 sampai AC-5, AC-11): Parser AC dan penghitung status (modul murni, tanpa I/O).
- [ ] T4 (AC-6, AC-7): Terapkan kebijakan Q-1 di titik gate validasi, memakai hasil parser.
- [ ] T5 (AC-8 sampai AC-10): Ringkasan di bagian atas body PR normal dan Draft PR gate.
- [ ] T6 (AC-12, AC-13): Nama gate `validate` untuk state baru; baca `qa` dan `validate` sama.
- [ ] T7 (AC-14): Aturan di prompt fix-review (kedua mode).
- [ ] T8 (AC-16): Jalankan `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] T9 (AC-15): Perbarui README/CLAUDE.md orchestrator.
- [ ] T10: Tulis `verify-report.md` (format Layer 3, bukti per AC dengan nama test; AC ber-`command` dilaporkan sebagai `command`). Catat hasil T1, test lama yang diubah, hal tak terduga.

## Docs Tasks
- README/CLAUDE.md orchestrator (T9).

## Di luar tugas ini
Gerbang spec berlabel, Clarify, `/caf-approve-spec`, `NEEDS_CLARIFICATION` (04c); routing `caf-implementer`; perubahan di `caf-initiator`; kunci config; migrasi data SQLite.

## Coverage
- AC-1 sampai AC-5, AC-11 → T2, T3
- AC-6, AC-7 → T2, T4
- AC-8, AC-9, AC-10 → T2, T5
- AC-12, AC-13 → T2, T6
- AC-14 → T2, T7
- AC-15 → T9
- AC-16 → T8
