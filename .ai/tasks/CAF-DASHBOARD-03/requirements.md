# CAF-DASHBOARD-03: Review & Fix-Review di Dashboard dan Agent Floor

Repo: `caf-orchestrator`
Artifact path: `.ai/tasks/CAF-DASHBOARD-03/`
Status: IMPLEMENTED, menunggu T8 (E2E nyata).
Bergantung pada: CAF-DASHBOARD-01 (dashboard), CAF-DASHBOARD-02 (Agent Floor), CAF-ORCH-PRREVIEW-03 (review Verdict-based) — ketiganya sudah merged.

## 1. Konteks

Dashboard (`/dashboard`) dan Agent Floor (`/dashboard/agent-floor`) membaca dua tabel SQLite, `pipeline_runs` dan `agent_events`, lalu menerima dorongan perubahan lewat SSE. Satu-satunya penulis ke tabel itu adalah pipeline tiket (`run-agent-pipeline.use-case.ts`, lewat `recordPipelineStarted` / `recordAgentEvent` / `recordAgentEnd` / `finalizePipelineRun` di `infrastructure/db/pipeline-instrumentation.ts`).

Job `pr-review` (`run-pr-review.use-case.ts`) tidak memanggil satu pun fungsi itu. Akibatnya tiga pemicu berikut berjalan tanpa jejak di dashboard maupun Agent Floor; satu-satunya sinyalnya adalah notifikasi Telegram dan comment di PR:

| Pemicu (GitHub) | Mode job | Yang dikerjakan |
|---|---|---|
| Comment PR `/caf-review` | `initial` | Review penuh, hasil `review-notes.md` dengan `Verdict`, diposting sebagai PR Review |
| Comment PR `/caf-fix-review` | `global` | Menanggapi semua comment di PR, hasil `fix-review-log.md` |
| Reply di thread inline review comment | `scoped` | Menanggapi satu comment itu saja, hasil `fix-review-log.md` |

Ketiga mode menjalankan satu agent yang sama, `caf-reviewer`. Ticket key selalu tersedia karena job hanya berjalan pada branch `ai-agent/<TICKET-KEY>` (`extractTicketKey`).

## 2. Keputusan yang sudah final (tidak dibuka ulang)

Diwarisi dari CAF-DASHBOARD-01/02:

- DB-only untuk data live dan historis. Sinyal "sedang jalan" adalah baris `pipeline_runs` dengan `final_status IS NULL`.
- `final_status` punya tiga nilai: `SUCCESS`, `NEEDS_HUMAN`, `ERROR`.
- Kegagalan tulis ke DB tidak pernah menggagalkan job (pola `warnOnFailure`).
- Worker dan web server adalah proses terpisah; perubahan disiarkan lewat `publishDashboardEvent` (Redis), bukan `eventBroadcaster` langsung.
- Vanilla JS tanpa build step, tanpa dependency frontend baru. UI memakai token `ui/shared/design-system.css`, tidak ada warna mentah.
- Halaman read-only: tidak ada tombol untuk memicu review dari dashboard.

Diputuskan Ganjar (2026-10-04):

- **Run review dicatat sebagai baris tersendiri**, dibedakan dengan kolom jenis run, bukan sebagai attempt baru pada baris pipeline tiket yang sama. Alasannya: `pipeline_runs` unik per `(repo_id, ticket_id)` dan `recordPipelineStarted` me-reset `ended_at`/`final_status`, sehingga memakai baris yang sama akan menimpa status akhir pipeline tiket dan mencampur riwayatnya.

## 3. Tujuan

1. Setiap job `pr-review` (ketiga mode) tercatat di DB dari mulai sampai selesai, termasuk hasilnya.
2. Dashboard menampilkan run review berdampingan dengan run pipeline, jelas dibedakan jenis dan modenya.
3. Agent Floor menampilkan run review secara live dan bisa memutar ulang run review historis.
4. Tidak ada perubahan perilaku pada pipeline tiket maupun pada alur review itu sendiri.

## 4. Non-goals

