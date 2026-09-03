# Ticket: CAF-WSMODE-01 — Workspace Mode (Ephemeral / Persistent)

## Latar Belakang
`caf-orchestrator` saat ini selalu clone repo ke folder temporary baru setiap ada
task/review job (mode `ephemeral` implisit). Untuk repo besar (mis. `website-cms-v2`,
30+ domain layer), full clone tiap job mahal dari sisi waktu & resource. Dibutuhkan
opsi `persistent` di mana `workspaceDir` reuse folder clone existing milik orchestrator
sendiri (bukan folder kerja developer), tinggal `fetch` + `checkout -B` branch baru
per job.

Hasil audit repo (dilakukan sebelum requirement ini ditulis, sesuai prinsip
"audit actual code before accepting claims"):
- Field `workspace.dir` SUDAH ADA di `src/config/schema.ts`, dipakai sebagai global
  default root oleh `git.service.ts`, `workspace.manager.ts`, `health.ts`.
- Field `workspace.mode`, `enableTemporary`, `persistentPath` — ZERO hits di seluruh
  repo. Clean slate, tidak ada implementasi parsial yang perlu diselaraskan.
- Tidak ada perubahan tak terdokumentasi lain yang menyentuh area ini.

## Apa yang Diminta
Tambahkan opsi konfigurasi `workspace.mode` (`ephemeral` | `persistent`) di
`caf.config.yaml`, dengan `ephemeral` sebagai default (backward compatible — behavior
existing tidak berubah kalau field ini di-omit).

Ketika `mode: persistent`:
- `workspaceDir` untuk repo tertentu di-reuse antar run, bukan clone baru tiap job
- Base path tetap pakai `workspace.dir` yang sudah ada di config (field existing) —
  TIDAK menambah field baru seperti `persistentPath`
- Subfolder per repo di bawah `workspace.dir` (skema path pasti ditentukan di fase
  design, tergantung struktur `workspace.manager.ts` saat ini)

## Acceptance Criteria
- [ ] `workspace.mode` bisa diset `ephemeral` atau `persistent` di `caf.config.yaml`,
      divalidasi via zod schema (`src/config/schema.ts`)
- [ ] Kalau `workspace.mode` di-omit → behavior identik dengan sebelum perubahan ini
      (default `ephemeral`, tidak ada regresi)
- [ ] Mode `persistent`: job kedua untuk repo yang sama TIDAK bisa mulai eksekusi
      selama job pertama masih pegang lock pada `workspaceDir` yang sama (dicegah,
      bukan race condition yang menimpa satu sama lain)
- [ ] Mode `persistent`: sebelum checkout branch baru, ada pre-flight cleanup step
      (fetch + reset ke base branch + clean) yang HASILNYA di-log secara eksplisit
      (bukan silent) — lokasi log ditentukan di fase design
- [ ] Mode `persistent`: kalau job sebelumnya berakhir `NEEDS_HUMAN` dengan
      uncommitted/unpushed changes, pre-flight cleanup tidak boleh diam-diam
      menghapus kerjaan itu tanpa jejak — minimal ada log yang menyebutkan branch apa
      yang di-reset dan komit terakhir sebelum reset (audit trail)
- [ ] `caf-initiator` — TIDAK ADA perubahan sama sekali (dikonfirmasi: config yaml
      orchestrator bersifat statis, tidak di-generate oleh `caf-initiator`)
- [ ] Dokumentasi: `caf.config.yaml` contoh/template (kalau ada) diupdate untuk
      menjelaskan `workspace.mode` dan kapan pakai yang mana
- [ ] **[BARU]** `workspace.mode: persistent` di config global TIDAK mengubah
      behavior `RunPrReviewUseCase` — PR-review job tetap ephemeral, dibuktikan
      dengan test yang menjalankan PR-review job saat `workspace.mode: persistent`
      di-set dan memverifikasi cleanup tetap terjadi seperti biasa
- [ ] **[BARU]** Saat lock ditolak (`WorkspaceLockError`) untuk ticket-pipeline job:
      comment "workspace busy" benar-benar terkirim ke Linear, job berhenti bersih
      (`return`, bukan `throw`/propagate ke retry BullMQ generik)
- [ ] **[BARU]** Perubahan di `run-agent-pipeline.use-case.ts` dan
      `run-pr-review.use-case.ts` terbatas PERSIS sesuai daftar di bagian "Scope
      Resmi Diperluas" — dibuktikan dengan `git diff` yang direview manual, bukan
      cuma `git diff --stat`

## Update Pasca-Attempt 1 (2026-09-03) — Keputusan Scope `workspacePurpose`

Attempt pertama (Task 0–3 sukses, Task 4 STOP di `NEEDS_HUMAN`) menemukan gap desain
yang tidak terlihat di penulisan requirement awal: `WorkspaceManager` dan `GitService`
adalah singleton yang dipakai bersama oleh dua use case berbeda —
`run-agent-pipeline.use-case.ts` (ticket-pipeline) DAN `run-pr-review.use-case.ts`
(`RunPrReviewUseCase`, PR-review job). Requirement awal cuma menyebut "single-repo-
per-instance" tapi tidak membahas bahwa `workspace.mode: persistent` akan otomatis
bocor ke PR-review job juga kalau tidak di-scope secara eksplisit.

