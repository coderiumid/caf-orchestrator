# CAF-DASHBOARD-02: Agent Floor

Repo: `caf-orchestrator`
Artifact path: `.ai/tasks/CAF-DASHBOARD-02/`
Status: READY FOR PLAN. Dikerjakan setelah Task 7 CAF-DASHBOARD-01 selesai.
Referensi visual: `agent-floor.prototype.html` (prototype data mock, gaya dan layout sudah di-approve)

## 1. Konteks

CAF-DASHBOARD-01 menyediakan dashboard monitoring: SQLite (`better-sqlite3`), SSE, vanilla JS SPA tanpa build step, auth memakai middleware basic auth Bull Board. Dashboard itu menjawab "apa yang terjadi" lewat tabel dan angka.

Agent Floor menjawab pertanyaan yang sama dari sisi para agent: halaman pixel-art tempat setiap agent CAF digambarkan sebagai karakter di kantor, bergerak dan bereaksi sesuai fase PIV yang sedang dijalani. Tujuannya dua: (a) membaca kondisi pipeline sekilas, (b) bahan demo dan konten Coderium.

## 2. Keputusan yang sudah final (tidak dibuka ulang)

Diwarisi dari CAF-DASHBOARD-01:

- DB-only untuk data live dan historis. Sinyal "sedang jalan" adalah `pipeline_runs` dengan `final_status IS NULL`. `orchestration-state.json` tidak dipakai.
- `final_status` punya tiga nilai: `SUCCESS`, `NEEDS_HUMAN`, `ERROR`.
- SSE untuk push real-time; endpoint standalone Fastify + vanilla JS SPA tanpa build step, terpisah dari Bull Board.
- Auth memakai middleware basic auth Bull Board yang sudah ada.
- `caf-documentation` sengaja tidak di-instrument (tidak punya `piv_phase`). Di Agent Floor ia tampil off duty, bukan aktif.
- Biaya dan token berasal dari `claude --print --output-format json` (`total_cost_usd` + usage). Tidak ada estimasi.
- Dokumentasi di `docs/dashboard.md`, bukan `.caf/knowledge/`.

Diputuskan di sesi prototype:

- Gaya karakter dan layout sesuai prototype: layar penuh tanpa scroll halaman, tiga kolom (Skenario/Run di kiri, kantor di tengah, Status agent/Kejadian di kanan), scroll hanya di dalam panel, tombol zoom + / − / 1:1.
- Karakter lebih besar relatif terhadap monitor.

Diputuskan Ganjar setelah prototype di-approve:

- **Urutan:** DASHBOARD-02 dimulai setelah Task 7 DASHBOARD-01 (e2e nyata pada `umkm-pos`) selesai, bukan paralel.
- **Bentuk:** halaman terpisah, bukan tab di dashboard yang sudah ada.
- **Path rute dan lokasi file statis:** dikonfirmasi dari kode pada tahap Plan (T0), bukan ditebak sekarang.

## 3. Tujuan

1. Halaman `Agent Floor` di dashboard yang menampilkan run live dari event nyata.
2. Mode replay untuk run historis dari `pipeline_runs`, tanpa memicu pipeline dan tanpa biaya token.
3. Mode demo (data mock) tetap tersedia untuk pengembangan, demo, dan konten.

## 4. Non-goals

- Tidak mengubah alur pipeline, retry logic, atau kontrak parser (`report-reader.ts`).
- Tidak ada kontrol terhadap pipeline dari halaman ini (read-only; tidak ada tombol approve, retry, atau stop).
- Tidak ada build step baru dan tidak ada dependency frontend baru.
- Tidak menginstrument `caf-documentation`.
- Tidak membuat state baru di luar DB.

## 5. Functional Requirements

**FR-1 Rute dan auth.** Halaman terpisah (bukan tab di dashboard yang ada) dengan rutenya sendiri, dilindungi basic auth yang sama. Path rute dan lokasi file statis dikonfirmasi dari kode pada T0. Dari dashboard yang ada cukup disediakan satu tautan masuk.

**FR-2 Peta agent ke karakter.** Karakter: Planner, Backend, Frontend, QA, Reviewer, Docs, dan Ganjar (manusia). Tabel di bawah memetakan `pipeline_runs`/fase ke visual.

| Kondisi di DB/event | Visual |
|---|---|
| Tidak ada run aktif | Semua agent di pantry, Docs off duty |
| Fase plan (Planner) | Planner mengetik, papan tulis terisi |
| Fase implement (Backend/Frontend) | Mengetik, layar menampilkan kode |
| Fase verify | Layar tiga bar: lint, typecheck, test |
| Verify gagal, percobaan < 3 | Garuk kepala, bubble "Ulang n/3" |
| QA gagal, retry gate 1/1 | Bug muncul di QA lab, kembali ke dev |
| `NEEDS_HUMAN` | Tangan terangkat, layar merah, lampu Ganjar merah |
| `ERROR` | Api kecil di kepala; run diulang BullMQ |
| `SUCCESS` + PR dibuka | Dokumen ke kotak PR, lampu Ganjar hijau |

**FR-3 Handoff artifact.** Perpindahan artifact (`requirements.md`, `tasks.md`, `verify-report.md`, `qa-report.md`, `review-notes.md`) tampil sebagai dokumen terbang antar agent, dipicu event handoff.

