# Tasks: CAF-ORCH-PRREVIEW-03

> STOP item sudah terjawab (auto-fallback ke COMMENT). Task 1 tetap wajib
> investigasi dulu — scope ini dibangun dari 2 kali revisi premis yang
> salah, jangan asumsikan pemahaman sekarang sudah 100% akurat sampai kode
> aktual dibaca ulang di sesi implementasi.

## Task 1 — Investigasi Detail Kontrak `review-notes.md` & `buildReviewerPrompt()`
- [ ] Baca `caf-reviewer.md` (definisi agent, ambil dari
      `coderium-web-v2`/`umkm-pos` atau template `caf-initiator` — pilih
      yang paling representatif, catat sumbernya) — pahami PERSIS format
      `review-notes.md` mode INITIAL (Verdict, Security Audit, Qualitative
      Review, Verdict Rationale)
- [ ] Baca `buildReviewerPrompt()` (`run-pr-review.use-case.ts` atau file
      terkait) — pahami struktur saat ini, rencanakan percabangan mode
      `initial` vs `scoped`/`global` yang paling minim invasif
- [ ] Baca `review-command.js` bagian mapping Verdict → event, dan bagian
      penanganan Verdict yang tidak dikenali/tidak ada — ini yang harus
      ditiru persis, bukan diinterpretasi ulang
- [ ] Baca bagian self-review 422 di `review-command.js` — pahami PERSIS
      bagaimana 422 terdeteksi (response code, atau pesan error spesifik
      dari GitHub API) supaya deteksinya konsisten di webhook
- [ ] **Checkpoint**: laporkan rencana percabangan prompt + estimasi
      seberapa invasif perubahan ke `buildReviewerPrompt()`, sebelum lanjut
      Task 2 — kalau ternyata ada kerumitan baru (skenario 3 dari 2 ticket
      sebelumnya), laporkan dulu

## Task 2 — Reader `review-notes.md`
- [ ] Buat fungsi setara `readFixReviewLog()` tapi untuk format
      review-notes (Verdict, Security Audit, dst)
- [ ] Handle kasus Verdict tidak dikenali/tidak ada — sesuai cara
      `review-command.js` menanganinya (STOP/error jelas, bukan default)

## Task 3 — Percabangan Prompt Mode `initial`
- [ ] `buildReviewerPrompt()` (atau setara) bercabang: `initial` → prompt
      INITIAL sungguhan; `scoped`/`global` → TETAP seperti sekarang, byte
      -for-byte tidak berubah
- [ ] Verifikasi lewat test bahwa prompt yang dikirim ke subagent untuk mode
      `scoped`/`global` identik dengan sebelum perubahan ini

## Task 4 — Verdict → Event Mapping + `createPullRequestReview`
- [ ] Mapping APPROVE/CHANGES REQUESTED/DEFER → APPROVE/REQUEST_CHANGES/
      COMMENT, identik `review-command.js`
- [ ] `IVcsClient`/`GithubService` — tambah `createPullRequestReview`
      (`POST pulls/{number}/reviews`)
- [ ] Self-review 422 — deteksi sesuai Task 1, auto-fallback ke `event:
      COMMENT` dengan Verdict asli dinyatakan eksplisit di body (sesuai
      keputusan final)

## Task 5 — Test
- [ ] Regression: mode `scoped`/`global` — prompt, report reading, posting
      — semuanya byte-for-byte/behavior tidak berubah
- [ ] Test mode `initial`: prompt yang dikirim ke subagent sesuai INITIAL
      contract, `review-notes.md` terbaca benar, Verdict termapping benar,
      PR Review object terposting dengan `event` yang sesuai
- [ ] Test Verdict tidak dikenali/tidak ada → behavior sesuai
      `review-command.js` (STOP/error jelas)
- [ ] Test self-review 422 → auto-fallback ke COMMENT, body menyatakan
      Verdict asli
- [ ] Integration test (real GitHub API sandbox kalau tersedia, atau
      minimal assert request yang benar) untuk `createPullRequestReview`

## Task 6 — Dokumentasi
- [ ] Update `review-command.js` komentar soal gap kontrak (baris yang
      relevan, cek nomor baris terbaru) — sekarang webhook mode `initial`
      SUDAH Verdict-based, tapi idempotency actor-login masih gap terpisah
      (jangan klaim itu juga fixed — itu di luar scope ticket ini)
- [ ] Catat idempotency actor-login gap sebagai ticket terpisah di
      `open-items.md` (`caf-initiator`, bukan `caf-orchestrator`) kalau
      belum tercatat

## Definition of Done
- Mode `initial` Verdict-based, sepenuhnya setara kontrak `/caf-review`
  kecuali idempotency cross-detection (eksplisit out of scope)
- Mode `scoped`/`global` tidak berubah sama sekali
- Self-review 422 auto-fallback ke COMMENT sesuai keputusan
- Semua test pass, termasuk regression
- Tidak ada perubahan ke `caf-reviewer`/`caf-initiator` selain catatan
  dokumentasi di Task 6