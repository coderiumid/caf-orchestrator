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
- Perubahan pada `RunPrReviewUseCase`, `report-reader.ts`, atau retry logic di
  `run-agent-pipeline.use-case.ts` — area stabil, tidak boleh tersentuh oleh fitur ini

## Pertanyaan Terbuka (STOP items — jangan diputuskan sendiri oleh agent)

**DIJAWAB USER (2026-09-03):**
1. Skema path: **Opsi B** — `{workspace.dir}/{githubRepoName}`.
2. Deployment topology: **single VPS instance** → lock **in-memory** per-process
   (`Map`/semaphore), tidak perlu Redis-based lock.
3. Behavior saat lock terpegang: **reject langsung** + comment ke ticket
   "workspace busy, coba lagi nanti" (bukan queue-with-timeout).
