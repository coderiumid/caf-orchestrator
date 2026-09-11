# Ticket: CAF-RESUMEBRANCH-01

## Judul
Resume handler gagal saat branch retry sudah tidak ada di remote (persistent retry mode)

## Problem

Re-trigger ticket yang sudah selesai (PR sudah merge, branch `ai-agent/{TICKET-ID}`
sudah ke-delete otomatis oleh GitHub) menyebabkan pipeline gagal dengan raw git
error, bukan ditangani secara graceful.

Ditemukan saat retrigger GAN-137 (`umkm-pos`) secara manual/iseng untuk testing.
Job masuk sebagai `linear-retry-*` (persistent retry state), lalu gagal:

```
⚠️ git reset failed (128): fatal: ambiguous argument
'origin/ai-agent/GAN-137': unknown revision or path not in the working tree.
```

## Root Cause (dugaan awal, perlu dikonfirmasi di kode)

Resume handler di `caf-orchestrator` mempercayai state job lama (tersimpan di
SQLite/BullMQ dari fitur persistent retry state) tanpa verifikasi ulang kondisi
git yang sebenarnya. Ia mengasumsikan branch `ai-agent/{TICKET-ID}` masih ada di
remote dan langsung `git reset` ke situ, tanpa mengecek eksistensinya lebih dulu.
Kalau branch sudah tidak ada (kemungkinan besar karena ticket sudah selesai &
di-merge, GitHub auto-delete head branch), reset gagal dengan git error mentah,
bukan pesan yang bisa ditindaklanjuti manusia.

Pola bug ini serupa (walau beda titik) dengan `CAF-QAREPORT-01`: retry/resume
logic yang mengasumsikan state lama = state sekarang, tanpa verifikasi ulang.

## Acceptance Criteria

- [ ] Sebelum `git reset` ke `origin/ai-agent/{TICKET-ID}` di jalur resume, ada
      pengecekan eksistensi branch remote terlebih dahulu
- [ ] Kalau branch tidak ditemukan: pipeline **berhenti**, bukan lanjut sebagai
      fresh run diam-diam (sesuai governance "no auto-clear, no force-overwrite
      without an explicit decision")
- [ ] Notifikasi Telegram yang dikirim jelas dan actionable — bukan raw git error
      — mis. "branch sudah tidak ada, kemungkinan ticket ini sudah selesai
      sebelumnya, cek status di Linear sebelum retrigger"
- [ ] Job di BullMQ diberi status final yang sesuai (failed dengan alasan jelas),
      bukan menggantung atau retry otomatis berulang ke error yang sama
- [ ] Ada unit test untuk kasus: branch remote ada (jalur normal, tidak berubah)
      dan branch remote tidak ada (jalur baru, harus stop dengan pesan jelas)
- [ ] Regression check: jalur resume untuk retry yang branch-nya memang masih
      hidup (skenario retry wajar, mis. pipeline sebelumnya NEEDS_HUMAN dan belum
      di-merge) tetap bekerja seperti sebelumnya

## Affected Repo & File

| Repo | File | Perubahan |
|---|---|---|
| `coderiumid/caf-orchestrator` | resume handler (lokasi persis perlu dikonfirmasi — kemungkinan modul terpisah dari `run-agent-pipeline.use-case.ts`, terkait fitur persistent retry state) | tambah pengecekan eksistensi branch remote sebelum `git reset`; ganti raw git error jadi pesan actionable |

## Out of Scope

- Perubahan pada `run-agent-pipeline.use-case.ts` jalur first-run (tidak
  terdampak — first-run selalu checkout baru dari `main`, tidak lewat resume
  handler)
- Auto-resume otomatis sebagai fresh run tanpa konfirmasi manusia — bertentangan
  dengan governance no-auto-clear