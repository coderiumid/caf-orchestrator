# CAF-SDD-04f — Tasks

Eksekusi di `caf-orchestrator`. Revisi 2 (17 Okt): spike versi pertama ditemukan salah memakai `Write(...)`; berkas tiket ini menggantikan versi yang sudah di-commit. Hanya commit lokal. Jangan push, jangan merge. Berkas tiket ada di `.ai/tasks/CAF-SDD-04f/` (di orchestrator `.ai/tasks/` di-track git); pakai apa adanya.

## Frontend Tasks
(none)

## Backend Tasks
- T1 (baca dan uji dulu, sebelum menyentuh `src/`): bila branch aktif adalah `ai-agent/CAF-SDD-04e` (belum di-merge), tetap di branch itu; selain itu buat `ai-agent/CAF-SDD-04f` dari `main` terbaru. `git status` boleh hanya menunjukkan berkas tiket 04f yang untracked. Verifikasi Findings F-1..F-8 dan Assumptions A-1..A-4 terhadap kode, termasuk daftar pasti kunci `envSchema` dan `grep` atas pemakai env rahasia di jalur validator. STOP dan laporkan bila ada temuan yang bertentangan dengan sebuah AC.
  - Spike nyata (AC-9), bila CLI `claude` tersedia dan kuota ada. Versi pertama sudah dijalankan (Claude Code 2.1.302): flag diterima, perintah di luar daftar ditolak, tetapi aturan `Write(...)` tidak pernah mengizinkan penulisan (hanya `Edit(...)` dan `Read(...)` yang dikonsultasi). Ulangi dengan flag yang sama persis dengan AC-1: `--agent caf-validator --print --output-format json --permission-mode dontAsk --setting-sources project --allowedTools "Bash(pnpm run *)" "<aturan Edit>"`, di direktori sementara yang punya `.caf/tasks/TEST/` dan agent `caf-validator` (frontmatter `tools: Read, Write, Bash`) dan prompt satu kalimat per kasus. Coba kandidat `Edit(.caf/tasks/**)`, `Edit(**/.caf/tasks/**)`, `Edit(//<path absolut direktori>/.caf/tasks/**)` berurutan sampai satu lolos; kasus: (a) perintah yang cocok daftar berjalan; (b) `curl --version` ditolak tanpa prompt; (c) menulis `outside.txt` lewat tool Write ditolak, menulis `.caf/tasks/TEST/validate-report.md` lewat tool Write berhasil, dan pengalihan `>` ke `outside.txt` lewat perintah yang cocok daftar (mis. `pnpm run x > outside.txt`) ditolak. Catat versi `claude --version`, bentuk `Edit(...)` yang dipilih, dan tiap hasil. Bila tidak satu kandidat memenuhi (c), STOP dan laporkan sebelum menyentuh `src/`. Bila CLI atau kuota tidak tersedia, lanjutkan, catat alasannya, dan tulis prosedur manual untuk dijalankan sebelum deploy.
- T2 (AC-6): di `schema.ts` tambahkan `agents.validator` (`restrictBash` default true, `allowedCommands` default D-4) dengan validasi D-4/Constraints, dan ekspor dua konstanta klasifikasi env serta `envSchema` (atau daftar kuncinya) seperlunya. Perbarui `caf.config.example.yaml` dengan kunci baru dan komentar. Jangan mengubah kunci lain.
- T3 (AC-1..AC-4): di `SpawnAgentService.run` tambahkan cabang `caf-validator` + `restrictBash` sesuai Constraints (argumen termasuk `--setting-sources project` dan aturan `Edit(...)` hasil spike, serta env). Jangan menyentuh `config.agents.validator` di cabang agent lain.
- T4 (AC-1..AC-6): tulis `tests/unit/spawn-agent.validator.test.ts`, `tests/unit/spawn-agent.env-classification.test.ts`, `tests/unit/config-agents-validator.test.ts` sesuai `Verify:`. Jangan mengubah test lama; `spawn-agent.service.test.ts` harus lulus apa adanya.
- T5 (AC-8): perbarui `CLAUDE.md` dan `README.md` sesuai AC-8, termasuk menyelaraskan kalimat tentang env anak dan "Neither is configurable".
- T6 (AC-7, AC-9): jalankan `pnpm typecheck && pnpm lint && pnpm test`. Tulis `verify-report.md` di `.ai/tasks/CAF-SDD-04f/` dengan baris `Status:` polos (`SUCCESS` atau `NEEDS_HUMAN`), tabel per AC (id | status | metode | bukti), dan bagian `### Notes` (deviasi, hasil spike atau alasan tidak dijalankan beserta prosedur manual, usulan perubahan spec di baris `Proposed Spec Changes:`). Commit `verify-report.md` sebagai commit terakhir.

## Docs Tasks
(none)

## Skip Agents
(none)

## Coverage
- AC-1: T1, T3, T4
- AC-2: T3, T4
- AC-3: T3, T4
- AC-4: T3, T4
- AC-5: T2, T4
- AC-6: T2, T4
- AC-7: T6
- AC-8: T5
- AC-9: T1, T6