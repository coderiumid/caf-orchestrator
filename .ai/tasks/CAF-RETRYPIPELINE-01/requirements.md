## Ticket: CAF-RETRYPIPELINE-01
## Judul: Push + Draft PR pada Gate Exhaustion, dan Mekanisme Resume via `/caf-retry-pipeline`

---

## Latar Belakang

Saat ini, ketika pipeline `caf-orchestrator` berhenti karena `NEEDS_HUMAN` (gate QA atau
Reviewer habis retry, atau agent implementasi gagal), kode yang sudah dikerjakan **tidak pernah
di-push**. Developer harus masuk ke VPS, cek Docker, cek branch lokal secara manual untuk melihat
progres yang sudah dikerjakan AI. Untuk fitur besar/kompleks, ini jadi beban operasional yang
signifikan dan bertentangan dengan prinsip CAF soal governance yang mudah divalidasi manusia.

Selain itu, tidak ada mekanisme resmi untuk melanjutkan (retry) ticket yang sudah `NEEDS_HUMAN`
tanpa mengulang seluruh pipeline dari awal. Retry counter yang ada sekarang (`qaRetryCount`,
`reviewerRetryCount`) bersifat lokal per-invocation `execute()` — reset ke 0 setiap kali
orchestrator dipanggil ulang — sehingga tidak ada batas atas untuk retry lintas-invocation.

---

## Tujuan

1. Kode yang sudah dikerjakan AI tetap di-push dan dibuka sebagai **Draft PR** saat pipeline
   berhenti di `NEEDS_HUMAN`, lengkap dengan ringkasan kendala dari artifact yang relevan.
2. Tersedia mekanisme retry resmi (`/caf-retry-pipeline`) yang bisa di-trigger dari komentar PR
   maupun dari perubahan status ticket di Linear, dengan batas retry yang dikonfigurasi per repo.
3. Resume bersifat gate-aware — melanjutkan dari titik kegagalan, bukan mengulang dari awal —
   dan sadar terhadap perubahan manual (commit developer) yang terjadi di antara run.

---

## Scope

### In Scope
- Perubahan perilaku orchestrator: push + buka Draft PR pada gate exhaustion di titik-titik
  berikut: agent implementasi (Frontend/Backend), QA, Reviewer.
- Isi PR description diambil dari artifact yang sudah ada (`verify-report.md`, `qa-report.md`,
  `review-notes.md`) — bukan generate ulang teks baru.
- Extend `caf-config.yaml`: field `orchestration.maxOrchestrationRetries` per entry repo di
  repo registry (fallback ke default global jika tidak diisi).
- File state baru per ticket: `.caf/tasks/{ticketKey}/orchestration-state.json` **di dalam
  repo target** (`repoPath`) — ikut convention existing (`report-reader.ts` `taskDir()`,
  sejalur dengan `verify-report.md`/`qa-report.md`/`review-notes.md`). Ini bukan
  `.ai/tasks/{TICKET-ID}/` seperti disebut versi awal dokumen ini — koreksi berdasarkan audit
  kode saat Task 2 dikerjakan: `.ai/tasks/` adalah namespace dev-doc planning untuk ticket
  `caf-orchestrator` itu sendiri (dokumen yang sedang kamu baca ini), bukan runtime artifact
  pipeline. Menyimpan `orchestrationRetryCount`, `lastFailedGate`, `lastFailedAt`,
  `lastKnownCommitSha`. Path di dalam `repoPath` ini wajib supaya ikut `git fetch`/`reset` di
  mode `persistent` dan ikut ke branch/PR — kalau ditaruh di luar repo target, seluruh
  mekanisme deteksi `lastKnownCommitSha` di Task 6 tidak akan berfungsi.
- Command baru `/caf-retry-pipeline` via webhook `issue_comment` pada Draft PR.
- Trigger retry kedua: perubahan status ticket Linear kembali ke "Ready for AI" pada ticket
  yang branch `ai-agent/{TICKET-ID}`-nya sudah ada — diarahkan ke resume handler yang sama
  dengan `/caf-retry-pipeline` (bukan flow "ticket baru").
- Shared resume handler: baca `orchestration-state.json`, tentukan gate mana yang perlu
  dilanjutkan, sertakan artifact gate yang gagal sebagai input tambahan untuk agent yang
  di-resume.
