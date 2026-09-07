# Ticket: CAF-DASHBOARD-01
## Tasks Breakdown

Urutan eksekusi: **1 → 3 → 4 → 5 → 6 → 7 → 8**, dengan **Task 2** dikerjakan paralel
(hasilnya menentukan apakah Task 6 perlu placeholder "cost belum tersedia").

---

### Task 1 — DB schema & migration
- Buat migration untuk tabcodclel `pipeline_runs` dan `agent_events`
- Storage: SQLite embedded (ringan, sesuai skala VPS kecil, tanpa dependency infra baru)
- Skema:
  ```sql
  pipeline_runs
    id, repo_id, ticket_id, ticket_title, started_at, ended_at, final_status

  agent_events
    id, pipeline_run_id, agent_name, piv_phase (plan/implement/verify),
    event_type (start/end/retry/gate_exhausted), retry_count, cost_usd,
    artifact_link, created_at
  ```
- Buat repository/query layer (insert event, query by repoId/ticketId, pagination)

**Verify:** migration jalan bersih di environment kosong, query layer punya unit test dasar.

---

### Task 2 — Instrumentasi cost tracking (paralel dengan Task 1)
- Cek apakah output Claude Code headless (`claude --agent`) expose usage/cost di response
- Kalau ada → parse langsung
- Kalau tidak ada → hitung dari token count × rate model yang dipakai (perlu tabel rate per model)
- Tambah capture point di titik spawn tiap agent (planner, frontend, backend, qa, reviewer)

**STOP checkpoint:** kalau Claude Code headless sama sekali tidak expose data yang cukup
untuk estimasi cost yang masuk akal, laporkan sebagai gap ke user — jangan tampilkan
angka cost yang tidak bisa dipertanggungjawabkan.

**Verify:** cost tercatat untuk minimal 1 agent run nyata, angkanya masuk akal
(dibandingkan manual dari Claude Code usage/billing).

---

### Task 3 — Event writer di titik existing
- Cari semua titik di `run-agent-pipeline.use-case.ts` (dan use-case sejenis) yang
  sudah update `orchestration-state.json`
- Tambah write ke `agent_events` di titik yang sama — event_type: `start`, `end`,
  `retry`, `gate_exhausted`
- DB write dibungkus try/catch — gagal write = log warning, **jangan throw**
  (instrumentasi tidak boleh menjatuhkan pipeline utama)

**Verify:** jalankan 1 pipeline lokal, cek `agent_events` terisi sesuai urutan
kejadian aktual; simulasikan DB unavailable, pastikan pipeline tetap jalan normal.

---

### Task 4 — File watcher + SSE stream
- Setup `chokidar` watch ke folder `orchestration-state.json` per-repo
- Route `GET /api/events/stream` — kirim event ke semua client tersambung saat file berubah
- Event bawa `repoId` supaya frontend bisa filter per repo (multi-repo aware, sejalan
  dengan Backlog A yang sudah jalan)

**Verify:** buka 2 SSE client, ubah state.json di 2 repo berbeda, konfirmasi tiap
client terima event dengan `repoId` yang benar.

---

### Task 5 — REST endpoints
- `GET /api/pipelines` — merge live (state.json) + histori (DB), filter `repoId`
- `GET /api/pipelines/:repoId/:ticketId` — detail lengkap 1 pipeline run + semua
  `agent_events`-nya
- Reuse basic auth middleware yang sama dengan Bull Board (bukan bikin auth baru)

**Verify:** endpoint reject request tanpa auth (401), response shape konsisten
antara data live dan data histori (field yang sama meski sumbernya beda).

---

### Task 6 — Frontend SPA
- Halaman `/dashboard`, vanilla JS (tanpa build step berat), konek ke SSE stream
- Tabel pipeline aktif: repo, ticket, fase PIV, retry count per gate, cost running
  total (atau "belum tersedia" — tergantung hasil Task 2), link artifact
- Klik row → panel detail histori event (timeline sederhana)

**Verify:** buka dashboard di browser, pipeline yang lagi jalan update tanpa refresh
manual; klik row nampilin histori lengkap.

---

### Task 7 — Verify & real-repo test
- Unit test: DB query layer, SSE event emission
- Real-repo test: jalankan 1 ticket end-to-end di `umkm-pos`, konfirmasi dashboard
  nampilin fase PIV secara live sampai selesai, histori tersimpan benar di DB
- Multi-repo test: jalankan 2 pipeline paralel (repo berbeda), pastikan dashboard
  bisa bedain dan tidak saling campur

**Verify:** semua acceptance criteria di `requirements.md` tercentang.

---

### Task 8 — Dokumentasi
- Update `docs/` atau `.caf/knowledge/` — cara akses dashboard, cara baca kolom
  cost/retry, catatan kalau instrumentasi cost ternyata cuma estimasi
  (bukan angka pasti dari API)

**Verify:** dokumen bisa diikuti orang lain (bukan cuma Ganjar) untuk akses & baca dashboard.