- Tidak mengubah alur review: prompt, kontrak `review-notes.md`/`fix-review-log.md`, pemetaan Verdict, posting ke GitHub, notifikasi Telegram.
- Tidak mengubah nama atau pencocokan slash command di `webhooks.ts`.
- Tidak menambah dukungan GitLab.
- Tidak menambah kontrol (trigger/stop/retry) dari dashboard.
- Tidak menginstrument `caf-documentation` (tetap seperti CAF-DASHBOARD-02).
- Tidak mem-backfill run review yang terjadi sebelum ticket ini (tidak ada datanya).

## 5. Functional Requirements

**FR-1 Pencatatan run review.** Setiap eksekusi `RunPrReviewUseCase.execute()` menghasilkan satu baris run dan event agent:

| Titik di use case | Yang dicatat |
|---|---|
| Job mulai (setelah ticket key tervalidasi) | Baris run baru: jenis, mode, repo, ticket key, nomor PR, `started_at` |
| Sebelum `agentRunner.run('caf-reviewer', ...)` | Event `start` untuk `caf-reviewer` |
| Setelah agent selesai | Event `end` dengan exit code, outcome, dan biaya (sama seperti pipeline) |
| Job selesai normal | `final_status` + ringkasan hasil (FR-2) |
| Job melempar error | `final_status = ERROR` |

Percobaan ulang BullMQ atas job yang sama menaikkan `attempt` pada baris yang sama, tidak membuat baris baru.

**FR-2 Ringkasan hasil.** Baris run review menyimpan hasil yang bisa ditampilkan tanpa membaca file artifact:

- Mode `initial`: Verdict (`APPROVE` / `CHANGES REQUESTED` / `DEFER`) dan apakah diposting sebagai `COMMENT` karena fallback self-review 422.
- Mode `global`/`scoped`: jumlah entri per status (`FIXED` / `SKIPPED` / `NOT_APPLICABLE`).

**FR-3 Pemisahan dari run pipeline.** Run review tidak pernah mengubah baris run pipeline untuk tiket yang sama (`started_at`, `ended_at`, `final_status`, `attempt`, `pr_number` tetap). Satu tiket boleh punya banyak run review. Baris yang sudah ada sebelum migrasi diperlakukan sebagai run pipeline.

**FR-4 API.** `GET /api/pipelines` mengembalikan jenis dan mode tiap run serta ringkasan hasilnya, dan bisa difilter per jenis. Detail dan floor-events untuk run review bisa diambil tanpa ambigu walau satu tiket punya beberapa run. Rute yang sudah ada tetap melayani run pipeline dengan bentuk respons yang kompatibel.

**FR-5 Dashboard.** Daftar run menampilkan penanda jenis (Pipeline / Review / Fix review), mode, nomor PR, dan hasil (Verdict atau hitungan FIXED/SKIPPED/N-A). Ada filter jenis. Detail run review menampilkan event `caf-reviewer`, durasi, dan biaya.

**FR-6 Agent Floor — live.** Saat run review aktif, hanya Reviewer yang bekerja; agent lain tetap idle di pantry. Visual membedakan review (`initial`) dari fix (`global`/`scoped`). Tahap pipeline di panel kiri menyesuaikan: run review tidak menampilkan langkah plan/impl/qa sebagai "belum jalan".

| Kondisi | Visual |
|---|---|
| Review `initial` berjalan | Reviewer state `reviewing` |
| Fix `global`/`scoped` berjalan | Reviewer state fix (lihat Pertanyaan Terbuka 1) |
| Selesai, Verdict `APPROVE` | Reviewer `celebrating`, lampu Ganjar hijau |
| Selesai, Verdict `CHANGES REQUESTED`/`DEFER` | Reviewer mengangkat tangan, lampu Ganjar merah |
| Fix selesai | Dokumen `fix-review-log.md` ke kotak PR |
| `ERROR` | Api kecil di kepala Reviewer |

**FR-7 Agent Floor — replay.** Run review historis bisa dipilih dan diputar ulang dengan kontrol yang sama (jeda, 1×/2×/4×), read-only, lewat normalizer yang sama dengan jalur live.

**FR-8 Multi-repo.** Run review ikut pemilih repo yang sudah ada; tidak bercampur antar repo.

## 6. Non-Functional Requirements

