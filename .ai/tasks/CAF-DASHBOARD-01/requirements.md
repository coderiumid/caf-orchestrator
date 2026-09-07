# Ticket: CAF-DASHBOARD-01
## Judul: Dashboard Agent Monitoring (Backlog B — caf-orchestrator)

## Latar Belakang
Bull Board yang sudah ada di `/admin/queues` hanya menampilkan status di level
job-queue (BullMQ). Tidak ada visibilitas di level semantik-agent: fase PIV yang
sedang berjalan, retry count per gate (QA/Reviewer), cost per agent run, dan link
ke artifact (`verify-report.md`, `qa-report.md`, `review-notes.md`).

Dikerjakan setelah Backlog A (Multi-repo + config) karena dashboard perlu aware
terhadap banyak repo berjalan paralel — mengerjakan ini sebelum A selesai akan
menyebabkan rework repo-scoping. **A sudah selesai** (multi-repo berjalan,
menggunakan sub-step `maxOrchestrationRetries`), jadi B sudah bisa mulai.

## Keputusan Desain (dikonfirmasi user)

| Keputusan | Pilihan |
|---|---|
| Sumber data live status | `orchestration-state.json` per repo, di-watch (bukan polling file) |
| Sumber data histori/log | Tabel DB baru |
| Update UI | SSE push saat ada event (bukan polling interval) |
| Penempatan | Endpoint baru di `caf-orchestrator` (Fastify) + SPA sendiri, terpisah dari Bull Board |
| Auth | Reuse basic auth middleware yang sama dengan Bull Board |

## Assumption (dikonfirmasi user, 07 Sep 2026)
1. Auth dashboard reuse basic auth middleware existing — tidak bikin auth baru.
2. Sumber data cost per agent run **belum tentu ada** di output Claude Code
   headless saat ini — perlu dicek dulu di Task 2 (`tasks.md`). Kalau tidak ada,
   ini jadi task instrumentasi baru, bukan sekadar parsing data yang sudah ada.

## Scope

**In scope:**
- Live status pipeline yang sedang berjalan (multi-repo aware)
- Histori pipeline run yang sudah selesai (DB-backed)
- Fase PIV saat ini, retry count per gate, cost (kalau data tersedia), link artifact
- SSE stream untuk update real-time di UI
- REST endpoint untuk query histori + detail 1 pipeline run

**Out of scope (bukan bagian ticket ini):**
- Replacing Bull Board (job-queue level tetap dipakai terpisah)
- Auth baru / role-based access — reuse yang sudah ada
- Analytics/reporting lanjutan (agregasi cost per bulan, dsb) — bisa jadi ticket
  lanjutan kalau dibutuhkan setelah data historis terkumpul

## Acceptance Criteria
- [ ] Dashboard menampilkan pipeline yang sedang berjalan, live, tanpa refresh manual (SSE)
- [ ] Multi-repo: 2 pipeline paralel di repo berbeda tampil terpisah, tidak tercampur
- [ ] Histori pipeline run tersimpan di DB dan bisa di-query lewat REST endpoint
- [ ] Tiap pipeline run menampilkan: fase PIV saat ini/terakhir, retry count per gate,
      cost (atau indikator "belum tersedia" kalau data cost tidak ada), link ke artifact
- [ ] Dashboard terproteksi basic auth yang sama dengan Bull Board
- [ ] DB write di titik instrumentasi tidak boleh menjatuhkan pipeline utama kalau gagal
      (log warning, bukan throw)
- [ ] Real-repo end-to-end test PASS di `umkm-pos` (bukan cuma unit test)

## Referensi Artifact Terkait
- `orchestration-state.json` — sudah punya field `ticketId`/`ticketTitle`/
  `ticketDescription`/`ticketSource` dari CAF-RETRYPIPELINE-01, bisa langsung dipakai
- `run-agent-pipeline.use-case.ts` — titik di mana state.json di-update, jadi titik
  yang sama untuk tambah event write ke DB