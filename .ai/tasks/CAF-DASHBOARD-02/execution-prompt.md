# Prompt Eksekusi: CAF-DASHBOARD-02 (Agent Floor)

Taruh file ini di `.ai/tasks/CAF-DASHBOARD-02/execution-prompt.md` pada repo `caf-orchestrator`, lalu jalankan di Claude Code:

```
Baca .ai/tasks/CAF-DASHBOARD-02/execution-prompt.md lalu eksekusi. Mulai dari Gerbang Prasyarat dan Fase A saja.
```

Isi prompt dimulai dari garis di bawah.

---

## Peran dan konteks

Kamu mengerjakan tiket **CAF-DASHBOARD-02: Agent Floor** di repo `caf-orchestrator` (Fastify + BullMQ + Redis, CommonJS). Agent Floor adalah halaman terpisah di dashboard yang menampilkan para agent CAF sebagai karakter pixel-art di kantor, digerakkan oleh data pipeline nyata (live), data historis (replay), atau skenario mock (demo).

Ganjar adalah tech lead dan satu-satunya maintainer. Setiap keputusan arsitektur ada padanya. Kalau ada hal yang tidak bisa dipastikan dari kode atau dokumen, **tanyakan ke Ganjar, jangan menebak**.

## Baca dulu, sebelum menyentuh apa pun

1. `.ai/tasks/CAF-DASHBOARD-02/requirements.md`
2. `.ai/tasks/CAF-DASHBOARD-02/tasks.md`
3. `.ai/tasks/CAF-DASHBOARD-02/agent-floor.prototype.html` (referensi visual yang sudah di-approve; baca kode dan struktur fungsinya, jangan menilai lewat tampilan saja)
4. Semua file di `.ai/tasks/CAF-DASHBOARD-01/` (terutama `verify-report.md` dan catatan keputusan)
5. `docs/dashboard.md`
6. `package.json` root: catat script yang benar-benar ada dan package manager-nya

Jangan menanyakan hal yang sudah dijawab di dokumen-dokumen itu.

## Gerbang prasyarat (wajib, sebelum Fase A)

DASHBOARD-02 hanya boleh dimulai setelah **Task 7 CAF-DASHBOARD-01** (e2e nyata pada `umkm-pos`) selesai.

- Periksa `.ai/tasks/CAF-DASHBOARD-01/` apakah Task 7 sudah berstatus selesai dan lulus.
- Jika belum selesai atau tidak bisa dipastikan: **berhenti**, laporkan temuanmu, dan jangan mengerjakan apa pun. Jangan mencoba menyelesaikan Task 7 sendiri dan jangan memicu pipeline.
- Jika sudah selesai: catat baseline quality gate saat ini (jumlah file test dan test) sebelum mengubah apa pun.

## Aturan keras (tidak boleh dilanggar)

- **Jangan memicu pipeline nyata.** Tidak ada webhook palsu, trigger BullMQ, push branch, pembuatan PR, atau apa pun yang memakai token tanpa konfirmasi eksplisit dari Ganjar. Ini berlaku untuk T9 dan untuk percobaan "sekadar tes".
- **Tidak ada auto-merge.** Berhenti sampai review manusia.
- **Halaman ini read-only.** Tidak ada tombol approve, retry, atau stop terhadap pipeline.
- **Jangan mengubah** alur retry (`qaRetryCount`, `reviewerRetryCount`, `attempts: 3` BullMQ), kontrak parser `report-reader.ts` (`Status: SUCCESS` untuk `verify-report.md`, `Status: PASS` untuk `qa-report.md`), atau menginstrument `caf-documentation`. Agent itu sengaja tidak punya `piv_phase`, jadi di UI ia selalu off duty.
- **Keputusan DASHBOARD-01 sudah final, jangan dibuka ulang:** DB-only (sinyal "berjalan" = `pipeline_runs` dengan `final_status IS NULL`), SQLite `better-sqlite3`, SSE, vanilla JS tanpa build step, basic auth Bull Board yang sama, dokumentasi di `docs/dashboard.md`, `final_status` bernilai `SUCCESS`, `NEEDS_HUMAN`, atau `ERROR`.
- **Tanpa build step dan tanpa dependency frontend baru.** Repo ini CommonJS; jangan menambah dependency yang hanya mendukung ESM. Jika menurutmu dependency baru memang perlu, berhenti dan tanyakan.
- **Jangan membuat quality gate palsu.** Jika script `lint`/`typecheck`/`test`/`build` yang dibutuhkan tidak ada di `package.json`, laporkan sebagai gap infrastruktur.
- **Jangan menimpa, perbarui.** Jika file sudah ada (misalnya `docs/dashboard.md`), lengkapi, jangan ganti total.
- Artifact tiket ini hidup di `.ai/tasks/CAF-DASHBOARD-02/` (konvensi manual repo ini; `caf-orchestrator` tidak punya scaffolding CAF penuh).

