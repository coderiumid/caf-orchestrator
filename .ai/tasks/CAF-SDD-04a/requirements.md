# CAF-SDD-04a — Orchestrator menerima nama artefak lama dan baru
Status: APPROVED (Q-1 sampai Q-3 dijawab "ikut rekomendasi", 13 Okt 2026; revisi 1: AC-9 `## Coverage` ditambah 14 Okt 2026, dari temuan 02e)
Source: chat (daftar masukan SDD-04 di CAF-SDD-PROGRESS.md, 13 Okt 2026)
Repo target: `caf-orchestrator`
Bergantung pada: tidak ada (tiket sisi orchestrator; caf-initiator 02c/03b/03c1 tidak perlu ter-rilis).

## 1. Outcome
Orchestrator memakai repo target lama (agent `caf-qa`, `qa-report.md`, `Catatan:`) dan repo baru hasil SDD (agent `caf-validator`, `validate-report.md`, `Notes:`, tanpa agent `caf-documentation`) tanpa perubahan konfigurasi. Hasil `verify-report.md` dibaca dari baris `Status:` ter-anchor. Setelah tiket ini, rilis `caf-init` baru aman dipublish dari sisi orchestrator.

## 2. Scope
In:
- Gate validasi: pilih `caf-validator` bila `.claude/agents/caf-validator.md` ada di workspace; selain itu `caf-qa`. Baca `validate-report.md` bila ada, selain itu `qa-report.md`. Aturan status tetap: baris `Status:` ter-anchor, tepat `PASS`.
- `verify-report.md`: baca baris `Status:` ter-anchor; bila berkas tidak punya baris `Status:` sama sekali, pakai perilaku lama (`\bSUCCESS\b`).
- Parser `Notes:` dan `Catatan:` (keduanya diterima).
- Langkah dokumentasi: dilewati tanpa error bila `.claude/agents/caf-documentation.md` tidak ada.
- Nama agent dan berkas laporan yang dipakai dashboard, komentar ticket, dan body PR mengikuti agent yang benar-benar dijalankan.
- Test unit untuk semua di atas; dokumentasi singkat di README/CLAUDE.md orchestrator.

Out:
- Parsing `AC-n:` dan daftar AC `UNVERIFIED` di body PR, gerbang spec berlabel, jeda Clarify, `/caf-approve-spec` (SDD-04b dan seterusnya).
- Aturan fix-review untuk komentar yang meminta perubahan spec (04b).
- Perubahan nama command webhook (`/caf-retry-pipeline`, `/caf-review`, `/caf-fix-review` tetap).
- Perubahan di `caf-initiator`.

## 3. Constraints and Assumptions
- Finding: `report-reader.ts` membaca `verify-report.md` dengan `\bSUCCESS\b` di mana saja, `qa-report.md` lewat baris `Status:` ter-anchor tepat `PASS`, dan `review-notes.md` lewat baris `Verdict:`.
- Finding: pipeline menjalankan `caf-qa` (langkah 6) dan `caf-documentation` (langkah 8, kegagalan hanya catatan); gate habis membuka Draft PR dan berhenti, bukan error.
- Finding: laporan lama punya `Catatan:` (parser) sedangkan template baru memakai `Notes:`.
- Constraint: perilaku untuk repo target lama tidak berubah satu pun (test existing lulus tanpa diubah, kecuali yang mengunci nama literal dan dicatat).
- Constraint: use case hanya bergantung pada port; pengecekan keberadaan agent lewat port yang ada atau port kecil baru, bukan `fs` langsung di use case.
- Constraint: tidak ada auto-merge; gate habis tetap Draft PR; nama webhook command tidak berubah.
- Assumption A1: `NEEDS_HUMAN` pada `verify-report.md` tetap dibaca bukan-lulus (Draft PR + komentar).
- Assumption A2: bentuk `validate-report.md` memakai baris `Status:` yang sama dengan `qa-report.md` (kontrak 03b1); T1 memastikan bila contoh tersedia di folder tugas.

