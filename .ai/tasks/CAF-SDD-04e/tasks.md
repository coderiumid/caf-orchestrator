# CAF-SDD-04e — Tasks

Eksekusi di `caf-orchestrator`. Hanya commit lokal. Jangan push, jangan merge. Berkas tiket ada di `.ai/tasks/CAF-SDD-04e/` (di orchestrator `.ai/tasks/` di-track git); pakai apa adanya.

## Frontend Tasks
(none)

## Backend Tasks
- T1 (baca dulu, sebelum menyentuh `src/`): pastikan HEAD adalah `main` terbaru (8b2c892 atau lebih baru, termasuk 04d) dan buat branch `ai-agent/CAF-SDD-04e` dari situ. Verifikasi Findings F-1..F-6 dan Assumptions A-1..A-3 terhadap kode. STOP dan laporkan bila ada temuan yang bertentangan dengan sebuah AC. Catat deviasi bentuk di `verify-report.md`.
  - Tulis lebih dulu test AC-1 dan AC-2 dan pastikan keduanya GAGAL di kode lama (bukti bug), baru ubah `report-reader.ts`.
- T2 (AC-1..AC-4): di `readFixReviewLog` terapkan D-1..D-3: baris `## ` memutus entri hanya bila `current?.status` sudah ada dan baris itu di luar pagar; lacak pagar dengan baris berawalan tiga backtick; reset pagar di tiap header `### Comment`. Tidak ada perubahan lain.
- T3 (AC-1..AC-5): tulis `tests/unit/report-reader.sdd04e.test.ts` sesuai `Verify:`. Jangan mengubah test lama.
- T4 (AC-7): ubah satu paragraf parsing `fix-review-log.md` di `CLAUDE.md` (baris yang menyebut `## Proposed Spec Changes`, pembaca `readFixReviewLog`) sesuai AC-7. Tidak ada perubahan di README.
- T5 (AC-6): jalankan `pnpm typecheck && pnpm lint && pnpm test`. Tulis `verify-report.md` di `.ai/tasks/CAF-SDD-04e/` dengan baris `Status:` polos (`SUCCESS` atau `NEEDS_HUMAN`), tabel per AC (id | status | metode | bukti), dan bagian `### Notes` (deviasi, bukti test AC-1/AC-2 gagal sebelum perubahan, usulan perubahan spec di baris `Proposed Spec Changes:`).

## Docs Tasks
(none)

## Skip Agents
(none)

## Coverage
- AC-1: T1, T2, T3
- AC-2: T1, T2, T3
- AC-3: T2, T3
- AC-4: T2, T3
- AC-5: T3
- AC-6: T5
- AC-7: T4