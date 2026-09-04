# Ticket: CAF-ORCH-PRREVIEW-01 — `caf-pr-review` Agent (Priority C)

## Latar Belakang
Backlog `caf-orchestrator` disepakati urutan Priority A (multi-repo) → B
(dashboard monitoring) → C (ticket ini). **Priority A dan B belum
dikerjakan** — ticket ini eksplisit melompat ke C atas permintaan user,
bukan karena A/B sudah selesai. Perlu diperhatikan: kalau nanti Priority A
(multi-repo + `repoId` di job data) dikerjakan setelah ini, `caf-pr-review`
kemungkinan perlu direvisit untuk ikut repo-scoped seperti use case lain.

**Konteks yang sudah ada (jangan dibangun ulang):**
- `/caf-review` dan `/caf-fix-review` — command interaktif lewat
  `caf-initiator`, sudah `SUCCESS`, dites end-to-end (`CAF-PRREVIEW-01`).
  Postingnya sebagai GitHub PR Review object (`POST pulls/{n}/reviews`).
  Share review engine yang sama dengan `caf-reviewer`.
- `RunPrReviewUseCase` di `caf-orchestrator` — jalur webhook YANG SUDAH ADA,
  tapi posting sebagai issue comment biasa (kontrak beda dari command
  interaktif). Ini gap lama yang tercatat di `open-items.md` ("align
  webhook vs interactive artifact contract").

**Yang diminta di ticket ini:** agent/pipeline BARU, `caf-pr-review`,
lifecycle terpisah dari `caf-reviewer` (yang jalan pra-PR di pipeline
Klaster 2 Delivery). `caf-pr-review` jalan PASCA-PR dibuka, merespons
komentar manusia di GitHub via webhook.

## Spesifikasi (dari kesepakatan sebelumnya)
- **Trigger:** event `issue_comment` di GitHub
- **Resolusi ticket:** derive `TICKET-ID` dari nama branch PR
  (`ai-agent/{TICKET-ID}`), baca artifact dari `.caf/tasks/{TICKET-ID}/`
- **Output:** GitHub PR Review object (`POST pulls/{n}/reviews`) — BUKAN
  issue comment biasa. Ini sekaligus jadi kesempatan menutup gap kontrak
  lama (lihat STOP item #2)
- **Scoping `/caf-fix-review`-equivalent di jalur webhook:**
  - Reply di thread review spesifik → scoped ke comment itu saja
  - Komentar umum (bukan reply ke thread) → scope global, semua item
    outstanding
- **Review engine:** WAJIB share logic/kriteria yang sama dengan
  `caf-reviewer` — TIDAK ada logic penilaian terpisah, mencegah kriteria
  review pra-PR dan pasca-PR saling drift

## Keputusan Final (dikonfirmasi user, 2026-09-04)
1. **Whitelist trigger:** collaborator-only. Non-collaborator comment di PR
   TIDAK memicu `caf-pr-review` sama sekali.
2. **Gap kontrak webhook vs interactive:** DITUTUP di ticket ini.
   `RunPrReviewUseCase`/jalur webhook lama diselaraskan supaya sama-sama
   posting sebagai GitHub PR Review object — bukan 2 kontrak berbeda yang
   dipertahankan paralel.
3. **Arsitektur share review engine:** `caf-reviewer` di-refactor jadi
   reusable sebagai sub-agent, dipanggil dari 2 entry point (pipeline
   Klaster 2 Delivery pra-PR, DAN `caf-pr-review` pasca-PR). BUKAN
   `caf-pr-review` menduplikasi logic secara terpisah.

## Pertanyaan Terbuka (STOP items — SUDAH TERJAWAB, lihat "Keputusan Final")

1. **Whitelist siapa yang boleh trigger** — sudah eksplisit ditandai belum
   diputuskan sejak awal (`TBD` di catatan project). Opsi: collaborator-only
   (lebih ketat) vs siapa saja yang bisa comment di PR (lebih longgar, tapi
   berisiko trigger dari orang luar/bot). **Wajib dijawab sebelum
   implementasi dimulai** — ini bukan detail teknis, ini keputusan
   keamanan/akses.
2. **Apakah ticket ini juga menutup gap "align webhook vs interactive
   contract"** — karena `caf-pr-review` baru ini output-nya PR Review object
   (sama seperti interactive), sementara `RunPrReviewUseCase` (jalur
   `/caf-fix-review`-equivalent existing) masih posting issue comment. Opsi:
   (a) `caf-pr-review` baru ini sekalian menggantikan/menyelaraskan
   `RunPrReviewUseCase` supaya satu kontrak konsisten, atau (b) `caf-pr-review`
   dibangun terpisah dulu, alignment `RunPrReviewUseCase` tetap jadi item
   `open-items.md` yang terpisah. Rekomendasi: (a), karena membangun agent
   baru dengan kontrak berbeda dari use case existing yang serupa akan
   menambah inkonsistensi baru, bukan menutupnya — tapi ini keputusan user.
3. **Bagaimana "share review engine dengan `caf-reviewer`" diimplementasikan
   secara teknis** — apakah `caf-reviewer` direfactor supaya logic
   review-nya reusable (dipanggil dari 2 entry point: pipeline Klaster 2 DAN
   `caf-pr-review`), atau `caf-pr-review` invoke `caf-reviewer` sebagai
   sub-langkah? Ini keputusan arsitektur yang mempengaruhi seberapa besar
   refactor terhadap `caf-reviewer` yang sudah stabil — perlu dibahas di
   Task 1 (investigasi), bukan diasumsikan sebelum lihat kode aktual.

## Acceptance Criteria
- [ ] Webhook `issue_comment` di-handle, `TICKET-ID` di-resolve benar dari
      nama branch PR
- [ ] Scoping (reply-di-thread vs komentar-umum) bekerja sesuai spesifikasi
- [ ] Output PR Review object, bukan issue comment (menyelesaikan STOP #2
      sesuai keputusan yang diambil)
- [ ] Kriteria review terbukti identik dengan `caf-reviewer` — dibuktikan
      lewat test yang membandingkan, bukan diasumsikan sama karena "pakai
      kode yang sama"
- [ ] Whitelist trigger diterapkan sesuai keputusan STOP #1
- [ ] Regression: pipeline Klaster 2 Delivery (`caf-reviewer` di jalur
      pra-PR) TIDAK terpengaruh sama sekali oleh perubahan ini
- [ ] `/caf-review`/`/caf-fix-review` interaktif (`caf-initiator`) TIDAK
      terpengaruh — ticket ini murni di `caf-orchestrator`

## Eksplisit Out of Scope
- Priority A (multi-repo) dan Priority B (dashboard monitoring) — urutan asli
  dilompati atas permintaan user, TIDAK dikerjakan di sini
- Perubahan ke `caf-initiator`/command interaktif `/caf-review`/`/caf-fix-review`
- Fix `TRIGGERED_BY_LINE` regex (bug laten lama, prioritas rendah, tidak
  terkait)