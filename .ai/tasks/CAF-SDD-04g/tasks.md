# CAF-SDD-04g — Tasks

Urutan wajib. Commit lokal saja; jangan push/merge/publish.

## T1 — Spike (sebelum menyentuh `src/`)
- Cek `git --version` lokal; catat. Buktikan di sandbox lokal (repo bare via `file://` TIDAK menguji header HTTP, jadi gunakan juga server HTTP git kecil atau
  verifikasi perilaku `GIT_CONFIG_COUNT/KEY/VALUE` dengan `GIT_TRACE_CURL`/`git config --show-origin` pada perintah `git config --get http.https://github.com/.extraheader`).
- Buktikan: (a) env `GIT_CONFIG_*` terbaca oleh `clone`, `fetch`, `push`, `ls-remote`; (b) tidak ada yang tertulis ke `.git/config` setelah clone dengan URL polos;
  (c) bila ada token GitHub di env sesi, uji `git ls-remote` ke repo privat/publik memakai header; jika tidak ada, tulis "tidak teruji terhadap GitHub nyata" di report.
- Jika D-1 tidak berfungsi, STOP dan laporkan alternatif (credential helper via `GIT_ASKPASS` script sementara) sebelum lanjut.
- Commit: `spike-report.md` di `.ai/tasks/CAF-SDD-04g/`.

## T2 — Helper auth
- Di `git.service.ts`: ganti `getAuthenticatedRepoUrl` dengan `buildGitAuthEnv(repoUrl)` (mengembalikan env tambahan atau `{}`) dan `toCleanRepoUrl(url)` (buang userinfo).
- Cek versi git sekali (cache) dan lempar error jelas bila < 2.31 saat auth dibutuhkan (AC-7).

## T3 — Terapkan ke perintah jaringan
- `clone`: URL bersih + env auth. `push`: env auth. `fetch` di `preflightCleanup`: env auth. `remoteBranchExists`: URL bersih + env auth.
- Perintah lokal tidak diberi env auth (AC-2). Pastikan `runGit` menerima env tambahan per panggilan tanpa mengubah `GIT_ENV` global.

## T4 — Migrasi clone lama
- `preflightCleanup` dan titik reuse workspace: `git remote set-url origin <bersih>` sebelum fetch; idempoten (AC-4).

## T5 — Pencegahan kebocoran
- Pastikan error/log dari `runGit` tidak memuat nilai env auth atau base64-nya; redaksi bila perlu (AC-3).

## T6 — Test
- Test baru `tests/unit/git-auth.sdd04g.test.ts` untuk AC-1,2,3,4,6,7 (pakai repo bare lokal + spy `runGit`).
- Jalankan seluruh suite; sesuaikan test lama hanya bila menegaskan URL ber-token, dan catat tiap penyesuaian.

## T7 — Dokumen
- Satu paragraf di CLAUDE.md orchestrator (AC-9), termasuk instruksi migrasi manual: `git -C <workspace> remote set-url origin https://github.com/<owner>/<repo>.git`.

## T8 — Verifikasi & report
- `pnpm typecheck && pnpm lint && pnpm test`; catat jumlah file/test.
- `verify-report.md` dengan baris pertama `Status: SUCCESS|FAILED`, tabel AC → bukti, daftar penyesuaian test lama, hal yang tidak teruji. Commit TERAKHIR.