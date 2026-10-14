# CAF-SDD-04b — Orchestrator melaporkan hasil per AC (UNVERIFIED terlihat) dan menjaga spec dari fix-review
Status: APPROVED (Q-1 sampai Q-5 dijawab "ikut rekomendasi", 14 Okt 2026; Q-6 diputuskan konsultan, Ganjar boleh membatalkan)
Source: chat (daftar masukan SDD-04 di CAF-SDD-PROGRESS.md; jawaban Ganjar atas pertanyaan 04b, 14 Okt 2026)
Repo target: `caf-orchestrator`
Bergantung pada: 04a ter-merge.

## 1. Outcome
Setelah gate validasi, orchestrator menghitung status tiap AC di `requirements.md` terhadap laporan gate dan menaruh ringkasan deterministik (jumlah PASS/FAIL/UNVERIFIED, daftar UNVERIFIED beserta alasan) di bagian atas body PR, sehingga pereview manusia langsung melihat apa yang belum terbukti. Gate yang tidak membuktikan satu pun AC tidak lulus diam-diam. Fix-review tidak pernah mengubah spec. Nama gate di state baru adalah `validate`. Repo target tanpa AC bernomor berperilaku persis seperti sebelum tiket.

## 2. Scope
In:
- Parser AC: id `AC-n` dari `requirements.md`, status per AC dari tabel per AC di `validate-report.md` atau `qa-report.md`.
- Kebijakan UNVERIFIED (Q-1, Q-2) dan ringkasan di body PR, baik PR normal maupun Draft PR gate (Q-3).
- Nama gate `validate` untuk state dan resume run baru, `qa` tetap terbaca (Q-4).
- Aturan di prompt fix-review (mode `global` dan `scoped`) untuk komentar yang meminta perubahan spec (Q-6).
- README/CLAUDE.md orchestrator: kebijakan UNVERIFIED, nama gate, dan catatan repo satu aplikasi memakai `--role frontend|backend` (Q-5).
- Test unit untuk semua di atas.

Out:
- Gerbang spec berlabel, jeda Clarify, `/caf-approve-spec`, penanganan `NEEDS_CLARIFICATION` (SDD-04c).
- Routing `caf-implementer` (Q-5; `implementer` dibuang di 03c3).
- Perubahan di `caf-initiator`, nama command webhook, kunci config `agents.qa.*`, migrasi data SQLite lama.
- Mengubah `Status:` laporan selain aturan Q-1.

## 3. Constraints and Assumptions
- Finding (progres SDD-04): validator menulis `validate-report.md` dengan baris `Status: PASS | FAIL | NEEDS_HUMAN`, baris jumlah AC `UNVERIFIED` beserta daftarnya, dan tabel per AC berkolom AC, Status, Jenis bukti, Bukti (spesifikasi 03b1, AC-5); AC tanpa bukti ditulis `UNVERIFIED` dengan alasan "no evidence reported".
- Finding (04a): `report-reader` membaca `Status:` ter-anchor untuk `validate-report.md`, `qa-report.md`, dan `verify-report.md`; gate tanpa laporan = gagal gate biasa; nama agent dan laporan gate dipilih lewat port `IAgentCatalog`.
- Finding (ringkasan orchestrator): Draft PR gate hari ini berisi artifact gate yang gagal tanpa teks baru; job fix-review menulis `fix-review-log.md` dengan satu blok per komentar berstatus `FIXED | SKIPPED | NOT_APPLICABLE` dan membalas tiap komentar GitHub.
- Constraint: repo target lama tidak berubah perilakunya: tanpa baris `AC-n` di `requirements.md` tidak ada ringkasan dan tidak ada aturan Q-1 (test existing lulus tanpa diubah, kecuali yang mengunci nama gate `qa` dan dicatat).
- Constraint: ringkasan dibangun tanpa memanggil model; masukan sama menghasilkan keluaran sama.
- Constraint: use case hanya bergantung pada port; tidak ada auto-merge; gate habis tetap Draft PR.
- Assumption A1: `requirements.md` berada di folder tugas ticket di workspace (`.caf/tasks/<KEY>/`); dasar: lokasi `tasks.md` yang dibaca pipeline hari ini. T1 memastikan.
- Assumption A2: tabel per AC berbentuk baris pipa dengan id `AC-n` di kolom pertama dan status di kolom kedua; sel bisa berisi backtick atau huruf tebal dan status bisa berhuruf kecil; dasar: 03b1 AC-5 (kolom AC, Status, Jenis bukti, Bukti). T1 memastikan dengan fixture laporan; bila bentuk nyata berbeda, STOP `NEEDS_HUMAN`.
- Assumption A3: id AC bisa bersufiks huruf (mis. `AC-7b`); dasar: spec 03e memakainya.
- Assumption A4 (T1): prompt fix-review disusun di satu tempat per mode dan `fix-review-log.md` ditulis oleh agent `caf-reviewer`, sehingga bagian baru di berkas itu tidak butuh izin tulis tambahan.