## Cara kerja: PIV per task, dan berhenti per fase

Untuk setiap task di `tasks.md`:

1. **Plan:** baca kode yang relevan, tulis rencana ringkas (apa yang akan diubah, file mana, asumsi yang perlu dikonfirmasi). Jangan menulis kode dulu.
2. **Implement:** kerjakan sesuai rencana. Jangan melebar ke luar scope task.
3. **Verify:** jalankan verify checklist di `tasks.md`. Jika gagal, perbaiki dan coba lagi, **maksimal 3 kali**. Jika masih gagal, hentikan dan tulis `Status: NEEDS_HUMAN` di `verify-report.md` beserta ringkasan error. Gunakan persis kata `Status: SUCCESS` atau `Status: NEEDS_HUMAN`; jangan `PASS`, `DONE`, atau `OK` di file itu.

Fase dan titik berhenti:

| Fase | Isi | Aturan |
|---|---|---|
| A | T0 Audit data | Read-only. Hanya menulis `audit.md`. **Berhenti dan laporkan.** |
| B | T1 (kondisional), T2, T3 | Mulai hanya setelah Ganjar membalas "lanjut". Berhenti dan laporkan. |
| C | T4, T5, T6 | Sama. Berhenti dan laporkan. |
| D | T7, T8 | Sama. Berhenti dan laporkan. |
| E | T9 e2e nyata | **Hanya dengan konfirmasi eksplisit** yang menyebut pemicu, repo, dan tiket yang akan dipakai. |

Mulai dari **Fase A saja**. Jangan lanjut ke fase berikutnya sebelum Ganjar menjawab.

## Fase A: apa yang harus dijawab T0

Tulis `audit.md` berisi jawaban terverifikasi dari kode (sebutkan file dan baris, jangan dari ingatan):

1. Skema SQLite saat ini dan semua titik yang menulis ke `pipeline_runs` dan tabel terkait.
2. Apakah sudah ada data per agent per fase: waktu mulai dan selesai, nomor percobaan verify, jenis gate (implementasi, QA, Reviewer), dan biaya serta token per agent?
3. Status `parseAgentUsage()`: sudah di-wire atau belum, dan di mana.
4. Event SSE yang sudah ada: tipe dan payload-nya, dan apakah cukup untuk kontrak event di `requirements.md` bagian 7.
5. Struktur SPA dashboard: di mana file statis dilayani, bagaimana rute didaftarkan, dan bagaimana middleware basic auth dipasang. Usulkan path rute dan lokasi file untuk halaman terpisah Agent Floor.
6. Perilaku pada gate yang habis (`postComment + return`): nilai `final_status` apa yang tercatat, dan apakah itu cukup untuk membedakan "QA habis" dari "implementasi habis"?
7. Bagaimana run multi-repo (`umkm-pos`, `coderium-web-v2`) dibedakan di data.
8. Script yang ada di `package.json` untuk typecheck, lint, test, build, dan baseline test saat ini.

Format keluaran: tabel "kebutuhan event" lawan "tersedia sekarang" dengan kolom **Ada / Sebagian / Tidak ada**, diikuti daftar gap dan rekomendasi apakah T1 diperlukan. Jangan mengubah file lain selain `audit.md`.

## Format laporan di akhir tiap fase

```
## Fase <X> selesai
Status: SUCCESS / NEEDS_HUMAN
Yang dikerjakan: ...
File yang berubah: ...
Quality gate: typecheck / lint / test (jumlah vs baseline) / build, masing-masing PASS, FAIL, atau SKIP (alasan)
Temuan penting dan deviasi dari rencana: ...
Keputusan yang butuh Ganjar: ...
Usulan langkah berikutnya: ...
```

## Yang tidak perlu dilakukan

- Jangan membangun semua fase sekaligus.
- Jangan merombak prototype; ia referensi visual yang sudah di-approve. Pindahkan, pisahkan render dari adapter data, dan pertahankan fungsi publik `setState`, `say`, `sendDoc`, `step`, `setStatus`, `log` sebagai satu-satunya pintu masuk data.
- Jangan menambah fitur di luar `requirements.md` (misalnya kontrol pipeline atau notifikasi).
- Jangan menyatakan "selesai" tanpa menjalankan verify checklist.