- Deteksi perubahan manual: hitung `git diff {lastKnownCommitSha}..HEAD --stat` sebelum resume,
  lampirkan hasilnya sebagai `manualChangesSinceLastRun` di context yang dibaca agent. Untuk
  mode `persistent` (mode aktif saat ini di VPS), tambahkan `git fetch` + sinkronisasi workspace
  ke `origin/{branch}` sebelum resume, karena workspace lokal di VPS bisa saja tidak sinkron
  dengan HEAD remote (commit manual dari luar VPS).
- Deteksi uncommitted changes tak terduga di workspace `persistent` (residu run PIV yang
  terhenti tidak wajar) → STOP dan report ke PR, jangan lanjut otomatis.

### Out of Scope
- Implementasi detail workspace `ephemeral` untuk retry (didokumentasikan sebagai catatan
  desain, tidak diimplementasikan sekarang karena mode aktif adalah `persistent`).
- Perubahan pada retry counter internal `qaRetryCount`/`reviewerRetryCount` (retry per-invocation
  yang sudah ada tetap seperti sekarang — tidak digabung dengan `orchestrationRetryCount`).
- Perubahan pada `caf-pr-review` (`/caf-review`, `/caf-fix-review`) — command ini terpisah dan
  tidak disentuh.
- Pekerjaan repo registry multi-repo (Priority A) di luar penambahan field
  `orchestration.maxOrchestrationRetries` pada schema-nya — field ini ditambahkan mengikuti
  struktur repo registry yang sedang dibangun di Priority A, bukan mendahului atau menduplikasi
  pekerjaan tersebut.
- Whitelist siapa yang boleh trigger `/caf-retry-pipeline` — mengikuti keputusan whitelist yang
  sama dengan `/caf-review` (masih pending, TBD di ticket lain).

---

## Dependency

- **Repo registry (Priority A) sudah selesai dan terverifikasi berjalan multi-repo** (diuji
  paralel di `umkm-pos` dan `coderium-web-v2`). Field `orchestration.maxOrchestrationRetries`
  ditempelkan langsung ke struktur repo registry entry yang sudah ada — tidak ada lagi
  kondisi fallback ke config global sebagai pendekatan sementara.
- Menggunakan review engine yang sama dengan `caf-reviewer`/`caf-pr-review` (tidak membuat
  logic parsing verdict baru).

---

## Acceptance Criteria

- [ ] Ticket yang gate-nya habis (implementasi/QA/Reviewer) menghasilkan Draft PR berisi kode
      yang sudah dikerjakan, bukan hanya comment di Linear/Jira.
- [ ] PR description memuat: gate yang gagal, attempt log, acceptance criteria yang
      terpenuhi/belum, dan link ke folder `.caf/tasks/{ticketKey}/` di repo target.
- [ ] Draft PR tidak bisa di-merge tanpa konversi manual ke "Ready for review" (native GitHub
      behavior untuk draft — diverifikasi, bukan diasumsikan).
- [ ] `maxOrchestrationRetries` terbaca dari `caf-config.yaml` per repo, dengan default yang
      jelas jika tidak diisi.
- [ ] `orchestrationRetryCount` bertambah baik lewat trigger Linear maupun `/caf-retry-pipeline`
      — dibuktikan dengan test bahwa retry dari dua jalur berbeda memakai counter yang sama,
      bukan counter terpisah.
- [ ] Ticket yang sudah mencapai `maxOrchestrationRetries` tidak lagi bisa di-retry otomatis —
      pesan eksplisit di PR menyatakan batas retry sudah tercapai.
- [ ] Resume dari QA yang gagal menyertakan `qa-report.md` sebagai input agent, bukan mulai dari
      `requirements.md` lagi.
- [ ] Jika ada commit manual di branch sejak run terakhir, diff-nya muncul di context resume
      (`manualChangesSinceLastRun`) dan pipeline tetap lanjut otomatis (tidak stop-and-report
      untuk kasus ini).
- [ ] Jika ada uncommitted changes tak terduga di workspace VPS (bukan hasil commit manual
      developer), pipeline stop dan report ke PR — tidak lanjut otomatis.
- [ ] Regression test: pipeline yang sukses penuh (tanpa `NEEDS_HUMAN`) tidak terpengaruh
      perilakunya oleh perubahan ini.