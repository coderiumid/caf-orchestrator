# Ticket: CAF-ORCH-PRREVIEW-03 — Verdict-Based Review untuk Webhook Mode `initial`

> Menggantikan `CAF-ORCH-PRREVIEW-02` (STOPPED setelah Task 1 — premis
> "1 titik output" terbukti salah, gap sebenarnya di kontrak subagent).
> Ticket ini dibuat dengan scope yang sudah mencerminkan temuan itu.

## Latar Belakang
`RunPrReviewUseCase` mode `initial` (dipicu `/caf-review` lewat webhook)
saat ini menjalankan `caf-reviewer` dalam mode fix-review-log
(comment-response), BUKAN mode INITIAL yang sesungguhnya — akibatnya tidak
ada `Verdict` yang dihasilkan, dan output-nya diposting sebagai issue
comment biasa (bukan GitHub PR Review object).

Counterpart interaktifnya, `/caf-review` (`caf-initiator`,
`review-command.js`), menjalankan `caf-reviewer` mode INITIAL sungguhan —
subagent menulis `review-notes.md` (Verdict: APPROVE/CHANGES
REQUESTED/DEFER, + Security Audit + Qualitative Review), main thread
memetakan Verdict ke GitHub review `event` (APPROVE→APPROVE, CHANGES
REQUESTED→REQUEST_CHANGES, DEFER→COMMENT), lalu `POST pulls/{number}/reviews`.

Tujuan ticket ini: webhook mode `initial` menjalankan kontrak yang SAMA
(Verdict-producing), bukan cuma pindah endpoint posting dengan Verdict
palsu/default.

## Keputusan Final (dikonfirmasi user, 2026-09-04)
Self-review 422 → **Opsi 1: auto-fallback ke `COMMENT`.** Kalau GitHub API
menolak self-approve/self-request-changes, otomatis post sebagai
`event: COMMENT`, dengan Verdict asli dinyatakan eksplisit di body pesan
(mis. "Verdict: CHANGES REQUESTED (posted as COMMENT — GitHub does not
allow self-review approval/rejection)"). Tidak ada langkah interaktif,
tidak ada opsi lain ditawarkan — ini keputusan otomatis untuk konteks
webhook yang tidak punya manusia untuk ditanya saat itu.

## Pertanyaan Terbuka (STOP item — SUDAH TERJAWAB, lihat "Keputusan Final")

**Self-review 422 degradation.** `/caf-review` interaktif (`review-command.js`)
menangani kasus GitHub API menolak self-approve/self-request-changes (422)
dengan STOP dan menawarkan pilihan eksplisit ke user yang sedang menjalankan
command (fallback: post sebagai COMMENT dengan verdict dinyatakan eksplisit
di body, atau batalkan). Di webhook, **tidak ada manusia interaktif untuk
ditanya** saat itu juga — orchestrator jalan otomatis dari trigger GitHub
event.

Pilihan untuk konteks non-interaktif (pilih salah satu, atau usulkan
lain):
1. **Auto-fallback ke COMMENT** — kalau 422 terjadi (Verdict aslinya
   APPROVE/CHANGES REQUESTED tapi API menolak karena bot mereview PR-nya
   sendiri), otomatis post sebagai `event: COMMENT` dengan Verdict asli
   dinyatakan eksplisit di body pesan (mis. "Verdict: CHANGES REQUESTED
   (posted as COMMENT — GitHub does not allow self-review approval/rejection)").
   Konsisten dengan salah satu opsi yang ditawarkan versi interaktif, tapi
   dipilih otomatis tanpa nanya.
2. **Stop pipeline, tulis `NEEDS_HUMAN`-style status** — treat 422 sebagai
   kondisi yang butuh manusia, post comment biasa menjelaskan situasinya,
   JANGAN post PR Review object sama sekali, tunggu manusia trigger ulang
   atau tangani manual.
3. Opsi lain yang menurut kamu lebih sesuai.

**Rekomendasi saya: Opsi 1** — karena Opsi 2 berarti webhook mode `initial`
efektif nggak pernah bisa selesai otomatis kapan pun bot-nya review PR
sendiri (skenario yang mungkin cukup umum tergantung siapa yang buka PR),
dan Verdict asli tetap tersampaikan di body (nggak hilang informasinya).
Tapi ini keputusan produk, bukan yang saya putuskan sendiri.

## Apa yang Diminta
1. Webhook mode `initial` — `buildReviewerPrompt()` (atau fungsi setara)
   bercabang: mode `initial` pakai prompt INITIAL sungguhan (sama seperti
   `/caf-review`), mode `scoped`/`global` TETAP fix-review-log seperti
   sekarang
2. Reader baru untuk `review-notes.md` (Verdict, Security Audit,
   Qualitative Review) — setara `readFixReviewLog()` yang sudah ada untuk
   fix-review-log, tapi untuk format review-notes
3. Verdict → GitHub review `event` mapping, identik dengan
   `review-command.js`
4. `createPullRequestReview` di `IVcsClient`/`GithubService`
5. Self-review 422 handling sesuai keputusan STOP item di atas

## Acceptance Criteria
- [ ] Mode `initial` menjalankan `caf-reviewer` mode INITIAL sungguhan,
      dibuktikan lewat prompt yang dikirim ke subagent (bukan cuma output
      akhirnya)
- [ ] `review-notes.md` terbaca benar, Verdict ter-ekstrak
- [ ] Verdict dipetakan ke `event` PERSIS sama seperti `review-command.js`
      (APPROVE/CHANGES REQUESTED/DEFER → APPROVE/REQUEST_CHANGES/COMMENT)
- [ ] PR Review object terposting via `POST pulls/{number}/reviews`
- [ ] 422 self-review ditangani sesuai keputusan STOP item, TIDAK crash/
      pipeline mati diam-diam
- [ ] Mode `scoped`/`global` TIDAK berubah sama sekali — regression test
      eksplisit
- [ ] `NEEDS_HUMAN`-style handling: kalau Verdict tidak dikenali/tidak ada
      (subagent gagal menghasilkan Verdict valid) — treat sama seperti
      `review-command.js` menangani itu (STOP, jangan asumsi default)

## Eksplisit Out of Scope
- Idempotency cross-detection (actor-login mismatch antara webhook dan
  `/caf-review`) — gap terpisah, perbaikannya di `caf-initiator`
  (`review-command.js`), BUKAN di ticket/repo ini. Ticket terpisah.
- Priority A/B (multi-repo, dashboard)
- Mode `scoped`/`global` — tidak ada gap, tidak disentuh
- `caf-reviewer` agent definition sendiri — TIDAK diubah, cuma cara
  orchestrator memanggilnya (prompt mode) yang berubah