**Keputusan (diambil user setelah laporan NEEDS_HUMAN):**
`workspace.mode: persistent` **HANYA berlaku untuk ticket-pipeline job**. PR-review
job (`RunPrReviewUseCase`) TETAP `ephemeral` selalu, tidak peduli nilai
`workspace.mode` di config global.

Mekanisme: tambah parameter eksplisit `workspacePurpose: 'ticket-pipeline' |
'pr-review'` di titik pemanggilan `WorkspaceManager`/`GitService`. Behavior
persistent (skip cleanup, reuse folder, lock) hanya aktif kalau
`workspacePurpose === 'ticket-pipeline'` DAN `config.workspace.mode === 'persistent'`.
Kalau `workspacePurpose === 'pr-review'` → selalu ephemeral, terlepas dari config.

**Konsekuensi pada scope:** dua file yang sebelumnya eksplisit out-of-scope sekarang
resmi masuk scope, dengan perubahan yang diizinkan dibatasi ketat (lihat bawah).

## Eksplisit Out of Scope (Jangan Dikerjakan)
- Mode ketiga (mis. "persistent-recycled" / auto-reset tiap N run) — masih spekulasi,
  belum ada keputusan desain
- Perubahan apapun di `caf-initiator`
- Integrasi dengan repo registry Priority A (multi-repo config) — belum ada di
  `caf-orchestrator` saat ini, jadi fitur ini didesain untuk single-repo-per-instance
  seperti kondisi sekarang; kalau Priority A jalan duluan nanti, `workspace.mode` ini
  perlu direvisit untuk digabung dengan `repoId` config
- Fix untuk `DASHBOARD_BASIC_AUTH_PASSWORD` — item terpisah, tidak terkait, jangan
  digabung ke ticket ini
- `report-reader.ts` dan retry logic (`qaRetryCount`/`reviewerRetryCount`,
  `MAX_QA_RETRIES`/`MAX_REVIEWER_RETRIES`) di `run-agent-pipeline.use-case.ts` — area
  stabil, tidak boleh tersentuh oleh fitur ini

## Scope Resmi Diperluas (Diizinkan, Terbatas) — sejak Update Pasca-Attempt 1
- **`run-agent-pipeline.use-case.ts`** — HANYA 4 perubahan berikut yang diizinkan
  (poin 4 ditambah saat implementasi Task 4b menemukan clone call juga perlu
  kondisional, bukan cuma cleanup — konsekuensi logis langsung dari desain reuse,
  bukan keputusan baru):
  1. Pass `workspacePurpose: 'ticket-pipeline'` di pemanggilan `createWorkspace()`
     (baris ~149)
  2. Tambah `try/catch` di sekitar `createWorkspace()` (yang saat ini SEBELUM blok
     `try` utama di baris 159) khusus untuk menangkap `WorkspaceLockError` → post
     comment ke Linear ("workspace busy, coba lagi nanti") lalu `return` bersih
     (BUKAN `throw` — konsisten dengan prinsip "return vs throw" project ini: ini
     bukan infrastructure exception, jangan biarkan numpang ke retry BullMQ generik)
  3. Di blok `finally` (baris ~515): panggilan `cleanupWorkspace()` jadi conditional
     — skip kalau `workspacePurpose === 'ticket-pipeline'` DAN
     `config.workspace.mode === 'persistent'`
  4. Baris ~160: clone call jadi conditional — skip clone (panggil
     `gitService.preflightCleanup()` sebagai gantinya) HANYA kalau
     `workspacePurpose === 'ticket-pipeline'`, mode `persistent`, DAN workspace
     untuk repo ini sudah pernah di-clone sebelumnya. Selain itu (termasuk
     first-run persistent) → clone seperti biasa.
  - **DILARANG**: mengubah apapun di luar 4 poin ini pada file tersebut — termasuk
    retry logic, struktur try/catch yang sudah ada untuk keperluan lain, atau urutan
    step lain di pipeline
- **`run-pr-review.use-case.ts`** (`RunPrReviewUseCase`) — HANYA 1 perubahan:
  1. Pass `workspacePurpose: 'pr-review'` secara eksplisit di titik pemanggilan
     `WorkspaceManager`/`GitService` yang sama
  - **DILARANG**: mengubah logic review lainnya di file ini sama sekali

## Pertanyaan Terbuka (STOP items — jangan diputuskan sendiri oleh agent)
1. Skema path subfolder persistent di bawah `workspace.dir` — per `repoId`? Per nama
   repo GitHub? Ini perlu dipastikan konsisten dengan struktur `workspace.manager.ts`
   yang sudah ada.
2. Lock mechanism: in-memory per-process cukup, atau perlu file lock (kalau ada
   kemungkinan lebih dari satu instance orchestrator jalan)? Tentukan di fase design
   berdasarkan deployment topology aktual (single VPS instance atau bisa scale out?).
3. Kalau lock sedang dipegang dan job baru masuk — job itu di-reject langsung, atau
   di-queue nunggu lock lepas (dengan timeout)? Ini keputusan behavior yang perlu
   dikonfirmasi user sebelum implement.