## 4. Decisions Already Made
- Gerbang validasi lulus bila tidak ada `FAIL`; daftar `UNVERIFIED` wajib terlihat di body PR (SDD-04).
- `NEEDS_HUMAN` dibaca bukan-lulus; gate yang menghasilkannya berhenti dengan Draft PR dan komentar, tanpa retry (perilaku lama).
- Komentar fix-review yang meminta perubahan spec tidak mengubah spec; dicatat sebagai usulan dengan status `SKIPPED` (SDD-summary, 12 Okt).
- Retry default tetap 1; kunci config tidak diganti.
- Rilis npm `caf-init` menunggu SDD-04 selesai (04a, 04b, 04c).
- Q-1: gate lulus bila tidak ada `FAIL`, kecuali bila ada AC dan semuanya `UNVERIFIED` (tidak satu pun terbukti): gate dianggap `NEEDS_HUMAN` walau `Status: PASS`.
- Q-2: AC yang ada di `requirements.md` tetapi tidak muncul di laporan gate dihitung `UNVERIFIED` dengan alasan "tidak dilaporkan".
- Q-3: ringkasan dibangun deterministik oleh orchestrator di bagian atas body PR (jumlah PASS/FAIL/UNVERIFIED, daftar UNVERIFIED dengan alasan, baris `Proposed Spec Changes:` bila ada); isi artifact di bawahnya tidak diubah.
- Q-4: run baru menulis nama gate `validate`; nilai lama `qa` tetap terbaca; tanpa migrasi data lama; dashboard menampilkan nama agent yang benar-benar jalan.
- Q-5: routing `caf-implementer` tidak dikerjakan; repo satu aplikasi memakai `--role frontend|backend` (didokumentasikan).
- Q-6 (keputusan konsultan): usulan perubahan spec dari fix-review dicatat di `fix-review-log.md` bagian `## Proposed Spec Changes`, bukan di `verify-report.md`, karena job fix-review sudah memiliki `fix-review-log.md` (progres SDD-04 sebelumnya menyebut `verify-report.md`).

## 5. Open Questions
- Q-1 [BLOCKING] Kebijakan `UNVERIFIED`: (a) lulus bila tidak ada `FAIL`, kecuali semua AC `UNVERIFIED` maka `NEEDS_HUMAN` (rekomendasi), atau (b) lulus apa pun jumlah `UNVERIFIED`? — Answer: (a) (ikut rekomendasi).
- Q-2 [NON-BLOCKING] AC di spec yang tidak ada di laporan gate: (a) dihitung `UNVERIFIED` "tidak dilaporkan" (rekomendasi), atau (b) diabaikan? — Answer: (a) (ikut rekomendasi).
- Q-3 [NON-BLOCKING] Ringkasan di body PR: (a) deterministik oleh orchestrator di bagian atas body, isi artifact tak diubah (rekomendasi), atau (b) ditulis agent? — Answer: (a) (ikut rekomendasi).
- Q-4 [NON-BLOCKING] Nama gate `qa`: (a) run baru memakai `validate`, `qa` tetap terbaca, tanpa migrasi (rekomendasi), atau (b) migrasi data lama? — Answer: (a) (ikut rekomendasi).
- Q-5 [NON-BLOCKING] Routing `caf-implementer` untuk repo satu aplikasi: (a) tidak dikerjakan, pakai `--role` (rekomendasi), atau (b) dikerjakan sekarang? — Answer: (a) (ikut rekomendasi).
- Q-6 [NON-BLOCKING] Tempat usulan perubahan spec dari fix-review: (a) `fix-review-log.md` bagian `## Proposed Spec Changes` (rekomendasi: berkas milik job itu), atau (b) `verify-report.md`? — Answer: (a) (keputusan konsultan; Ganjar boleh membatalkan).

