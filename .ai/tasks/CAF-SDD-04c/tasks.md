# CAF-SDD-04c — Tasks
Repo: `caf-orchestrator`. Baca `requirements.md` di folder ini dulu. Jangan menebak: bila pola kode tidak jelas, ikuti test existing dan catat di `verify-report.md`.

## Aturan umum
- Syarat mulai: `requirements.md` berstatus `Status: APPROVED`; 04a dan 04b sudah di main. Bila belum, STOP `NEEDS_HUMAN`.
- Branch `ai-agent/CAF-SDD-04c` dari main terbaru, working tree bersih. Tidak ada push, PR, atau merge ke remote asli; test memakai port palsu. Commit lokal satu per tahap bermakna.
- Use case hanya bergantung pada port; tambahan port seminimal mungkin, dicatat di `verify-report.md`.
- Bila temuan T1 bertentangan dengan sebuah AC atau salah satu asumsi A1 sampai A4 tidak terpenuhi dan butuh perubahan di luar yang disebut spec, STOP `NEEDS_HUMAN` sebelum menyentuh `src/`.
- Perilaku command webhook yang sudah ada tidak berubah. Test lama yang mengunci teks atau urutan yang memang berubah boleh diperbarui; catat tiap perubahan beserta alasan. Cari teks yang berubah di semua berkas test, bukan hanya test yang namanya jelas terkait.

## Tasks
- [ ] T1 (A1 sampai A4): Audit baca-saja, catat di `verify-report.md`: bentuk payload label (GitHub dan Linear) dan port yang dipakai; kemampuan port tracker/VCS membaca komentar ticket dan komentar yang dibuat bot; perilaku pipeline normal bila branch `ai-agent/<KEY>` sudah ada di remote; bentuk `orchestration-state.json` dan pembacanya; titik pipeline setelah planner dan sebelum agent implementasi; tempat PR dibuat atau diperbarui; tempat command komentar PR didaftarkan (route, dedupe, permission, kill switch); test yang mengunci hal itu.
- [ ] T2 (AC-1 sampai AC-18): Tulis test merah untuk tiap AC.
- [ ] T3 (AC-1): Kunci konfigurasi label gerbang (GitHub, Linear, per project) dengan default.
- [ ] T4 (AC-2 sampai AC-5, AC-18): Modul murni pembaca hasil planner (`Status:` dan pertanyaan BLOCKING tanpa `— Answer:`) dan jalur Clarify di pipeline: commit dan push draf, komentar ticket, berhenti.
- [ ] T5 (AC-6, AC-7): Pemicu normal pada branch yang menunggu Clarify: lanjut di branch, kumpulkan komentar jawaban, jalankan planner dengan konteks.
- [ ] T6 (AC-8 sampai AC-10): Gerbang spec berlabel: Draft PR berisi folder spec saja, komentar ticket, berhenti, simpan keadaan menunggu.
- [ ] T7 (AC-11 sampai AC-17): Command `/caf-approve-spec`: route, permission, validasi spec, perubahan satu baris `Status:`, resume dari implementasi, PR dipakai ulang.
- [ ] T8 (AC-20): Jalankan `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] T9 (AC-19): Perbarui README/CLAUDE.md orchestrator.
- [ ] T10: Tulis `verify-report.md` (format Layer 3, bukti per AC dengan nama test; AC ber-`command` dilaporkan sebagai `command`). Catat hasil T1, port yang ditambah, test lama yang diubah, hal tak terduga.

## Docs Tasks
- README/CLAUDE.md orchestrator (T9).

## Di luar tugas ini
Perubahan di `caf-initiator`, planner, Jira, pembatasan penjawab Clarify, jatah retry, kunci config `agents.*`, gate validasi dan reviewer.

## Coverage
- AC-1 → T2, T3
- AC-2, AC-3, AC-4, AC-5, AC-18 → T2, T4
- AC-6, AC-7 → T2, T5
- AC-8, AC-9, AC-10 → T2, T6
- AC-11 sampai AC-17 → T2, T7
- AC-19 → T9
- AC-20 → T8
