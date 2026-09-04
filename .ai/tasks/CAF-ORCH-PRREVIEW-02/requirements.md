# Ticket: CAF-ORCH-PRREVIEW-02 — Selaraskan Mode `initial` ke PR Review Object

> Menggantikan `CAF-ORCH-PRREVIEW-01` sepenuhnya — ticket itu dibatalkan
> setelah investigasi Task 1 menemukan premisnya salah (lihat riwayat
> percakapan 2026-09-04). `caf-pr-review`/refactor `caf-reviewer` TIDAK
> perlu dibangun — itu semua sudah ada lewat `RunPrReviewUseCase`
> (`CAF-PRREVIEW-01`, sudah `SUCCESS`).

## Latar Belakang
Investigasi menemukan `RunPrReviewUseCase` sudah mengimplementasikan hampir
semua yang diminta ticket sebelumnya: whitelist collaborator-only
(`checkReviewPermission()`), derive `TICKET-ID` dari branch
(`extractTicketKey()`), scoping 3 mode (`initial`/`scoped`/`global`), share
assessment logic dengan `caf-reviewer` (manggil agent yang sama persis),
idempotency (`claimDelivery`).

**Gap nyata yang ditemukan** (bukan yang diasumsikan sebelumnya): mode
`initial` di `RunPrReviewUseCase` posting sebagai issue comment/reply
comment, sementara counterpart interaktifnya — `/caf-review` mode INITIAL
(`caf-initiator`, `src/templates/review-command.js`) — posting sebagai
**GitHub PR Review object** (`POST pulls/{number}/reviews`). Dua kontrak
artifact berbeda untuk skenario yang sama.

`review-command.js` sendiri sudah mendokumentasikan konsekuensi gap ini
(baris 326-330): idempotency check `/caf-review` (`GET pulls/{number}/reviews`)
tidak akan pernah menemukan review yang diposting lewat jalur webhook,
karena beda kontrak artifact.

**Mode `scoped`/`global`** (setara `/caf-fix-review`) TIDAK punya gap — baik
`fix-review-command.js` (interaktif) maupun `RunPrReviewUseCase` mode
`scoped`/`global` sama-sama pakai issue-comment/reply-comment style. Jangan
diubah.

## Apa yang Diminta
1. Mode `initial` di `RunPrReviewUseCase` posting sebagai PR Review object
   (`POST pulls/{number}/reviews`), bukan issue comment/reply comment lagi
2. Verifikasi/perbaiki idempotency check di `review-command.js` — setelah
   kontrak disamakan, cek apakah `GET pulls/{number}/reviews` sekarang bisa
   mendeteksi review yang diposting lewat webhook (dan sebaliknya)

## Acceptance Criteria
- [ ] `IVcsClient` (atau interface setara) punya method untuk create PR
      Review object — cek dulu apakah lebih pas nambah method baru atau ada
      yang bisa direuse
- [ ] Mode `initial` `RunPrReviewUseCase` memakai method itu, output-nya
      terverifikasi PR Review object (bukan comment) — test end-to-end atau
      minimal integration test terhadap GitHub API sandbox
- [ ] Mode `scoped`/`global` TIDAK berubah sama sekali — regression test
      eksplisit membuktikan ini
- [ ] Idempotency cross-detection: setelah fix, jalankan skenario "review
      lewat `/caf-review` interaktif, lalu webhook mode `initial` trigger
      lagi untuk PR yang sama" — verifikasi apakah sekarang saling terdeteksi
      atau masih ada gap lain yang perlu diketahui (laporkan apa adanya,
      jangan asumsi otomatis fixed hanya karena kontrak sudah sama)
- [ ] Update komentar di `review-command.js` (baris 326-330) — hapus/revisi
      catatan gap yang sudah tidak berlaku, atau update kalau ternyata masih
      ada nuansa gap yang tersisa

## Eksplisit Out of Scope
- Semua yang sudah dikonfirmasi ADA di `RunPrReviewUseCase` (whitelist,
  scoping, derive ticket, share assessment logic) — TIDAK disentuh
- `caf-reviewer` — TIDAK direfactor, sudah reusable
- Priority A/B (multi-repo, dashboard) — tetap di luar scope
- `/caf-fix-review`/mode `scoped`/`global` — tidak ada gap, tidak disentuh