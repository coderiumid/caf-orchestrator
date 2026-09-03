# Design: CAF-WSMODE-01 — Workspace Mode

> Status: DRAFT — mengandung 3 STOP item yang butuh keputusan user sebelum implement
> (lihat `requirements.md` bagian "Pertanyaan Terbuka"). Jangan mulai Implement sebelum
> ketiganya dijawab eksplisit.

## Pendekatan Teknis

### 1. Skema Config
```yaml
workspace:
  dir: /var/caf-workspaces        # SUDAH ADA — tidak berubah, tetap base root
  mode: ephemeral                 # BARU — default "ephemeral" kalau di-omit
```

Perubahan di `src/config/schema.ts`:
- Tambah field `mode` di dalam objek `workspace` yang sudah ada
- `z.enum(['ephemeral', 'persistent']).default('ephemeral')`
- TIDAK menambah field `persistentPath` baru — base path tetap `workspace.dir`

### 2. Path Resolution (tergantung jawaban STOP item #1)
Kandidat skema (pilih setelah dikonfirmasi struktur `workspace.manager.ts` aktual):
- Opsi A: `{workspace.dir}/{repoId}` — konsisten kalau nanti gabung dengan Priority A
- Opsi B: `{workspace.dir}/{githubRepoName}` — lebih simpel untuk kondisi single-repo
  sekarang, tapi berpotensi collision kalau nanti multi-repo dengan nama sama beda org

**Rekomendasi sementara:** Opsi B untuk sekarang (sesuai kondisi single-repo saat ini),
dengan catatan eksplisit di kode (comment) bahwa ini perlu direvisit saat Priority A
(multi-repo) mulai dikerjakan — supaya tidak ada breaking change diam-diam nanti.
**Ini tetap harus dikonfirmasi ke user, bukan diputuskan otomatis oleh agent.**

### 3. Lock Mechanism (tergantung jawaban STOP item #2 & #3)
Kerangka minimal (detail final menunggu konfirmasi):
- Lock key = path workspace yang di-resolve di atas
- Cek deployment topology aktual dulu: apakah `caf-orchestrator` selalu jalan sebagai
  1 process di 1 VPS (sesuai referensi teknologi CAF.md: "VPS kecil ~$5-6/bulan,
  runner infra Hetzner/DigitalOcean")? Kalau ya → in-memory lock (`Map<string, boolean>`
  atau semaphore sederhana) cukup, tidak perlu file lock atau Redis-based lock meski
  BullMQ+Redis sudah tersedia sebagai infra.
  Kalau ada rencana scale-out → wajib pakai Redis-based lock (Redis sudah ada sebagai
  dependency, jadi tidak nambah infra baru), karena in-memory lock tidak akan konsisten
  antar instance.
- Behavior saat lock terpegang (job kedua datang untuk workspace yang sama):
  - Reject langsung + comment ke ticket "workspace busy, coba lagi nanti", ATAU
  - Queue dengan timeout (BullMQ sudah punya delay/retry mechanism, bisa dimanfaatkan)
  Ini murni keputusan produk/UX, bukan keputusan teknis — user yang putuskan.

### 4. Pre-flight Cleanup (mode persistent, sebelum checkout branch baru)
Urutan langkah:
1. `git fetch origin` — update refs
2. Cek apakah ada uncommitted changes di workspace saat ini
   - Kalau ADA: log detail (branch, `git status --short`, HEAD commit) SEBELUM reset —
     ini audit trail wajib sesuai acceptance criteria, bukan opsional
3. `git checkout {base_branch}` (base branch dari config, biasanya `main`/`master`)
4. `git reset --hard origin/{base_branch}`
5. `git clean -fd`
6. Log hasil tiap langkah ke lokasi yang konsisten dengan pola existing —
   **perlu dicek dulu**: apakah `verify-report.md` per-ticket adalah tempat yang tepat,
   atau perlu log terpisah level-orchestrator (mis. `logs/workspace-cleanup.log`)
   karena ini terjadi SEBELUM job attach ke ticket manapun. Rekomendasi: log terpisah
   level-orchestrator, karena `verify-report.md` scope-nya per-ticket dan cleanup ini
   terjadi lintas-ticket.

**Catatan prinsip:** Ini secara teknis adalah "destructive command" (`reset --hard`,
`clean -fd`). Sesuai prinsip "no auto-clear, no force-overwrite without explicit
decision" — perlu dipastikan bahwa scope destruktif ini HANYA berlaku pada folder
scratch space milik orchestrator sendiri (bukan folder kerja manusia manapun), dan
ini harus dinyatakan eksplisit sebagai keputusan yang sudah diambil sadar (bukan
default diam-diam) di PR description / commit message perubahan ini.

### 5. Perubahan File yang Diperkirakan
- `src/config/schema.ts` — tambah `mode` enum
- `src/config/caf.config.example.yaml` (atau nama file contoh yang sesuai, cek dulu
  namanya di repo) — tambah contoh `workspace.mode`
- `src/services/workspace.manager.ts` — logic percabangan ephemeral vs persistent,
  pre-flight cleanup, lock acquire/release
- `src/services/git.service.ts` — kemungkinan perlu expose fungsi cleanup terpisah
  kalau belum ada
- File log baru untuk cleanup audit trail (lokasi final tergantung keputusan di atas)
- **TIDAK ADA perubahan** di `caf-initiator`, `report-reader.ts`,
  `run-agent-pipeline.use-case.ts`, `RunPrReviewUseCase`

## Testing Strategy
- Unit test: config validation (mode invalid → error jelas, mode omitted → default
  `ephemeral`, behavior identik dengan sebelum perubahan)
- Unit test: lock acquire/release — job kedua pada workspace yang sama tidak bisa
  jalan bersamaan dengan job pertama
- Integration test (real repo, sesuai prinsip "fixture passing ≠ safe"): jalankan
  2 job berurutan pada repo yang sama dengan `mode: persistent`, verifikasi:
  - Job kedua tidak melihat sisa state dari job pertama (branch, uncommitted changes)
  - Log audit trail cleanup benar-benar tercatat
- Regression test: `mode: ephemeral` (atau `workspace.mode` di-omit) — jalankan
  end-to-end seperti biasa, pastikan tidak ada perubahan behavior sama sekali