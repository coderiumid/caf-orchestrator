# Tasks: CAF-ORCH-PRREVIEW-02

## Task 1 — Investigasi Interface & Titik Integrasi
- [ ] Baca `IVcsClient` (atau nama interface yang sesuai) — cek method yang
      sudah ada untuk komunikasi ke GitHub, tentukan cara paling konsisten
      menambah PR Review object (method baru vs extend yang ada)
- [ ] Baca implementasi konkret GitHub client (yang implement `IVcsClient`)
      — cek pola auth/permission yang dipakai method lain, ikuti pola yang
      sama untuk method baru
- [ ] Baca titik di `RunPrReviewUseCase` mode `initial` yang saat ini
      manggil issue-comment/reply-comment — pastikan HANYA titik ini yang
      diganti, mode lain tidak tersentuh
- [ ] Laporkan temuan sebelum lanjut Task 2 kalau ada kompleksitas tak
      terduga (mis. auth token yang dipakai `IVcsClient` sekarang ternyata
      tidak punya scope yang cukup untuk create PR Review — itu perlu
      diketahui sebelum implementasi, bukan ditemukan pas testing)

## Task 2 — Implementasi
- [ ] Tambah method create PR Review object di `IVcsClient` + implementasi
      konkretnya (`POST pulls/{number}/reviews`)
- [ ] Ubah mode `initial` `RunPrReviewUseCase` memakai method baru ini
- [ ] Mode `scoped`/`global` — TIDAK disentuh, verifikasi lewat diff review
      manual bahwa kode jalur itu tidak ikut berubah

## Task 3 — Idempotency Cross-Detection
- [ ] Skenario test: review lewat `/caf-review` interaktif dulu (hasilnya
      PR Review object via `GET pulls/{number}/reviews`), lalu webhook mode
      `initial` trigger untuk PR yang sama — apakah sekarang terdeteksi
      sebagai sudah pernah direview (tidak double-post)?
- [ ] Skenario sebaliknya: webhook mode `initial` duluan, baru
      `/caf-review` interaktif dicoba — apakah idempotency check di
      `review-command.js` sekarang menemukan review dari webhook?
- [ ] Laporkan hasil APA ADANYA — kalau ternyata masih ada gap (mis. beda
      author/actor yang dipakai buat matching, atau field lain yang belum
      selaras), catat sebagai temuan, jangan dipaksa "sudah fixed"

## Task 4 — Test
- [ ] Regression: mode `scoped`/`global` byte-for-byte tidak berubah
      behaviornya (test existing harus tetap pass tanpa modifikasi)
- [ ] Test baru: mode `initial` menghasilkan PR Review object terverifikasi
      (integration test terhadap GitHub API sandbox, atau minimal assert
      request yang dikirim ke endpoint yang benar dengan payload yang benar)
- [ ] Test idempotency cross-detection sesuai Task 3

## Task 5 — Dokumentasi
- [ ] Update `review-command.js` baris 326-330 sesuai hasil Task 3
- [ ] Update `open-items.md` — item "align webhook vs interactive contract"
      ditutup (atau direvisi kalau Task 3 menemukan gap tersisa)
- [ ] Catat pembatalan `CAF-ORCH-PRREVIEW-01` di riwayat/README ticket kalau
      ada tempat mencatatnya, supaya tidak ada yang bingung nanti kenapa ada
      2 nomor ticket untuk hal yang kelihatannya sama

## Definition of Done
- Mode `initial` posting PR Review object, terverifikasi
- Mode `scoped`/`global` tidak berubah
- Idempotency cross-detection diverifikasi dan dilaporkan apa adanya (fixed
  atau masih ada nuansa gap)
- Tidak ada perubahan ke `caf-initiator`/`caf-reviewer`