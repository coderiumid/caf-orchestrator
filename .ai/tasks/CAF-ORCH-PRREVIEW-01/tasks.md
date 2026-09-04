# Tasks: CAF-ORCH-PRREVIEW-01

> 3 STOP item sudah terjawab (lihat `requirements.md`). Task 1 tetap jadi
> checkpoint investigasi wajib sebelum coding — scope ticket ini besar,
> Task 1 menentukan apakah asumsi di `design.md` cocok dengan kode aktual.

## Task 1 — Investigasi & Checkpoint (WAJIB sebelum coding apapun)
- [ ] Baca `caf-reviewer` (definisi agent + kode use case yang menjalankannya
      di pipeline Klaster 2) — petakan persis apa yang jadi "assessment
      logic" vs "I/O" saat ini
- [ ] Baca `RunPrReviewUseCase` — petakan kontrak inputnya (webhook payload)
      dan outputnya (issue comment) saat ini
- [ ] Cek pola idempotency `/caf-review` interaktif (`§0.7` di dokumentasi
      lama `caf-initiator`) — apakah reusable untuk konteks webhook
- [ ] Estimasi ulang scope refactor Sub-bagian 1 — apakah "pisahkan
      assessment logic dari I/O adapter" itu perubahan kecil atau perlu
      restrukturisasi besar. **Laporkan ke user sebelum lanjut** — kalau
      ternyata jauh lebih besar dari dugaan, ticket ini mungkin perlu
      dipecah jadi beberapa ticket berurutan (refactor dulu sebagai ticket
      sendiri, baru agent baru di ticket berikutnya)
- [ ] Konfirmasi ulang STOP #2 (`RunPrReviewUseCase` menyatu dengan
      `caf-pr-review`) — apakah ini feasible secara teknis berdasarkan kode
      aktual, atau ada kendala yang belum kepikiran waktu requirements
      ditulis

## Task 2 — Refactor `caf-reviewer` (Sub-bagian 1)
- [ ] Pisahkan assessment logic jadi module/fungsi reusable
- [ ] Context lama (pra-PR) tetap manggil lewat jalur yang sama seperti
      sekarang, TIDAK ADA perubahan behavior yang terlihat dari luar
- [ ] **Checkpoint wajib**: jalankan 1 ticket end-to-end (real repo) lewat
      pipeline Klaster 2 pasca-refactor, bandingkan `review-notes.md`
      dengan hasil sebelum refactor — tunjukkan ke user, tunggu konfirmasi
      SEBELUM lanjut Task 3

## Task 3 — `caf-pr-review` Agent Baru
- [ ] Webhook handler `issue_comment` — signature verification, whitelist
      collaborator-only (STOP #1)
- [ ] Derive `TICKET-ID` dari branch PR
- [ ] Scoping logic (reply-di-thread vs comment-umum)
- [ ] Panggil assessment logic dari Task 2
- [ ] Post sebagai PR Review object
- [ ] Idempotency (sesuai temuan Task 1)

## Task 4 — Alignment `RunPrReviewUseCase` (Sub-bagian 3)
- [ ] Sesuai keputusan Task 1 checkpoint (menyatu penuh, atau diselaraskan
      tapi tetap use case terpisah)
- [ ] Pastikan tidak ada regresi ke behavior existing yang masih dipakai

## Task 5 — Test
- [ ] Regression pipeline Klaster 2 end-to-end (real repo)
- [ ] Kriteria review identik pra-PR vs pasca-PR (test pembanding)
- [ ] Whitelist: non-collaborator comment → no-op, dibuktikan no API call
- [ ] Scoping: reply-di-thread vs comment-umum
- [ ] Output format: PR Review object, bukan issue comment (test untuk
      `caf-pr-review` DAN `RunPrReviewUseCase` pasca-alignment)

## Task 6 — Dokumentasi
- [ ] Update `open-items.md` — tandai "align webhook vs interactive
      contract" selesai, referensi ticket ini
- [ ] Update dokumentasi arsitektur `caf-orchestrator` (kalau ada) —
      `caf-pr-review` sebagai lifecycle terpisah dari `caf-reviewer`, tapi
      berbagi assessment logic

## Definition of Done
- `caf-reviewer` reusable, pipeline Klaster 2 tidak regresi (dibuktikan
  end-to-end real repo)
- `caf-pr-review` bekerja sesuai spesifikasi (trigger, scoping, whitelist,
  output format)
- `RunPrReviewUseCase` diselaraskan (sesuai keputusan Task 1)
- Kriteria review terbukti identik lintas 2 entry point
- Tidak ada perubahan ke `caf-initiator`