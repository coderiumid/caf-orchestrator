# CAF-DASHBOARD-03: Verify Report

Tanggal: 2026-10-04
Branch: `ai-agent/CAF-DASHBOARD-03` (belum di-commit)

Keputusan atas Pertanyaan Terbuka (requirements bagian 8), memakai usulan masing-masing:
1. State baru `fixing` untuk Reviewer pada mode `global`/`scoped`.
2. Job selesai = `SUCCESS` apa pun Verdict-nya; Verdict di `review_result`. Job melempar = `ERROR`.
3. Satu daftar gabungan + filter jenis run.

## Ringkasan per task

| Task | Hasil |
|---|---|
| T0 Audit | Status: SUCCESS — `audit.md` |
| T1 Skema + repository | Status: SUCCESS |
| T2 Instrumentasi use case | Status: SUCCESS |
| T3 API | Status: SUCCESS |
| T4 Dashboard UI | Status: SUCCESS |
| T5 Normalizer | Status: SUCCESS |
| T6 Agent Floor UI | Status: SUCCESS, dengan satu catatan (replay beranimasi, lihat bawah) |
| T7 Dokumentasi | Status: SUCCESS |
| T8 E2E nyata | Status: NEEDS_HUMAN — belum dijalankan |

## Yang diverifikasi

- `pnpm typecheck`, `pnpm lint`: bersih.
- `pnpm test`: 506 lulus (42 file). Sebelum ticket ini 453 (40 file); tidak ada test lama yang diubah maknanya.
- Test baru:
  - `db-migration.test.ts`: DB berskema lama → kolom baru, index ditukar, data utuh, dibaca sebagai pipeline; banyak baris review untuk satu tiket; baris pipeline kedua untuk tiket yang sama tetap ditolak; migrasi dua kali no-op.
  - `pr-review-instrumentation.test.ts` (SQLite sungguhan): tiga mode, biaya/outcome, jalur ERROR, retry BullMQ menaikkan `attempt` di baris yang sama, dua job = dua baris, baris pipeline tiket tidak berubah, judul dipinjam, sinyal dashboard.
  - `pr-review-instrumentation-db-unavailable.test.ts`: DB tidak bisa dibuka → job tetap selesai, hanya warning.
  - `run-pr-review.use-case.test.ts`: pemanggilan instrumentasi per jalur, termasuk fallback 422.
  - `agent-floor-event-normalizer.test.ts`: tiap Verdict, fallback 422, `global`/`scoped`, dua jalur ERROR, retry, append-only, dan run pipeline tidak terpengaruh.
  - `agent-floor-translate.test.ts`, `pipelines-route.test.ts`, `agent-floor-ui.test.ts`: lihat file.
- Browser (server preview terpisah di port lain, DB sementara berisi 1 run pipeline + 5 run review; bukan DB lokal proyek):
  - Dashboard: enam kartu tampil dengan jenis, mode, PR, hasil; filter jenis mengembalikan kartu yang benar; panel detail run review terbuka lewat `by-run`; tanpa error console.
  - Agent Floor live: otomatis mengikuti run review yang sedang jalan; hanya Reviewer bekerja ("Fixing review comments"), daftar tahap satu baris.
  - Agent Floor, urutan event tiap run (APPROVE, CHANGES REQUESTED + fallback, fix, ERROR, lalu run pipeline) diterapkan ke halaman tanpa error; pill, tahap, dan log sesuai; daftar 5 tahap kembali untuk run pipeline.

## Yang belum diverifikasi

- **Replay beranimasi dan mode demo secara visual.** Tab browser otomasi berstatus `hidden`, sehingga `requestAnimationFrame` tidak jalan dan jam simulasi berhenti — berlaku juga untuk replay run pipeline yang sudah ada. Urutan event diverifikasi dengan menerapkannya langsung tanpa jeda; animasi antar event dan dua skenario demo baru (`review`, `fixreview`) belum dilihat berjalan.
- **T8 E2E nyata.** Perlu `/caf-review`, `/caf-fix-review`, dan satu reply thread inline pada PR sungguhan; memicu agent berbayar dan memposting ke GitHub.

## Catatan

- Saat menjalankan suite pertama kali, `run-pr-review.use-case.test.ts` (yang tidak me-mock config) menulis satu baris fixture `pr-review:job-1` + 32 event ke `data/caf-dashboard.sqlite` lokal. Baris itu sudah dihapus; test sekarang me-mock instrumentasi. Isi DB lokal kembali 7 run pipeline / 67 event seperti semula.
- Akibat yang sama, migrasi (tiga kolom baru + pertukaran index) sudah terpasang di DB lokal itu. Sifatnya additive dan sama dengan yang akan terjadi saat server/worker di-restart dengan kode ini.
- Server dev yang sedang jalan di port 3030 tidak disentuh; ia masih memakai kode lama sampai di-restart.
