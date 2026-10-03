# CAF-DASHBOARD-02: Tasks

Mengikuti pola PIV per task: Plan (baca kode, konfirmasi asumsi) → Implement → Verify (retry maks 3x, lalu `NEEDS_HUMAN`).
Setiap task menulis hasilnya ke `verify-report.md` dengan baris `Status: SUCCESS` atau `Status: NEEDS_HUMAN` (kontrak parser).

## Prasyarat

CAF-DASHBOARD-01 Task 7 (e2e nyata pada `umkm-pos`) harus selesai lebih dulu. Run nyata dari Task 7 dipakai sebagai bahan audit T0 dan data uji replay (T6).

## Urutan dan ketergantungan

```
T0 Audit data ──► T1 Instrumentasi (kondisional) ──► T2 Normalizer ──► T3 SSE
                                                          │              │
T4 Port render dari prototype (bisa paralel dengan T0–T3) ┴──► T5 Adapter live ──► T6 Replay
                                                                                     │
                                                      T7 A11y/perf ──► T8 Docs ──► T9 E2E nyata
```

Setelah prasyarat terpenuhi, T4 tidak bergantung pada hasil T0–T3 sehingga boleh dikerjakan paralel dengan T0–T3 bila diinginkan.

## Tasks

### T0 Audit data (read-only, tanpa mengubah kode)

- Baca skema SQLite dan semua titik tulis ke `pipeline_runs` dan tabel terkait.
- Jawab: apakah ada baris per agent per fase dengan waktu mulai/selesai, nomor percobaan verify, jenis gate (implementasi/QA/Reviewer), dan biaya/token per agent?
- Cek status `parseAgentUsage()`: sudah di-wire atau belum.
- Cek event SSE yang sudah ada: tipe dan payload-nya.
- Output: `audit.md` berisi tabel "kebutuhan event (requirements.md bagian 7)" vs "tersedia sekarang", plus daftar gap.
- Verify: tidak ada perubahan file selain `audit.md`.

### T1 Instrumentasi minimal (hanya jika T0 menemukan gap)

- Tambah pencatatan/emisi event yang kurang (mulai dan selesai fase per agent, handoff, percobaan verify), tanpa mengubah alur retry dan tanpa menyentuh kontrak `report-reader.ts`.
- `caf-documentation` tetap tidak di-instrument.
- Test: unit test untuk setiap titik emisi baru; test regresi bahwa jalur retry (`qaRetryCount`, `reviewerRetryCount`, `attempts: 3`) tidak berubah.
- Jika T0 menyatakan tidak ada gap, task ini ditutup dengan catatan "tidak diperlukan".

### T2 Normalizer event

- Fungsi murni: baris DB/event mentah → event ber-kontrak (requirements.md bagian 7).
- Dipakai bersama oleh jalur live dan replay supaya perilakunya identik.
- Test: tabel kasus untuk `SUCCESS`, `NEEDS_HUMAN`, `ERROR`, retry implementasi 1–3, retry QA, run tanpa PR, dan run multi-repo.

### T3 Endpoint SSE

- Perluas SSE dashboard (atau tambah channel) untuk menyalurkan event ber-kontrak, difilter per repo dan per `runId`.
- Auth memakai middleware basic auth yang sama.
- Test: event terkirim berurutan, koneksi putus-sambung tidak menggandakan event, klien tanpa auth ditolak.

### T4 Port render dari prototype

- Pindahkan `agent-floor.prototype.html` menjadi halaman terpisah dengan rutenya sendiri (vanilla JS, tanpa build step), dengan lokasi file dan path rute sesuai hasil T0. Pisahkan render (canvas, sprite, layout) dari adapter data.
- Tambahkan satu tautan masuk dari dashboard yang ada.
- Pertahankan fungsi publik `setState`, `say`, `sendDoc`, `step`, `setStatus`, `log` sebagai satu-satunya pintu masuk data.
- Skenario mock dipindah ke mode demo (FR-7), bukan dihapus.
- Hapus logo base64 inline; pakai aset logo CAF dari project.
- Verify: halaman demo berjalan identik dengan prototype yang sudah di-approve.

### T5 Adapter live

- Sambungkan SSE (T3) ke fungsi publik di T4; tampilkan status koneksi (Terhubung/Terputus) dan sambung ulang otomatis.
- Run aktif diambil dari `pipeline_runs` dengan `final_status IS NULL`.
- Panel Detail agent membaca token, biaya, dan durasi dari data nyata (tidak lagi mock).

### T6 Replay

- Pilih run historis dari daftar, putar ulang dari event yang dinormalisasi (T2) dengan kontrol jeda dan 1×/2×/4×.
- Read-only: tidak boleh ada tulis ke DB. Test memverifikasi hal ini.

### T7 Aksesibilitas dan performa

- `prefers-reduced-motion`, navigasi keyboard lewat daftar status agent, `role="log"`, kontras tema terang/gelap.
- Ukur frame rate dengan 7 karakter aktif dan pastikan tidak ada polling per frame.
- Pastikan tidak ada scroll window di viewport desktop; panel scroll di dalam.

### T8 Dokumentasi

- Perbarui `docs/dashboard.md`: rute, kontrak event, mode live/replay/demo, cara menambah state agent baru, dan catatan bahwa `caf-documentation` sengaja off duty.
- Catat di dokumen bahwa kontrak status parser (`Status: SUCCESS` untuk `verify-report.md`, `Status: PASS` untuk `qa-report.md`) tidak disentuh.

### T9 E2E nyata (butuh konfirmasi eksplisit)

- Satu run sungguhan pada `umkm-pos` dan satu pada `coderium-web-v2`, diamati di Agent Floor.
- Run dari Task 7 DASHBOARD-01 sudah bisa diputar ulang lewat replay (T6) tanpa biaya. Verifikasi live memerlukan satu pemicu baru. **Tidak dijalankan tanpa konfirmasi Ganjar**: memicu pipeline nyata berarti token terpakai, branch di-push, dan PR sungguhan dibuat.
- `db.path` yang harus absolut di VPS adalah item terbuka DASHBOARD-01 dan sudah tertangani oleh Task 7; T0 hanya memastikan hal itu benar-benar sudah beres.

## Verify Checklist (berlaku untuk T1–T8)

Verifikasi dulu bahwa script berikut benar-benar ada di `package.json`; jika tidak ada, laporkan sebagai gap infrastruktur, jangan membuat gate palsu.

```bash
pnpm typecheck
pnpm lint
pnpm test        # baseline 2026-10-04 (sebelum T1): 34 file, 358 test, semua lulus; tidak boleh turun
pnpm build
```

## Retry Logic

Jika verify gagal: perbaiki dan coba lagi, maksimal 3 kali. Jika masih gagal, tulis `Status: NEEDS_HUMAN` di `verify-report.md`, hentikan pipeline, dan eskalasi ke Ganjar.

## Definition of Done

- [ ] Semua acceptance criteria di `requirements.md` bagian 8 terpenuhi
- [ ] Quality gate lulus, jumlah test tidak turun dari baseline
- [ ] `docs/dashboard.md` diperbarui
- [ ] Tidak ada perubahan pada alur retry, kontrak parser, atau instrumentasi `caf-documentation`
- [ ] Review manusia sebelum merge (tidak ada auto-merge)