## 4. Decisions Already Made
- Orchestrator menerima nama lama dan baru; rename di sisi initiator (03c2) menunggu tiket ini.
- Retry default tetap 1 (`agents.qa.maxRetries`, `agents.reviewer.maxRetries`); kunci config tidak diganti pada tiket ini.
- Rilis npm `caf-init` menunggu SDD-04 selesai (04a bagian dari itu).
- Q-1: agent gate dipilih otomatis dari keberadaan `.claude/agents/caf-validator.md` di workspace; tanpa kunci config baru (jawaban Ganjar, 13 Okt 2026).
- Q-2: berkas `verify-report.md` tanpa baris `Status:` tetapi berisi `SUCCESS` tetap dianggap SUCCESS (perilaku lama); berkas dengan baris `Status:` hanya dinilai dari baris itu.
- Q-3: tidak ada laporan gate sama sekali = gagal gate biasa (retry/Draft PR sesuai aturan lama), bukan error BullMQ.

## 5. Open Questions
- Q-1 [BLOCKING] Bagaimana orchestrator memilih agent gate: (a) otomatis dari keberadaan `.claude/agents/caf-validator.md` di workspace (rekomendasi: tanpa konfigurasi, repo lama tetap jalan), atau (b) lewat kunci config per project? — Answer: (a) otomatis dari keberadaan `.claude/agents/caf-validator.md` di workspace (ikut rekomendasi).
- Q-2 [NON-BLOCKING] Bila `verify-report.md` tidak punya baris `Status:` tetapi ada kata `SUCCESS` di isinya, tetap dianggap SUCCESS (rekomendasi: ya, hanya untuk berkas tanpa baris `Status:`), atau dianggap bukan-lulus? — Answer: Ya, tetap SUCCESS hanya untuk berkas tanpa baris `Status:` (ikut rekomendasi).
- Q-3 [NON-BLOCKING] Bila agent gate yang dipilih tidak menghasilkan laporan sama sekali (tidak ada `validate-report.md` maupun `qa-report.md`), diperlakukan sebagai gagal gate biasa dengan Draft PR (rekomendasi) atau error yang di-retry BullMQ? — Answer: Diperlakukan sebagai gagal gate biasa dengan Draft PR (ikut rekomendasi).
## 6. Acceptance Criteria
- AC-1: When `.claude/agents/caf-validator.md` ada di workspace, then pipeline menjalankan `caf-validator` dan membaca `validate-report.md`; when tidak ada, then menjalankan `caf-qa` dan membaca `qa-report.md`, seperti sebelum tiket. Verify: automated test (use case dengan port palsu, dua kasus).
- AC-2: When laporan gate berisi `Status: PASS` ter-anchor, then gate lulus; when `FAIL` atau `NEEDS_HUMAN` atau tanpa baris `Status:`, then gate gagal dan retry/Draft PR mengikuti aturan lama. Berlaku untuk kedua nama berkas. Verify: automated test (report-reader).
- AC-3: When `verify-report.md` punya baris `Status: SUCCESS`, then lulus; when baris `Status:` bernilai lain (mis. `NEEDS_HUMAN`) sementara kata `SUCCESS` muncul di isi, then tidak lulus; when berkas tanpa baris `Status:`, then perilaku lama berlaku. Verify: automated test.
- AC-4: When laporan memakai `Notes:` atau `Catatan:`, then isinya terbaca sama. Verify: automated test.
- AC-5: When `.claude/agents/caf-documentation.md` tidak ada, then langkah dokumentasi dilewati tanpa error dan tanpa komentar kegagalan; when ada, perilaku lama. Verify: automated test.
- AC-6: When gate habis atau pipeline selesai, then nama agent dan berkas laporan di komentar ticket, body PR, event dashboard (`agent_events.agent_name`) dan `artifact_link` sesuai agent yang dijalankan. Verify: automated test.
- AC-7: When resume (`/caf-retry-pipeline`) memakai `lastFailedGate = qa`, then artifact yang dibaca ulang adalah `validate-report.md` bila repo memakai validator, selain itu `qa-report.md`. Verify: automated test.
- AC-9: When `tasks.md` diakhiri `## Coverage` (daftar AC → task), then task-router tidak menganggap isinya sebagai tugas Frontend, Backend, atau Docs dan hasil routing sama dengan `tasks.md` tanpa bagian itu. Verify: automated test.
- AC-8: When `pnpm typecheck && pnpm lint && pnpm test` dijalankan, then semua lulus dan test existing tidak berubah selain yang dicatat di verify-report. Verify: command: `pnpm typecheck && pnpm lint && pnpm test` | expect: exit 0.
