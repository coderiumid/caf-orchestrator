# CAF-DASHBOARD-03: Tasks

Mengikuti pola PIV per task: Plan (baca kode, konfirmasi asumsi) → Implement → Verify (retry maks 3x, lalu `NEEDS_HUMAN`).
Setiap task menulis hasilnya ke `verify-report.md` dengan baris `Status: SUCCESS` atau `Status: NEEDS_HUMAN` (kontrak parser).

## Prasyarat

Pertanyaan Terbuka di `requirements.md` bagian 8 dijawab Ganjar: nomor 2 sebelum T2, nomor 1 sebelum T5, nomor 3 sebelum T4.

## Urutan dan ketergantungan

```
T0 Audit ──► T1 Skema + repository ──► T2 Instrumentasi use case ──► T3 API ──► T4 Dashboard
                                                │
                                                └──► T5 Normalizer ──► T6 Agent Floor UI
                                                                              │
                                                          T7 Docs ◄───────────┴──► T8 E2E nyata
```

T4 dan T5–T6 tidak saling bergantung setelah T3 selesai; boleh dikerjakan paralel.

## Tasks

### T0 Audit (read-only, tanpa mengubah kode)

- Baca `run-pr-review.use-case.ts` utuh: semua jalur keluar `execute()` (selesai normal, Verdict tidak dikenali, self-review 422, agent gagal/killed/timeout), dan apa yang dikembalikan `postInitialReview`/`postFixReview`. Catat data hasil yang tersedia untuk FR-2 tanpa membaca ulang file artifact.
- Konfirmasi apakah mode `global`/`scoped` melakukan commit/push, dan apakah itu relevan untuk visual Agent Floor.
- Baca semua pemakai `pipelineRunId()`, `getPipelineDetail()`, `getPipelineRuns()`, dan unique index `idx_pipeline_runs_repo_ticket`: daftar setiap tempat yang mengasumsikan satu baris per `(repo_id, ticket_id)`.
- Tentukan cara mengganti unique index menjadi partial index pada DB yang sudah ada, aman saat web server dan worker bermigrasi bersamaan (lihat penanganan `duplicate column name` di `connection.ts` sebagai pola).
- Baca `pipelines.ts`, `events.ts`, `event-normalizer.ts`, `ui/dashboard/dashboard.js`, dan `ui/agent-floor/{adapter,translate,render}.js`: catat setiap asumsi "run = pipeline tiket dengan langkah plan → impl → qa → review → pr".
- Output: `audit.md` berisi (a) tabel jalur keluar use case → `final_status` + `review_result`, (b) daftar titik yang harus berubah per file, (c) rencana migrasi index, (d) konfirmasi atau koreksi atas kontrak data di `requirements.md` bagian 7.
- **Checkpoint**: kalau audit menemukan bahwa kontrak data bagian 7 tidak bisa dipakai apa adanya, laporkan dulu sebelum lanjut T1.
- Verify: tidak ada perubahan file selain `audit.md`.

### T1 Skema dan repository

- Tambah kolom `kind`, `review_mode`, `review_result` ke `schema.sql` dan `ADDED_COLUMNS` (nullable, additive).
- Ganti unique index sesuai rencana T0 sehingga hanya run pipeline yang unik per `(repo_id, ticket_id)`.
- `PipelineRunRepository`: tulis/baca kolom baru; `getPipelineDetail(repoId, ticketId)` hanya mengembalikan run pipeline; tambah pembacaan detail berdasarkan id run; `getPipelineRuns` menerima filter jenis.
- `NULL` pada `kind` dibaca sebagai `pipeline` di lapisan repository, bukan di tiap pemanggil.
- Test: migrasi di atas DB kosong; migrasi di atas DB berskema lama yang berisi data (data utuh, index baru aktif); migrasi dua kali = no-op; dua run review untuk tiket yang sama bisa disisipkan; dua run pipeline untuk tiket yang sama tetap ditolak/di-upsert seperti sekarang.

### T2 Instrumentasi `RunPrReviewUseCase`

- Tambah fungsi pencatatan run review di `pipeline-instrumentation.ts` (mulai, selesai + hasil), memakai `warnOnFailure` dan `broadcastChange` yang sudah ada. Fungsi untuk run pipeline tidak diubah tanda tangannya.
- Panggil di `execute()` sesuai tabel FR-1: mulai run, `start`/`end` `caf-reviewer` (lewat `recordAgentEvent`/`recordAgentEnd`), finalisasi di jalur sukses dan di `catch`.
- Pemetaan `final_status` mengikuti jawaban Pertanyaan Terbuka 2.
- Tidak ada perubahan pada prompt, pembacaan report, posting GitHub, atau notifikasi Telegram.
- Test: tiap mode menulis baris + event yang benar; `review_result` terisi sesuai FR-2; jalur error menulis `ERROR` lalu tetap melempar; retry job yang sama menaikkan `attempt`; DB tidak tersedia → job tetap selesai (pola `pipeline-instrumentation-db-unavailable.test.ts`); baris run pipeline tiket yang sama tidak berubah; test `run-pr-review.use-case.test.ts` yang ada tetap lulus tanpa diubah.

