# CAF-SDD-04g — Token GitHub tidak lagi tersimpan di workspace (caf-orchestrator)

## Latar belakang

Temuan F-3 dari 04f: `GitService.clone` meng-clone dengan URL `https://x-access-token:<GITHUB_TOKEN>@github.com/...`.
Git menyimpan URL itu apa adanya sebagai `remote.origin.url` di `.git/config`. Akibatnya setiap proses yang berjalan
di workspace (agent, command repo, script yang dijalankan validator) bisa membaca token dengan `cat .git/config`.
04f sudah menghapus `GITHUB_TOKEN` dari env validator, tetapi file ini membuat penghapusan itu percuma.

## Findings (dari kode `src/infrastructure/git/git.service.ts`)

- F-1: `getAuthenticatedRepoUrl` menyisipkan token ke URL; dipakai `clone` dan `remoteBranchExists`.
- F-2: `push` (`git push --set-upstream origin`) dan `preflightCleanup` (`git fetch origin`) TIDAK membawa kredensial sendiri;
  keduanya bergantung pada URL ber-token yang tersimpan di `origin`. Jadi hanya menghapus token dari URL akan mematahkan push/fetch.
- F-3: Workspace persistent (mode persistent, `preflightCleanup` lalu `clone`/reuse) dan jalur resume/retry memakai ulang clone lama.
  Clone lama yang sudah ada di VPS SUDAH berisi token di `.git/config`; perubahan clone baru saja tidak membersihkannya.
- F-4: `GIT_ENV` = `{...process.env, ...}`; `GIT_ASKPASS=echo` dan `GIT_TERMINAL_PROMPT=0` sudah ada.
- F-5: Error dari `runGit` bisa menyertakan argumen/stderr; setelah perubahan, token tidak boleh muncul di argv, log, maupun pesan error.

## Keputusan desain (konsultan; Ganjar boleh mengubah)

- D-1: Kredensial dikirim per perintah git lewat env `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.https://github.com/.extraheader`,
  `GIT_CONFIG_VALUE_0=AUTHORIZATION: basic <base64("x-access-token:<token>")>`. Bukan lewat `-c` (akan muncul di argv / `ps`), bukan lewat file.
  Env ini hanya diberikan ke proses git yang butuh jaringan: `clone`, `push`, `fetch` (di `preflightCleanup`), `ls-remote`. Perintah lokal tidak menerimanya.
- D-2: Clone memakai URL polos `https://github.com/owner/repo.git` (tanpa userinfo). `origin` bersih sejak awal.
- D-3: Migrasi clone lama: `preflightCleanup` dan titik reuse workspace menjalankan `git remote set-url origin <url bersih>`
  (userinfo dibuang) sebelum fetch. Idempoten; tidak error bila sudah bersih.
- D-4: Hanya host `github.com` (perilaku sekarang dipertahankan). URL non-github.com: tidak ada header, perilaku sama seperti sekarang (tanpa token).
- D-5: Bila versi git < 2.31 (tanpa `GIT_CONFIG_COUNT`), gagal dengan pesan jelas saat startup/pemakaian pertama, bukan diam-diam tanpa auth. Dicek di spike T1.

## Acceptance Criteria

- AC-1: Setelah `clone`, `git config --get remote.origin.url` tidak mengandung userinfo/token, dan `.git/config` tidak mengandung `GITHUB_TOKEN` maupun string `x-access-token`.
  Verify: unit test dengan git sungguhan (repo bare lokal sebagai remote) memeriksa isi `.git/config`; plus spike T1 terhadap GitHub nyata bila token tersedia.
- AC-2: `clone`, `push`, `fetch` di `preflightCleanup`, dan `remoteBranchExists` tetap terautentikasi; env `GIT_CONFIG_*` terpasang hanya pada perintah jaringan tersebut.
  Verify: unit test dengan `runGit` di-spy: perintah jaringan menerima env header, perintah lokal (`rev-parse`, `status`, `checkout`, `reset`, `clean`, `commit`, `diff`) tidak.
- AC-3: Token tidak muncul di argv perintah git, di log, maupun di pesan error yang dilempar.
  Verify: unit test memaksa `runGit` gagal dan menegaskan token (dan versi base64-nya) tidak ada di `error.message`, argv yang tercatat, maupun output logger.
- AC-4: Clone lama yang `origin`-nya masih ber-token dibersihkan oleh `preflightCleanup`/reuse sebelum fetch.
  Verify: test membuat clone dengan origin ber-userinfo, menjalankan `preflightCleanup`, lalu menegaskan `remote.origin.url` bersih dan fetch tetap jalan.
- AC-5: Jalur persistent workspace, resume/retry (`remoteBranchExists` lalu `preflightCleanup`/`clone`), PR-review clone, dan commit/push tetap berfungsi tanpa perubahan perilaku.
  Verify: seluruh test lama (`git.service.test.ts`, `git-preflight-cleanup.test.ts`, `workspace-mode-integration.test.ts`, dst.) lulus tanpa diubah; penyesuaian test hanya bila menegaskan bentuk URL lama, dan itu dicatat di report.
- AC-6: Tanpa `GITHUB_TOKEN` atau untuk URL non-github.com perilaku tidak berubah (tidak ada header, tidak error).
  Verify: unit test dua kasus tersebut.
- AC-7: Versi git yang tidak mendukung `GIT_CONFIG_COUNT` menghasilkan error yang jelas.
  Verify: unit test dengan versi git di-stub; pesan menyebut versi minimum 2.31.
- AC-8: `pnpm typecheck && pnpm lint && pnpm test` lulus; jumlah test tidak berkurang.
  Verify: jalankan ketiganya dan catat angkanya.
- AC-9 (manual): CLAUDE.md orchestrator mendapat satu paragraf: token tidak disimpan di workspace; cara auth git; langkah migrasi clone lama.
  Verify: UNVERIFIED (manual) — Ganjar membaca.

## Di luar cakupan

- Mengganti token ke GitHub App / token per-job berumur pendek (calon tiket terpisah).
- Pembersihan token dari clone yang sudah ada di luar jalur `preflightCleanup` (Ganjar bisa menjalankan `git remote set-url` manual di VPS; dicatat di report).
- GHES.