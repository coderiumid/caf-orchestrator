# Design: CAF-ORCH-PRREVIEW-01 — `caf-pr-review` Agent

## Pendekatan Umum
Ini scope besar dengan 3 sub-perubahan yang saling bergantung tapi punya
risiko berbeda:

1. **Refactor `caf-reviewer` jadi reusable** (risiko tertinggi — nyentuh
   kode yang sudah stabil dan dipakai pipeline Klaster 2 setiap ticket)
2. **`caf-pr-review` agent baru** (risiko sedang — kode baru, tapi
   bergantung pada #1)
3. **Alignment `RunPrReviewUseCase`** ke kontrak PR Review object (risiko
   sedang — mengubah use case existing)

**Urutan wajib: #1 dulu, verifikasi tidak ada regresi ke pipeline Klaster 2
existing, BARU lanjut #2 dan #3.** Jangan kerjakan paralel — kalau #1
ternyata lebih rumit dari dugaan, itu perlu ketahuan sebelum #2/#3 dibangun
di atas asumsi yang salah.

## Sub-bagian 1 — Refactor `caf-reviewer`

Tujuan: logic penilaian (kriteria review, cara baca `verify-report.md`/
`qa-report.md`, cara menghasilkan `review-notes.md`) jadi fungsi/module yang
bisa dipanggil dari 2 context berbeda:
- **Context lama (pra-PR):** dipanggil sebagai bagian pipeline Klaster 2,
  baca artifact dari `.caf/tasks/{TICKET-ID}/`, tulis `review-notes.md` ke
  folder yang sama
- **Context baru (pasca-PR, dari `caf-pr-review`):** dipanggil dari webhook
  `issue_comment`, perlu baca PR diff yang sebenarnya (bukan cuma artifact
  lokal) DAN comment thread yang memicu, output-nya PR Review object bukan
  file markdown

**Perlu diinvestigasi di Task 1** (bukan diasumsikan): seberapa besar
perbedaan input/output antara 2 context ini. Kalau ternyata core logic
penilaian (apa yang dicek, kriteria pass/fail) itu sama tapi cara ambil
input dan cara kirim output beda total, refactor yang tepat adalah
memisahkan "assessment logic" (reusable) dari "I/O adapter" (berbeda per
context) — bukan mencoba membuat satu fungsi monolitik yang menangani kedua
context sekaligus.

## Sub-bagian 2 — `caf-pr-review` Agent

```
GitHub webhook (issue_comment)
  -> verifikasi signature
  -> cek: comment author collaborator? (STOP #1 - kalau bukan, ABAIKAN
     event, tidak ada respons apapun, tidak ada log yang bocor ke non-collaborator)
  -> derive TICKET-ID dari branch PR (ai-agent/{TICKET-ID})
  -> baca .caf/tasks/{TICKET-ID}/
  -> tentukan scope:
       reply di review thread -> scoped ke comment itu
       comment umum -> scope global, semua outstanding items
  -> panggil assessment logic dari caf-reviewer (Sub-bagian 1)
  -> post sebagai PR Review object (POST pulls/{n}/reviews)
```

**Idempotency**: pertimbangkan apakah perlu cek run sebelumnya (mirip pola
idempotency di `/caf-review` interaktif, §0.7 di dokumentasi lama) supaya
comment yang trigger dobel tidak menghasilkan review dobel. Investigasi di
Task 1 apakah pola itu bisa dipakai ulang atau perlu didesain baru untuk
konteks webhook.

## Sub-bagian 3 — Alignment `RunPrReviewUseCase`

Setelah Sub-bagian 1 & 2 selesai dan stabil, `RunPrReviewUseCase` (jalur
webhook lama yang posting issue comment) diselaraskan untuk memakai
mekanisme yang sama (assessment logic dari Sub-bagian 1, output PR Review
object). Kemungkinan hasil akhirnya: `RunPrReviewUseCase` dan
`caf-pr-review` yang baru menyatu jadi satu jalur, bukan 2 use case paralel
yang kebetulan mirip — tapi ini perlu dikonfirmasi user di Task 1
checkpoint, bukan diasumsikan.

## Testing Strategy
- Regression pipeline Klaster 2: jalankan ticket end-to-end (real repo,
  sesuai prinsip "fixture passing ≠ safe" yang sudah dipegang project ini)
  — `caf-reviewer` pasca-refactor menghasilkan `review-notes.md` yang
  identik/setara dengan sebelum refactor
- Test kriteria review identik: buat 1 PR/ticket fixture, jalankan lewat
  jalur pra-PR (`caf-reviewer` lama) dan pasca-PR (`caf-pr-review` baru),
  bandingkan hasil penilaiannya — harus konsisten untuk kriteria yang sama
- Test whitelist: comment dari non-collaborator -> tidak ada aksi apapun,
  dibuktikan lewat assertion "no API call dibuat", bukan cuma "tidak error"
- Test scoping: reply-di-thread vs comment-umum menghasilkan scope yang
  berbeda sesuai spesifikasi
- Integration test real GitHub API (sandbox/test repo) untuk output format
  PR Review object — pastikan bukan issue comment