### T3 API

- `GET /api/pipelines`: sertakan jenis, mode, dan ringkasan hasil; dukung filter jenis.
- Detail dan `floor-events` untuk run review bisa diambil berdasarkan id run. Rute `/:repoId/:ticketId` yang ada tetap melayani run pipeline dengan bentuk respons kompatibel.
- SSE: pastikan `publishDashboardEvent` dari run review sampai ke klien dan membawa cukup informasi untuk menentukan run mana yang berubah.
- Auth basic yang sama untuk semua rute baru.
- Test: daftar gabungan, filter jenis, detail run review saat satu tiket punya beberapa run, rute lama tidak berubah, tanpa auth ditolak.

### T4 Dashboard UI

- Daftar run: penanda jenis (Pipeline / Review / Fix review), mode, nomor PR, hasil. Filter jenis sesuai jawaban Pertanyaan Terbuka 3.
- Detail run review: event `caf-reviewer`, durasi, biaya, hasil.
- Komponen dan warna dari `design-system.css`; token baru (bila perlu) ditambahkan di sana, bukan di `dashboard.css`.
- Verify: run pipeline tampil sama seperti sebelumnya; run review live muncul tanpa reload.

### T5 Normalizer Agent Floor

- `event-normalizer.ts`: bercabang berdasarkan jenis run. Run review menghasilkan `run_started` (dengan jenis + mode), `agent_state` untuk `reviewer`, dan `run_finished` (dengan ringkasan hasil) — tanpa langkah plan/impl/qa dan tanpa handoff turunan antar agent.
- State untuk mode fix mengikuti jawaban Pertanyaan Terbuka 1.
- Jalur run pipeline tidak berubah: keluaran normalizer untuk baris pipeline identik dengan sebelum ticket ini.
- Test: tabel kasus untuk `initial` (tiap Verdict + fallback 422), `global`, `scoped`, `ERROR`, retry (attempt 2); test regresi bahwa seluruh kasus `agent-floor-event-normalizer.test.ts` yang ada menghasilkan urutan yang sama persis.

### T6 Agent Floor UI

- `translate.js`/`adapter.js`: terjemahkan event run review ke fungsi publik render (`setState`, `say`, `sendDoc`, `step`, `setStatus`, `log`) sesuai tabel FR-6.
- Panel kiri: daftar run membedakan jenis; tahap pipeline untuk run review hanya menampilkan langkah yang relevan.
- `render.js`: tambah visual state fix bila Pertanyaan Terbuka 1 dijawab (a).
- Replay run review dengan kontrol yang sudah ada; read-only (test memverifikasi tidak ada tulis ke DB).
- Mode demo: tambah satu skenario review dan satu skenario fix di `demo.js`.
- Verify: run pipeline di Agent Floor berperilaku sama seperti sebelumnya; `prefers-reduced-motion` dan tema terang/gelap tetap dihormati.

### T7 Dokumentasi

- `docs/dashboard.md`: jenis run, arti kolom hasil, filter, tampilan Agent Floor untuk review/fix.
- `CLAUDE.md`: bagian dashboard dan pr-review — sebut bahwa job `pr-review` sekarang ter-instrument dan bagaimana barisnya dibedakan dari run pipeline.
- Catat tiga pemicu dan nama command yang benar (`/caf-review`, `/caf-fix-review`, reply thread inline) di `docs/` — saat ini hanya ada di komentar kode.

### T8 E2E nyata

- Pada repo uji (`umkm-pos`): jalankan `/caf-review`, `/caf-fix-review`, dan satu reply thread inline terhadap PR `ai-agent/<TICKET-KEY>` yang sudah ada.
- Verifikasi di dashboard dan Agent Floor: muncul live, hasil benar, replay berjalan, baris run pipeline tiket itu tidak berubah.
- Hasil ditulis ke `verify-report.md` beserta id run yang dipakai.

## Definition of Done

- Semua Acceptance Criteria di `requirements.md` bagian 9 terpenuhi.
- Alur review, pipeline tiket, dan slash command tidak berubah perilakunya.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` lulus, termasuk test regresi normalizer dan pr-review.
- Tidak ada dependency baru dan tidak ada build step baru.
