## Ticket: CAF-RETRYPIPELINE-01
## Breakdown Task

> Urutan mengikuti dependency teknis: config & state dulu (fondasi data), baru push/PR
> (bisa langsung diverifikasi hasilnya), baru command + resume logic (paling kompleks,
> butuh fondasi di atas sudah stabil).

---

### Task 1 — Extend config schema (`caf-config.yaml`)
- Tambahkan field `orchestration.maxOrchestrationRetries` (number) di level repo registry
  entry yang sudah ada (Priority A sudah selesai dan terverifikasi jalan multi-repo di
  `umkm-pos` + `coderium-web-v2`).
- Tambahkan default global (misal `2`) sebagai fallback kalau field per-repo tidak diisi —
  ini murni convenience default, bukan mode operasi sementara.
- Update Zod schema validation yang sudah ada di `caf-orchestrator` — jangan buat schema
  parsing baru terpisah.
- **Verify:** config tanpa field ini tetap valid (fallback ke default); config dengan field
  ini ter-override dengan benar per repo; jalankan test dengan minimal 2 repo entry berbeda
  nilai `maxOrchestrationRetries`-nya untuk pastikan tidak saling bocor antar repo (konsisten
  dengan pola verifikasi "2 repo paralel tanpa interferensi" di Priority A).

### Task 2 — `orchestration-state.json` per ticket
- Definisikan struktur file: `.ai/tasks/{TICKET-ID}/orchestration-state.json`
  ```json
  {
    "orchestrationRetryCount": 0,
    "lastFailedGate": "qa | reviewer | implementation | null",
    "lastFailedAt": "ISO timestamp",
    "lastKnownCommitSha": "sha"
  }
  ```
- Tulis file ini setiap kali orchestrator:
  - Selesai sukses penuh (reset state / hapus file, TBD — putuskan salah satu, konsisten)
  - Berhenti di `NEEDS_HUMAN` (isi `lastFailedGate`, `lastFailedAt`, `lastKnownCommitSha`
    dari HEAD branch saat itu)
- **Verify:** file muncul dengan isi benar pada skenario gate gagal; tidak muncul/di-reset
  pada skenario sukses.

### Task 3 — Push + Draft PR pada gate exhaustion
- Ubah titik gate exhaustion (implementasi/QA/Reviewer) dari `postComment + return` menjadi:
  `commit + push + buka Draft PR (jika belum ada) + postComment`.
- **Penting:** ini menyentuh logic `return` vs `throw` yang sudah diverifikasi hati-hati
  sebelumnya (lihat prinsip "return vs throw di gate exhaustion" — gate exhausted tetap
  harus `return`, BUKAN `throw`, supaya BullMQ job retry tidak ikut ter-trigger). Perubahan
  ini menambah aksi push+PR sebelum `return`, tidak mengubah kontrak `return`/`throw`.
- PR description generator: baca `verify-report.md`/`qa-report.md`/`review-notes.md` sesuai
  gate yang gagal, format ke PR body. Tidak generate teks baru — hanya reformat artifact
  yang sudah ada.
- Cek apakah PR untuk branch itu sudah pernah dibuka sebelumnya (mis. dari gate gagal
  sebelumnya di run yang sama/berbeda) — jika sudah ada, update description-nya, jangan buat
  PR duplikat.
- **Verify (di `umkm-pos`, real repo bukan fixture):** jalankan skenario QA gagal habis
  retry → cek Draft PR muncul di GitHub dengan description yang sesuai, dan PR berstatus
  draft (tidak bisa langsung di-merge).

### Task 4 — `/caf-retry-pipeline` command + webhook handler
- Tambahkan handler `issue_comment` baru untuk trigger `/caf-retry-pipeline`, mengikuti pola
  yang sama dengan `/caf-review`/`/caf-fix-review` (derive TICKET-ID dari branch
  `ai-agent/{TICKET-ID}`).
- Baca `orchestrationRetryCount` dari `orchestration-state.json` — jika sudah mencapai
  `maxOrchestrationRetries`, tolak retry dan post comment eksplisit di PR (bukan diam-diam
  tidak melakukan apa-apa).
- Jika masih dalam batas, increment counter, lanjut ke shared resume handler (Task 5).
- **Verify:** comment `/caf-retry-pipeline` di PR draft memicu pipeline lanjut; comment yang
  sama setelah batas retry tercapai ditolak dengan pesan jelas.