- Migrasi skema idempoten, aman dijalankan bersamaan oleh web server dan worker (keduanya membuka file DB yang sama), dan aman di atas database produksi yang sudah berisi data. Tidak ada rebuild tabel: review memakai `piv_phase = 'verify'` dan `event_type` `start`/`end` yang sudah lolos CHECK constraint.
- Instrumentasi tidak menambah panggilan jaringan dan tidak mengubah waktu eksekusi job secara berarti.
- Normalizer tetap fungsi murni (tanpa I/O, tanpa clock); jalur live dan replay menghasilkan urutan identik.
- Tidak ada isi comment, isi kode, atau isi prompt yang masuk ke DB/UI — hanya metadata dan hitungan.
- Regresi: seluruh test dashboard, Agent Floor, pipeline, dan pr-review yang ada tetap lulus tanpa diubah maknanya.

## 7. Kontrak Data (usulan, dikonfirmasi di T0)

Kolom baru di `pipeline_runs` (nullable, ditambah lewat `ADDED_COLUMNS` di `connection.ts`):

| Kolom | Nilai | Catatan |
|---|---|---|
| `kind` | `pipeline` \| `pr-review` | `NULL` dibaca sebagai `pipeline` |
| `review_mode` | `initial` \| `global` \| `scoped` | Hanya untuk `pr-review` |
| `review_result` | JSON teks | Verdict + flag fallback, atau hitungan status |

Identitas run review: id baris diturunkan dari `jobId` job (`github-<uuid>`), bukan dari `repoId:ticketId`, sehingga tiap job punya baris sendiri dan retry BullMQ jatuh ke baris yang sama.

Unique index `idx_pipeline_runs_repo_ticket` saat ini mencakup semua baris. Ia perlu dibatasi ke run pipeline saja (partial index) supaya beberapa run review untuk satu tiket bisa hidup berdampingan. Cara menggantinya dengan aman pada DB yang sudah ada diputuskan di T0.

Event Agent Floor: `run_started` membawa jenis dan mode run; `run_finished` membawa ringkasan hasil. Event `agent_state` memakai agent `reviewer` yang sudah ada.

## 8. Pertanyaan Terbuka

> Dijawab 2026-10-04 dengan usulan masing-masing: (1) state `fixing`, (2) selesai = `SUCCESS` apa pun Verdict-nya, (3) satu daftar gabungan + filter. Lihat `verify-report.md`.

1. **Visual mode fix di Agent Floor.** Fix dikerjakan oleh `caf-reviewer`, bukan Frontend/Backend. Pilihan: (a) state baru `fixing` untuk Reviewer (mengetik, layar kode) — rekomendasi, paling jujur terhadap apa yang terjadi; (b) pakai `reviewing` untuk semua mode, dibedakan hanya lewat teks/bubble. Diputuskan sebelum T5.
2. **Pemetaan `final_status` untuk hasil review.** Usulan: job selesai = `SUCCESS` apa pun Verdict-nya (Verdict tampil terpisah lewat `review_result`); Verdict tidak dikenali mengikuti perilaku yang sudah ada di use case (dikonfirmasi di T0); job melempar = `ERROR`. Alternatif: `CHANGES REQUESTED` dipetakan ke `NEEDS_HUMAN`. Diputuskan sebelum T2.
3. **Daftar run di dashboard.** Satu daftar gabungan dengan filter jenis (usulan), atau tab terpisah untuk review.

## 9. Acceptance Criteria

- [ ] Ketiga mode (`initial`, `global`, `scoped`) menghasilkan baris run + event `start`/`end` `caf-reviewer` dengan biaya dan outcome terisi.
- [ ] Run review tidak mengubah satu kolom pun pada baris run pipeline tiket yang sama (test eksplisit).
- [ ] Dua run review untuk tiket yang sama menghasilkan dua baris; retry BullMQ atas satu job menaikkan `attempt` pada baris yang sama.
- [ ] DB yang dibuat sebelum ticket ini bermigrasi tanpa kehilangan data, dan migrasi dijalankan dua kali tidak mengubah apa pun.
- [ ] DB tidak tersedia: job review tetap berjalan sampai selesai (hanya warning di log).
- [ ] Dashboard menampilkan run review dengan jenis, mode, nomor PR, dan hasil; filter jenis bekerja.
- [ ] Agent Floor menampilkan run review live tanpa reload dan memutar ulang run review historis.
- [ ] Run pipeline tampil persis seperti sebelumnya di dashboard dan Agent Floor.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` lulus.
- [ ] `docs/dashboard.md` dan `CLAUDE.md` diperbarui.
