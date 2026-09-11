# Tasks: CAF-RESUMEBRANCH-01

## Task 1 — Investigasi (wajib sebelum implement)

- [ ] Temukan file resume handler persis — grep `git reset` dan/atau
      `linear-retry` di `caf-orchestrator` untuk lokasi jalur resume (dugaan:
      modul terpisah dari `run-agent-pipeline.use-case.ts`, kemungkinan terkait
      `maxOrchestrationRetries` / persistent retry state yang sudah LIVE)
- [ ] Konfirmasi: apakah jalur resume ini SATU fungsi yang dipakai baik untuk
      retry wajar (branch masih hidup) maupun retry pasca-selesai (branch sudah
      hilang), atau dua jalur terpisah?
- [ ] Baca bagaimana job state disimpan (SQLite/BullMQ) — field apa yang dipakai
      untuk memutuskan "ini retry, bukan first-run"

## Task 2 — `coderiumid/caf-orchestrator`

- [ ] Tambah pengecekan eksistensi branch remote sebelum `git reset` (mis.
      `git ls-remote --exit-code origin ai-agent/{TICKET-ID}` atau `git fetch`
      lalu cek ref) di titik yang ditemukan Task 1
- [ ] Kalau branch tidak ditemukan: hentikan pipeline, JANGAN lanjut sebagai
      fresh checkout otomatis (sesuai governance no-auto-clear)
- [ ] Ganti pesan error jadi actionable — kirim ke Telegram: ticket ID, dugaan
      penyebab ("branch tidak ditemukan, kemungkinan ticket sudah selesai &
      di-merge"), saran tindakan ("cek status di Linear sebelum retrigger")
- [ ] Pastikan job di BullMQ diberi status final yang jelas (failed + reason),
      tidak retry otomatis berulang ke error yang sama
- [ ] Unit test: branch ada → jalur lama tidak berubah; branch tidak ada →
      stop dengan pesan jelas, tidak fresh-checkout diam-diam
- [ ] Regression test: retry wajar (branch masih hidup, pipeline sebelumnya
      NEEDS_HUMAN) tetap bekerja seperti sebelumnya

## Task 3 — Verifikasi real (opsional, tergantung availability)

- [ ] Kalau memungkinkan tanpa biaya token besar: simulasikan ulang skenario
      (retrigger ticket yang branch-nya sudah dihapus) di environment test/
      staging untuk konfirmasi pesan Telegram baru muncul dengan benar