## 6. Acceptance Criteria
- AC-1: When `requirements.md` memuat baris `- AC-n:` (termasuk id bersufiks huruf), then parser mengembalikan semua id AC dalam urutan kemunculan. Verify: automated test.
- AC-2: When laporan gate memuat tabel per AC, then parser membaca status tiap AC (`PASS`, `FAIL`, `UNVERIFIED`) dan teks alasan dari kolom Bukti, walau sel memakai backtick atau huruf tebal. Verify: automated test dengan fixture laporan.
- AC-3: When sebuah AC ada di `requirements.md` tetapi tidak di laporan gate, then AC itu dihitung `UNVERIFIED` dengan alasan "tidak dilaporkan" (Q-2). Verify: automated test.
- AC-4: When sebuah AC ada di laporan gate tetapi tidak di `requirements.md`, then AC itu tidak ikut hitungan. Verify: automated test.
- AC-5: When `requirements.md` tidak ada atau tidak memuat baris `AC-n`, then tidak ada ringkasan di body PR dan gate berperilaku persis seperti sebelum tiket. Verify: automated test.
- AC-6: When ada minimal satu AC, semuanya `UNVERIFIED`, dan laporan bertulis `Status: PASS`, then gate dianggap `NEEDS_HUMAN`: Draft PR dan komentar, berhenti, tanpa retry (Q-1). Verify: automated test.
- AC-7: When ada minimal satu AC non-`UNVERIFIED` dan tidak ada `FAIL` dan laporan bertulis `Status: PASS`, then gate lulus walau sebagian AC `UNVERIFIED`. Verify: automated test.
- AC-8: When PR normal dibuat, then bagian atas body memuat jumlah PASS, FAIL, dan `UNVERIFIED` serta daftar `UNVERIFIED` beserta alasannya (Q-3). Verify: automated test.
- AC-9: When Draft PR gate dibuat atau diperbarui, then ringkasan yang sama ada di bagian atas dan isi artifact di bawahnya identik dengan sebelum tiket. Verify: automated test.
- AC-10: When laporan gate memuat baris `Proposed Spec Changes:` di bawah `### Notes`, then baris itu ikut tampil di ringkasan body PR. Verify: automated test.
- AC-11: When ringkasan dibangun dua kali dari masukan yang sama, then hasilnya identik dan tidak ada pemanggilan agent atau model. Verify: automated test.
- AC-12: When run baru menyimpan state resume, then `lastFailedGate` bernilai `validate` untuk kegagalan gate validasi (Q-4). Verify: automated test.
- AC-13: When state resume lama bernilai `qa`, then dibaca sama seperti `validate` dan artifact gate yang dibaca ulang mengikuti agent yang dipilih (aturan 04a). Verify: automated test.
- AC-14: When prompt fix-review mode `global` dan `scoped` dibangun, then keduanya memuat aturan: komentar yang meminta perubahan `requirements.md` atau `tasks.md` tidak mengubah spec, dicatat di `fix-review-log.md` bagian `## Proposed Spec Changes`, dan ditandai `Status: SKIPPED` dengan alasan (Q-6). Verify: automated test atas teks prompt.
- AC-15: When README dan CLAUDE.md orchestrator dibaca, then tertulis kebijakan UNVERIFIED (Q-1, Q-2), ringkasan di body PR, nama gate `validate` dengan `qa` tetap terbaca, dan repo satu aplikasi memakai `--role frontend|backend`. Verify: manual: baca bagian terkait.
- AC-16: When `pnpm typecheck && pnpm lint && pnpm test` dijalankan, then semua lulus dan test existing tidak berubah selain yang dicatat di verify-report. Verify: command: `pnpm typecheck && pnpm lint && pnpm test` | expect: exit 0.
