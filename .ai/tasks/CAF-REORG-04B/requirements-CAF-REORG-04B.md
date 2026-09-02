## Ticket: CAF-REORG-04B (internal, pra-tracker)
## Status: READY FOR PLAN

## Latar Belakang

Bagian 2 dari 3 Checkpoint 4. `umkm-pos/.claude/agents/frontend.md` dan `backend.md` sudah
di-rename ke `caf-frontend.md`/`caf-backend.md` (CAF-REORG-04A). `caf-orchestrator` sekarang
tidak sinkron — minimal 2 titik hardcoded-name yang sudah ketahuan, kemungkinan ada lebih:

1. **Spawn convention** — komentar eksplisit di `agents.js:46-48`: *"caf-orchestrator only
   recognizes these two fixed implementation roles (agents.modelOverrides in
   `caf.config.yaml`, and CAF.md's `.claude/agents/frontend.md`/`backend.md` convention)"*.
   Catatan: ini nyebut DUA mekanisme (`caf.config.yaml` model override key, DAN convention
   file path) — keduanya perlu dicek, bukan cuma salah satu.
2. **Skip-directive token parsing** — ditemukan saat 04A: `caf-planner.md` menulis token
   literal `frontend`/`backend` ke `tasks.md` sebagai skip-directive, yang di-parse
   `caf-orchestrator` secara eksternal. File/lokasi kode yang parsing ini BELUM diketahui —
   perlu ditemukan di PLAN.

**Prinsip untuk checkpoint ini:** jangan asumsikan cuma 2 titik ini yang ada. Audit
menyeluruh dulu, karena pola yang sama (nama hardcoded di tempat tak terduga) sudah muncul
2x berturut-turut di checkpoint sebelumnya.

## Scope

**In scope:**
- Audit penuh `caf-orchestrator` untuk semua referensi hardcoded `frontend`/`backend`
  sebagai nama agent/role (bukan kata umum)
- Update titik 1 (spawn convention) dan titik 2 (skip-directive parsing) ke `caf-frontend`/`caf-backend`
- Update titik lain yang ditemukan saat audit (kalau ada)
- Cek `umkm-pos/caf.config.yaml` (kalau ada `agents.modelOverrides` dengan key `frontend`/`backend`)
  — ini file di repo `umkm-pos`, bukan `caf-orchestrator`, tapi relevan karena disebut di
  komentar yang sama; laporkan sebagai temuan terpisah kalau perlu diupdate, jangan langsung
  edit repo lain dari sesi ini

**Eksplisit di luar scope:**
- `caf-orchestrator-cms` (CAF-REORG-04C, checkpoint terpisah — stack `website-cms-v2` beda,
  convention role belum tentu sama)
- Dry-run ticket nyata end-to-end (Checkpoint 5)
- Perubahan apapun di `umkm-pos` dari sesi ini (kalau `caf.config.yaml` perlu diupdate,
  itu jadi addendum kecil ke 04A yang dieksekusi di sesi `umkm-pos` terpisah)

## Acceptance Criteria

### AC1 — Audit lengkap
- [ ] Semua referensi `frontend`/`backend` sebagai nama agent/role di codebase
      `caf-orchestrator` terdaftar (grep + baca konteks tiap hit, bukan asumsi dari nama
      variabel doang)
- [ ] Titik 1 (spawn) dan titik 2 (skip-directive) dikonfirmasi lokasinya persis (file +
      baris), plus titik lain kalau ada

### AC2 — Spawn convention diupdate
- [ ] `agents.js` (atau file manapun hasil audit yang benar-benar berisi spawn logic)
      mengenali `caf-frontend`/`caf-backend` sebagai role tetap, bukan `frontend`/`backend`
- [ ] Kalau ada fallback/dual-support (terima nama lama DAN baru) — ini keputusan desain,
      laporkan dulu sebelum implement, jangan diam-diam pilih salah satu

### AC3 — Skip-directive parsing diupdate
- [ ] Lokasi parsing token skip-directive ditemukan dan diupdate untuk mengenali
      `caf-frontend`/`caf-backend`
- [ ] Verifikasi tidak ada tempat lain yang bergantung pada token lama tanpa prefix

### AC4 — Verifikasi fungsional
- [ ] Test spawn langsung: invoke logic spawn `caf-orchestrator` dengan role
      `caf-frontend`/`caf-backend`, pastikan proses `claude --agent caf-frontend` benar-benar
      terpanggil dengan argumen yang benar
- [ ] Test skip-directive: `tasks.md` dummy berisi token `caf-frontend`/`caf-backend` sebagai
      skip target, pastikan parsing logic benar-benar meng-skip agent yang dimaksud

## Non-negotiable constraints
- Jangan ubah repo lain (`umkm-pos`, `caf-orchestrator-cms`) dari sesi ini — laporkan temuan
  yang relevan ke repo lain, jangan langsung edit
- Kalau ada ambiguitas desain (misal fallback dual-support), STOP dan laporkan — jangan pilih
  sendiri
- Verifikasi harus fungsional (test nyata), bukan cuma inspeksi kode