**FR-4 Panel.** Panel kiri: daftar run (aktif dan historis) dan detail run + tahap pipeline. Panel kanan: status 7 agent, tab Kejadian dan Detail agent (token, biaya, durasi, percobaan verify dari data nyata).

**FR-5 Live.** Perubahan state agent muncul di halaman tanpa reload, melalui SSE yang sudah ada atau perluasannya.

**FR-6 Replay.** Memilih run historis memutar ulang urutan kejadiannya dengan kontrol jeda dan kecepatan 1×/2×/4×. Replay hanya membaca DB.

**FR-7 Demo.** Skenario mock dari prototype tetap bisa dijalankan lewat satu parameter/rute demo, tanpa menyentuh data nyata.

**FR-8 Multi-repo.** Ada pemilih repo (saat ini `umkm-pos` dan `coderium-web-v2`). Run dari repo berbeda tidak bercampur di satu kantor.

## 6. Non-Functional Requirements

- Tanpa build step, tanpa framework, tanpa library eksternal baru. Satu modul adapter data terpisah dari modul render.
- Render stabil dengan 7 karakter; target 60 fps pada laptop biasa, dan tidak membebani server (tidak ada polling per frame).
- Hormati `prefers-reduced-motion` (mulai dalam keadaan jeda) dan tema terang/gelap sistem.
- Keyboard dan screen reader: setiap agent bisa dipilih lewat daftar status (bukan hanya klik di canvas); log memakai `role="log"`.
- Tidak ada secret atau isi kode/prompt yang bocor ke UI; hanya metadata run.
- Kegagalan SSE ditampilkan jelas ("Terputus") dan mencoba tersambung kembali, bukan diam.

## 7. Kontrak Event (usulan, selaras dengan fungsi di prototype)

Adapter di sisi browser menerjemahkan event server ke fungsi yang sudah ada di prototype: `setState`, `say`, `sendDoc`, `step`, `setStatus`, `log`.

| Event | Isi minimal | Fungsi UI |
|---|---|---|
| `run_started` | `runId`, `ticket`, `repo`, `branch`, `startedAt` | reset dunia, isi panel Run |
| `agent_state` | `runId`, `agent`, `state`, `attempt?`, `checks?` | `setState`, `say` |
| `handoff` | `runId`, `from`, `to`, `file` | `sendDoc` |
| `step` | `runId`, `step`, `status`, `note?` | `step` |
| `usage` | `runId`, `agent`, `costUsd`, `tokens` | panel Detail agent |
| `run_finished` | `runId`, `finalStatus`, `prNumber?` | `setStatus`, lampu Ganjar |

State agent valid: `idle`, `planning`, `implementing`, `verifying`, `retrying`, `reviewing`, `celebrating`, `blocked`, `error`, `offduty`. Semua event membawa timestamp dari server.

## 8. Acceptance Criteria

- [ ] Run nyata yang dipicu webhook muncul di Agent Floor dan perubahan fase tampil dalam beberapa detik.
- [ ] Run `NEEDS_HUMAN` menampilkan layar merah dan lampu merah; run `SUCCESS` menampilkan lampu hijau; run `ERROR` menampilkan efek error.
- [ ] Replay run historis menghasilkan urutan yang sama dengan data DB, dan tidak menulis apa pun ke DB.
- [ ] Mode demo berjalan tanpa akses DB.
- [ ] Halaman tidak punya scroll window pada viewport desktop; hanya panel yang scroll.
- [ ] Docs (`caf-documentation`) selalu tampil off duty.
- [ ] Tanpa build step baru; semua file statis dilayani seperti SPA dashboard yang ada.
- [ ] Quality gate lulus (lihat `tasks.md`), dan `docs/dashboard.md` diperbarui.

## 9. Risiko

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Baris DB belum punya granularitas per agent dan fase (mulai/selesai, percobaan verify) | Animasi live tidak bisa akurat | Task 1 (audit) menentukan; jika ada gap, instrumentasi minimal ditambahkan sebelum UI |
| `parseAgentUsage()` sudah dibangun tetapi belum di-wire (catatan DASHBOARD-01) | Biaya per agent kosong | Cek status di Task 1; wiring hanya jika audit menunjukkan perlu |
| Retry QA/Reviewer (maks 1) dan retry implementasi (maks 3) berbeda | Counter menyesatkan | Event membawa jenis gate dan batasnya; UI tidak mengasumsikan "n/3" |
| Gate exhaustion berakhir dengan `postComment + return`, bukan `throw` | Status akhir ambigu di UI | Sumber kebenaran tetap `final_status` di `pipeline_runs`; UI tidak menyimpulkan sendiri |
| Task 7 DASHBOARD-01 (e2e nyata) belum selesai | DASHBOARD-02 tidak boleh mulai | Ditetapkan sebagai prasyarat; run nyata dari Task 7 menjadi data uji untuk replay dan audit T0 |

## 10. Keputusan atas Pertanyaan Sebelumnya

| Pertanyaan | Keputusan |
|---|---|
| Kapan dikerjakan? | Setelah Task 7 DASHBOARD-01 selesai |
| Path rute dan lokasi file statis | Dikonfirmasi dari kode saat Plan (T0) |
| Halaman terpisah atau tab? | Halaman terpisah |

Tidak ada pertanyaan terbuka yang tersisa di tingkat requirements. Hal yang masih perlu dijawab dari kode (granularitas data, status `parseAgentUsage()`, struktur SPA) ditangani oleh T0.