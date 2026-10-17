# CAF-SDD-04e — `readFixReviewLog` tidak lagi kehilangan entri karena baris `## ` di kutipan

Status: APPROVED
Repo: caf-orchestrator (main 8b2c892, setelah merge 04d)

## Outcomes
- Sebuah entri `### Comment ...` di `fix-review-log.md` tetap terbaca lengkap (status dan catatan) ketika kutipan komentar asli atau catatannya memuat baris berawalan `## `.
- Perilaku 04b tetap: bagian `## Proposed Spec Changes` setelah entri terakhir tidak masuk ke catatan entri itu.
- Tidak ada perubahan lain di orchestrator.

## Scope
In:
- `readFixReviewLog` di `src/infrastructure/reports/report-reader.ts` (aturan baris `## `).
- Test baru, `CLAUDE.md` (satu kalimat).

Out:
- Format `fix-review-log.md` dan prompt fix-review (`fix-review-command.js` di caf-initiator tidak berubah).
- `readVerdict`, `ac-summary.ts`, parser lain.
- Tempat usulan spec reviewer (item lintas-repo terpisah).

## Findings (dari kode, main 8b2c892)
- F-1: `readFixReviewLog` memproses `fix-review-log.md` per baris. Setiap baris yang cocok `/^##\s/` memanggil `flush()` lalu mengosongkan `current` (CAF-SDD-04b, agar `## Proposed Spec Changes` tidak masuk ke catatan terakhir).
- F-2: `flush()` hanya menambah entri bila `commentRef`, `label`, dan `status` ada. Entri yang `current`-nya hilang sebelum baris `Status:` terbaca tidak pernah ditambahkan.
- F-3: Format yang diminta dari agent (`fix-review-command.js`): header `### Comment {id} [...]`, lalu `> {kutipan komentar asli}`, lalu `Status:`, lalu `Notes:`. Kutipan berada sebelum `Status:`. Baris kutipan yang tidak berawalan `>` (kutipan multi-baris yang tidak diawali tanda kutip di tiap baris) yang berisi `## ...` memutus entri: status tidak terbaca dan entri hilang diam-diam; balasan GitHub untuk komentar itu dan hitungan di ringkasan ikut hilang.
- F-4: `###` tidak cocok dengan `/^##\s/` (setelah `##` ada `#`, bukan spasi); hanya heading level 2 yang terdampak.
- F-5: Test 04b (`tests/unit/report-reader.sdd04b.test.ts`) menahan kasus `## Proposed Spec Changes` tepat setelah baris `Notes:` tanpa baris kosong; perilaku itu harus tetap.
- F-6: Pembaca hasil (`run-pr-review.use-case.ts`) memakai `entries` untuk membalas tiap komentar dan menyusun ringkasan; `raw` tidak di-parse.

## Assumptions
- A-1: Tidak ada pembaca lain yang bergantung pada pemutusan entri oleh baris `## ` sebelum `Status:`. Dasar: `readFixReviewLog` hanya dipakai di `run-pr-review.use-case.ts`. T1 memverifikasi dengan `grep`.
- A-2: Agent menulis blok kode berpagar dengan baris yang diawali tiga backtick di awal baris. Dasar: konvensi markdown yang dipakai seluruh artefak. T1 memeriksa test lama dan contoh log untuk bentuk lain.
- A-3: Perubahan ini tidak mengubah hasil untuk log tanpa baris `## ` di dalam blok komentar (kecuali bagian akhir yang memang `## Proposed Spec Changes` atau sejenis). T1 menjalankan test lama sebagai bukti.

## Decisions already made
- D-1: Baris `## ` mengakhiri blok komentar hanya bila entri berjalan sudah punya `Status:` dan baris itu tidak berada di dalam blok kode berpagar (keputusan konsultan; Ganjar boleh mengubah). Sebelum `Status:` terbaca, baris `## ` adalah bagian dari kutipan dan diabaikan; entri tetap terbuka.
- D-2: Setelah `Status:` terbaca, baris `## ` di luar pagar tetap memutus entri, termasuk saat ia tepat mengikuti baris `Notes:` tanpa baris kosong (menjaga 04b, F-5). Catatan yang menyertakan baris `## ` mentah di luar pagar setelah `Status:` tetap terpotong; dicatat sebagai batas yang diketahui.
- D-3: Status pagar di-reset pada setiap header `### Comment ...`, supaya pagar yang tidak tertutup di satu entri tidak memengaruhi entri berikutnya atau `## Proposed Spec Changes` di akhir.
- D-4: Tanpa perubahan format dan tanpa nilai status baru.

## Constraints
- Perubahan hanya di dalam `readFixReviewLog` (dan konstanta regex pagar di sebelahnya). Tidak ada ekspor baru, tidak ada perubahan tipe `FixReviewLog` atau `FixReviewLogEntry`.
- Pagar dikenali sebagai baris yang, setelah `trim()`, diawali ```` ``` ```` (tiga backtick), di mana pun setelahnya; baris pagar membalik status pagar.
- Di dalam pagar, hanya aturan baris `## ` yang ditangguhkan; aturan lain (header, `Status:`, `Notes:`) berjalan seperti sekarang.
- Semua test lama lulus tanpa diubah.
- Tidak ada dependency baru, tidak ada panggilan model.

## Open questions
Tidak ada.

## Acceptance criteria
- AC-1: When a `### Comment` block has a line starting with `## ` between its header and its `Status:` line, then the entry is still returned with its status and note.
  Verify: automated test — `tests/unit/report-reader.sdd04e.test.ts` (kutipan tanpa awalan `>` berisi `## Something`, lalu `Status:` dan `Notes:`).
- AC-2: When a `Notes:` text has a fenced code block that contains a line starting with `## `, then the note keeps the lines up to and after that line (inside the fence), and the next `### Comment` block is still parsed.
  Verify: automated test — `tests/unit/report-reader.sdd04e.test.ts`.
- AC-3: When `## Proposed Spec Changes` follows the last entry, then it is not part of that entry's note, both with a blank line before it and directly after the `Notes:` line.
  Verify: automated test — `tests/unit/report-reader.sdd04e.test.ts` (kedua bentuk; bentuk kedua sama dengan test 04b yang tetap tidak diubah).
- AC-4: When one entry has a code fence that is never closed, then the next `### Comment` block is parsed normally, and a `## Proposed Spec Changes` after the last entry still ends it.
  Verify: automated test — `tests/unit/report-reader.sdd04e.test.ts`.
- AC-5: When a log has no line starting with `## ` inside its comment blocks, then the result is identical to before this ticket for the same input, including `mode`, entry order, and notes wrapped over several lines.
  Verify: automated test — `tests/unit/report-reader.sdd04e.test.ts` (bandingkan dengan keluaran yang dihitung di test untuk log tanpa baris `## ` di dalam blok; test lama `report-reader*.test.ts` tidak diubah dan lulus).
- AC-6: When the verification gate runs, then `pnpm typecheck && pnpm lint && pnpm test` passes, and no existing test file was modified.
  Verify: command: `pnpm typecheck && pnpm lint && pnpm test` | expect: exit 0
- AC-7: When `CLAUDE.md` is read, then the fix-review-log parsing paragraph states: a `## ` line ends the comment blocks only after `Status:` of the current entry and outside a code fence; before `Status:` it belongs to the quote; the known limit of D-2.
  Verify: manual — baca paragraf itu; ketiga butir ada.