### Task 5 — Trigger retry via Linear (jalur kedua ke resume handler yang sama)
- Di webhook Linear existing: sebelum treat sebagai "ticket baru", cek apakah branch
  `ai-agent/{TICKET-ID}` sudah ada.
- Jika sudah ada → panggil shared resume handler yang sama dengan Task 4 (bukan flow baru).
- **Verify:** ticket yang statusnya dibalikin ke "Ready for AI" di Linear, dan branch-nya
  sudah ada, tidak membuat branch baru — lanjut ke resume, dan `orchestrationRetryCount`
  yang terupdate sama dengan yang dibaca dari trigger `/caf-retry-pipeline`.

### Task 6 — Shared resume handler (gate-aware + deteksi perubahan manual)
- Baca `lastFailedGate` dari `orchestration-state.json` → tentukan agent mana yang perlu
  dijalankan ulang dan artifact gate mana yang jadi input tambahan:
  - `implementation` gagal → jalankan ulang agent implementasi dengan `verify-report.md`
    attempt sebelumnya sebagai konteks
  - `qa` gagal → jalankan ulang agent implementasi (atau QA langsung, tergantung desain
    yang sudah ada) dengan `qa-report.md` sebagai input
  - `reviewer` gagal → dengan `review-notes.md` sebagai input
- **Sinkronisasi workspace (mode `persistent`, mode aktif saat ini):**
  - `git fetch` branch `ai-agent/{TICKET-ID}`
  - Bandingkan HEAD remote dengan `lastKnownCommitSha`
  - Jika beda → `git reset --hard origin/{branch}` agar workspace VPS sinkron, lalu hitung
    `git diff {lastKnownCommitSha}..HEAD --stat`, simpan sebagai `manualChangesSinceLastRun`
  - Jika ada uncommitted changes di workspace sebelum reset (residu tak terduga, bukan dari
    commit manual developer) → STOP, post comment ke PR, jangan lanjut otomatis
- Sertakan `manualChangesSinceLastRun` (jika ada) sebagai bagian context yang dibaca agent
  yang di-resume — agar agent tidak bekerja dengan asumsi basi soal isi file yang mungkin
  sudah berubah.
- **Catatan desain untuk mode `ephemeral` (tidak diimplementasikan sekarang):** workspace
  baru di-clone lalu checkout branch `ai-agent/{TICKET-ID}` (bukan `defaultBranch`) — karena
  selalu fresh clone, otomatis dapat HEAD terbaru tanpa perlu fetch/reset eksplisit, dan tidak
  ada risiko uncommitted residue. Didokumentasikan di sini untuk referensi jika mode ini
  diaktifkan nanti.
- **Verify (real repo, `umkm-pos`):**
  1. Skenario tanpa perubahan manual: retry langsung lanjut dari gate yang gagal.
  2. Skenario dengan commit manual developer di antara run: diff muncul di context, pipeline
     tetap lanjut otomatis.
  3. Skenario uncommitted residue tak terduga: pipeline stop, comment muncul di PR.

### Task 7 — grep-audit-final
- Scan seluruh referensi ke pola lama (`postComment + return` tanpa push) di titik-titik gate
  yang diubah — pastikan tidak ada jalur gate exhaustion yang terlewat.
- Scan template agent (`agent-handoff-md.js` dan sejenisnya) untuk memastikan tidak ada
  asumsi format lama yang bentrok dengan field baru di `orchestration-state.json` — mengingat
  riwayat CDR-38 soal parser/template contract mismatch.

### Task 8 — Regression test
- Pastikan pipeline sukses penuh (tanpa `NEEDS_HUMAN` sama sekali) tidak terpengaruh — tidak
  ada Draft PR ekstra, tidak ada `orchestration-state.json` yang mengganggu flow normal.
- Test unit untuk parsing/reading `orchestration-state.json` (pola sama dengan
  `tests/unit/report-reader.test.ts` yang sudah ada).

---

## Checkpoint Report

Setelah tiap task selesai, laporkan ke developer sebelum lanjut task berikutnya — khususnya
Task 3 (push+PR) sebaiknya diverifikasi end-to-end di `umkm-pos` dulu sebelum lanjut ke
Task 4-6 (command + resume), karena Task 4-6 bergantung pada Draft PR yang sudah benar
terbentuk dari Task 3.