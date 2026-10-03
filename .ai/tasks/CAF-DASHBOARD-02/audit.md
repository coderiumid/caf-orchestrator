# CAF-DASHBOARD-02 — T0 Audit Data

Tanggal audit: 2026-10-04. Commit yang diaudit: `a1d1ab3` (`main`, working tree bersih).
Sifat: read-only. Tidak ada file selain dokumen ini yang diubah. Tidak ada pipeline yang dipicu.

Gerbang prasyarat: Task 7 CAF-DASHBOARD-01 dinyatakan lulus oleh Ganjar secara langsung pada sesi ini (2026-10-04). Dokumen DASHBOARD-01 sendiri belum mencerminkan itu: `verify-report.md:3` masih `Status: NEEDS_HUMAN` dan `docs/dashboard.md:108-117` masih memuat "Known limitation (as of Task 7)".

## Ringkasan

- Data yang ada cukup untuk animasi tingkat agent: siapa mulai, siapa selesai, retry gate QA/Reviewer, gate mana yang habis, status akhir, biaya per agent run.
- Yang tidak ada: token, nomor PR, percobaan verify internal agent (n/3) beserta hasil lint/typecheck/test, batas antar-attempt dalam satu run, dan hasil (berhasil/gagal) per agent run.
- SSE yang ada hanya sinyal "ada perubahan" tanpa isi. Tidak satu pun dari enam event ber-kontrak di `requirements.md` bagian 7 dikirim sebagai event.
- **Rekomendasi: T1 diperlukan, dalam bentuk minimal** (kolom tambahan, tanpa nilai `event_type` baru). Rinciannya di bagian "Rekomendasi T1".
- Baseline test saat ini **tidak hijau**: 2 test gagal di `main` sebelum ada perubahan apa pun (lihat bagian 8).

## Tabel: kebutuhan event vs tersedia sekarang

Kontrak dari `requirements.md` bagian 7. "Sebagian" berarti bisa diturunkan dari data yang ada tetapi dengan keterbatasan yang disebutkan.

| Event | Field / kebutuhan | Status | Bukti dan catatan |
|---|---|---|---|
| `run_started` | `runId` | Sebagian | Id deterministik `repoId:ticketId` (`pipeline-instrumentation.ts:21-23`). Tidak unik per attempt: retry BullMQ dan resume memakai baris yang sama. |
| | `ticket` | Ada | `pipeline_runs.ticket_id`, `ticket_title` (`schema.sql:5-13`). |
| | `repo` | Ada | `pipeline_runs.repo_id` berformat `owner/repo`. |
| | `branch` | Sebagian | Tidak disimpan. Selalu `ai-agent/<ticketKey>` (`run-agent-pipeline.use-case.ts:233`), jadi bisa dihitung. |
| | `startedAt` | Sebagian | `started_at` hanya diisi saat insert pertama; upsert pada attempt berikutnya tidak memperbaruinya (`pipeline-run.repository.ts:114-119`). |
| | dikirim sebagai event | Tidak ada | SSE hanya mengirim sinyal generik (bagian 4). |
| `agent_state` | `agent` | Ada | `agent_events.agent_name` untuk 5 agent: `caf-planner`, `caf-frontend`, `caf-backend`, `caf-qa`, `caf-reviewer`. |
| | `planning`, `implementing` | Ada | Event `start` dengan `piv_phase` `plan` / `implement`. |
| | `verifying` (QA), `reviewing` | Ada | Event `start` `caf-qa` / `caf-reviewer`, keduanya `piv_phase = verify`; dibedakan lewat `agent_name`. |
| | `retrying` + `attempt` (gate QA/Reviewer) | Ada | Event `retry` dengan `retry_count` (`use-case.ts:617`, `:670`). |
| | `retrying` + `attempt` (verify internal agent, n/3) | Tidak ada | Loop itu berjalan di dalam proses agent di repo target. Orchestrator hanya melihat satu `start` dan satu `end`. |
| | `checks` (lint/typecheck/test) | Tidak ada | Tidak ada sumber data di orchestrator. |
| | batas retry per gate | Sebagian | Tidak ada di DB. Tersedia di config server: `agents.qa.maxRetries` / `agents.reviewer.maxRetries` (`config/schema.ts:170-174`). |
| | `blocked` | Sebagian | `final_status = NEEDS_HUMAN` selalu tercatat; penyebabnya hanya tercatat bila berasal dari gate (bagian 6). |
| | `error` | Sebagian | `final_status = ERROR` tercatat (`use-case.ts:478`), tetapi agent mana yang gagal tidak tercatat: `end` ditulis sebelum exit code diperiksa (`:412` vs `:423-441`; `:1088` vs `:1111-1117`). |
| | `celebrating`, `idle` | Ada | Diturunkan dari `final_status = SUCCESS` dan dari ketiadaan run aktif. |
| | `offduty` (Docs) | Ada | `caf-documentation` tidak pernah menulis event (`use-case.ts:698-760`, `pipeline-instrumentation.ts:31-37`). |
| `handoff` | `from`, `to`, `file` | Sebagian | Tidak ada event handoff. Bisa diturunkan dari urutan `end` → `start` berikutnya; `file` hanya bisa diasumsikan dari konvensi (planner → `tasks.md`, dst.). |
| `step` | `step`, `status`, `note` | Sebagian | Tahap bisa diturunkan dari `start`/`end`. `status` berhasil/gagal per tahap tidak disimpan. |
| `usage` | `costUsd` | Ada | `agent_events.cost_usd` pada event `end`, per agent run. |
| | `tokens` | Tidak ada | `parseAgentUsage()` mengembalikan token, tetapi hanya `costUsd` yang disimpan (`pipeline-instrumentation.ts:126-127`); tidak ada kolom token. |
| `run_finished` | `finalStatus` | Ada | `pipeline_runs.final_status`, `ended_at`. |
| | `prNumber` | Tidak ada | Tidak ada kolom. PR dibuat setelah `finalizePipelineRun('SUCCESS')` (`use-case.ts:762` vs `:782-789`). Draft PR dari gate juga tidak disimpan. |
| Semua event | timestamp server | Ada | `created_at` ISO, ditulis proses worker. |
| Semua event | urutan stabil, anti-duplikat | Ada | `agent_events.id` autoincrement; query diurutkan `created_at ASC, id ASC` (`pipeline-run.repository.ts:183`). |

## 1. Skema SQLite dan titik tulis

Skema (`src/infrastructure/db/schema.sql:5-31`), identik dengan `.schema` pada DB lokal:

- `pipeline_runs(id PK, repo_id, ticket_id, ticket_title, started_at, ended_at, final_status)`, indeks unik `(repo_id, ticket_id)`.
- `agent_events(id AUTOINCREMENT, pipeline_run_id FK, agent_name, piv_phase, event_type, retry_count, cost_usd, artifact_link, created_at)`.
- `CHECK piv_phase IN ('plan','implement','verify')` dan `CHECK event_type IN ('start','end','retry','gate_exhausted')`.

Migrasi: `openDb()` menjalankan `schema.sql` (`CREATE ... IF NOT EXISTS`) setiap kali DB dibuka (`connection.ts:11-28`). Tidak ada versi skema dan tidak ada `ALTER`. Konsekuensi untuk T1: menambah kolom butuh logika `ALTER TABLE ADD COLUMN` yang dijaga sendiri; mengubah `CHECK` butuh membangun ulang tabel.

Hanya ada tiga pernyataan tulis SQL, semuanya di `pipeline-run.repository.ts`: upsert run (`:111-130`), finalize run (`:133-137`), insert event (`:139-160`). Semua dipanggil lewat pembungkus di `pipeline-instrumentation.ts` yang menelan error dan menyiarkan sinyal perubahan (`:44-66`). Pemanggilnya hanya `run-agent-pipeline.use-case.ts`; `run-pr-review.use-case.ts`, `webhooks.ts`, dan `worker.ts` tidak menulis ke DB ini.

| Titik tulis | Baris | Isi |
|---|---|---|
| `recordPipelineStarted` | `:242` | Upsert run; mengosongkan `ended_at`/`final_status`. Dipanggil setelah workspace didapat. |
| `recordAgentEvent` start / `recordAgentEnd` planner | `:405`, `:412` | Hanya jalur non-resume. |
| start / end agent implementasi | `:1081`, `:1088` | Per agent, berurutan (frontend lalu backend). |
| start / end QA | `:1125`, `:1133` | |
| start / end Reviewer | `:1176`, `:1184` | |
| `retry` QA / Reviewer | `:617`, `:670` | `retry_count` = counter loop. |
| `gate_exhausted` + finalize `NEEDS_HUMAN` | `:836-839` | `agent_name` = `implementation-agents` / `caf-qa` / `caf-reviewer`; `artifact_link` = `.caf/tasks/<key>/<artifact>`. |
| finalize `NEEDS_HUMAN` tanpa event | `:279`, `:314`, `:463`, `:888`, `:904` | Branch remote hilang, workspace kotor, error API 429/404, state resume tidak ada, budget retry habis. |
| finalize `SUCCESS` | `:762` | Sebelum commit, push, dan pembuatan PR. |
| finalize `ERROR` | `:478` | Setiap error yang dilempar; BullMQ lalu mengulang job. |

Dua jalur berhenti tidak menulis baris sama sekali karena terjadi sebelum `:242`: payload lama tanpa `projectConfig` dan workspace sedang terkunci (`:188-229`).

## 2. Data per agent per fase

| Pertanyaan | Jawaban |
|---|---|
| Waktu mulai dan selesai per agent | Ada, sebagai pasangan event `start`/`end` dengan `created_at`. Durasi dihitung dari selisihnya. |
| Nomor percobaan verify (n/3) | Tidak ada. Lihat tabel di atas. |
| Jenis gate | Ada untuk `retry` (QA, Reviewer) dan `gate_exhausted` (implementasi, QA, Reviewer), lewat `agent_name`. |
| Biaya per agent | Ada, per agent run, pada event `end`. |
| Token per agent | Tidak ada. |
| Hasil agent run (exit code, PASS/FAIL QA, verdict Reviewer) | Tidak ada. Hanya bisa disimpulkan dari event berikutnya (`retry`, `gate_exhausted`) atau dari `final_status`. |
| Batas antar-attempt | Tidak ada. Event dari retry BullMQ dan dari resume menumpuk di run yang sama tanpa penanda. Attempt baru hanya terlihat dari `start` planner; resume melewati planner (`use-case.ts:355-385`) sehingga tidak punya penanda sama sekali. |

Isi DB lokal (dibaca dari salinan): 7 run, 67 event. Status akhir: 3 `SUCCESS`, 4 `NEEDS_HUMAN`, 0 `ERROR`, 0 sedang berjalan. `gate_exhausted`: 3 QA, 1 implementasi, 0 Reviewer. Tidak ada contoh retry Reviewer. Artinya data nyata belum mencakup kasus `ERROR` dan gate Reviewer; test T2 untuk kasus itu harus memakai fixture.

## 3. Status `parseAgentUsage()`

Sudah di-wire, sebagian.

- Definisi: `src/infrastructure/agent/agent-cost-parser.ts:18-38`. Mengembalikan `costUsd`, `inputTokens`, `outputTokens`.
- Satu-satunya pemanggil: `recordAgentEnd()` di `pipeline-instrumentation.ts:119-128`, yang dipakai pada keempat titik `end` (planner, implementasi, QA, Reviewer).
- Hanya `costUsd` yang diteruskan ke DB (`:127`). Token dibuang.
- Input parser tersedia: agent di-spawn dengan `--output-format json` (`spawn-agent.service.ts:100`).
- DB lokal mengonfirmasi biaya terisi pada event `end` dari run nyata.

Catatan: parser hanya membaca `usage.input_tokens` dan `usage.output_tokens` (`:34-35`). Bila token cache dilaporkan di field terpisah, angka token yang nanti disimpan akan lebih kecil dari pemakaian sebenarnya. Ini belum saya verifikasi terhadap keluaran CLI nyata.

## 4. Event SSE yang ada

Endpoint: `GET /api/events/stream` (`routes/events.ts:42-69`).

Payload, satu bentuk saja (`sse/event-broadcaster.ts:8-13`):

```
data: {"repoId":"owner/repo","ticketId":"GAN-59","eventType":"add|change|unlink","timestamp":"<ISO>"}
```

- Tidak ada nama event (`event:`), tidak ada `id:`, tidak ada dukungan `Last-Event-ID`.
- Tidak ada filter di server; semua klien menerima semua event (`event-broadcaster.ts:30-43`).
- Heartbeat komentar tiap 15 detik dan padding awal 2 KB untuk menembus buffer proxy (`events.ts:55-59`).
- Dua sumber: watcher chokidar atas `orchestration-state.json` (`server.ts:17-19`) dan Redis pub/sub channel `caf:dashboard:events` dari proses worker pada setiap tulis DB (`pipeline-instrumentation.ts:64-66`, `queue/dashboard-events.ts:35-63`, `server.ts:24`).
- Klien dashboard tidak membaca isi event; ia memuat ulang `/api/pipelines` dan detail yang terbuka (`ui/dashboard.js:235-246`).

Kecukupan: sebagai pemicu "ada perubahan, ambil ulang" sudah cukup dan sudah menjangkau lintas proses. Sebagai pembawa kontrak bagian 7 tidak cukup. Detail run sudah tersedia lewat `GET /api/pipelines/:repoId/:ticketId` yang mengembalikan seluruh `events` (`routes/pipelines.ts:100-108`).

## 5. Struktur SPA, rute, dan auth

- Tidak ada `@fastify/static`. Empat file dibaca sekali saat modul dimuat (`ui/dashboard-page.ts:18-21`) dari `src/presentation/web/ui/` (`dashboard.html`, `.css`, `.js`) dan `src/presentation/web/assets/logo.png`.
- Rute: `/dashboard`, `/dashboard/app.css`, `/dashboard/app.js`, `/dashboard/logo.png` (`routes/dashboard-ui.ts:19-42`), didaftarkan di `app.ts:104`. Semua rute dashboard tidak terdaftar bila `dashboard.enabled` false.
- `tsc` tidak menyalin aset non-TS; Dockerfile menyalin tiap file satu per satu (`Dockerfile:57-62`). Setiap file statis baru butuh baris `COPY` baru.
- Basic auth: `registerDashboardBasicAuth()` (`auth/dashboard-basic-auth.ts:34-46`, pembanding timing-safe) dipanggil per plugin, lalu `app.addHook('onRequest', app.basicAuth)`. Dipakai di `dashboard-ui.ts:16-17` dan `pipelines.ts:87-88`.
- **SSE tidak memakai basic auth itu.** Ia memeriksa cookie `caf_dashboard_auth` (`events.ts:19-36`), yang hanya dipasang oleh handler `GET /dashboard` (`dashboard-ui.ts:19-30`), `Path=/api`, `Max-Age=3600`. Nilainya base64 dari `user:password`, tanpa atribut `Secure`, dibandingkan dengan `!==`.
- CSP helmet default (helmet 8.2.0 lewat `app.ts:25`): `script-src 'self'`, `script-src-attr 'none'`, `style-src 'self' https: 'unsafe-inline'`, `img-src 'self' data:`. Skrip inline dan atribut `onclick=` diblokir; gaya inline dan gambar `data:` diizinkan.

Akibat untuk Agent Floor:

1. Handler halaman Agent Floor harus ikut memasang cookie yang sama; kalau tidak, membuka halaman itu langsung membuat SSE ditolak 401.
2. Cookie berumur 1 jam. Halaman yang dibiarkan terbuka lebih lama akan gagal menyambung ulang SSE sampai dimuat ulang. Ini perilaku yang sudah ada dan bertabrakan dengan NFR "mencoba tersambung kembali".
3. Seluruh skrip prototype harus dipindah ke file eksternal, dan handler inline diganti `addEventListener`.

Usulan (butuh keputusan Ganjar):

| Hal | Usulan | Alasan |
|---|---|---|
| Path halaman | `/dashboard/agent-floor` | Tetap halaman dan rute tersendiri, tetapi berada di bawah prefix yang menurut `docs/dashboard.md:41-43` sudah di-proxy. Alternatif `/agent-floor` butuh aturan proxy baru. Konfigurasi proxy VPS tidak ada di repo, jadi ini belum bisa saya pastikan. |
| Aset | `/dashboard/agent-floor/app.css`, `render.js`, `adapter.js`, `demo.js` | Memisahkan render dari adapter data sesuai NFR. Logo memakai `/dashboard/logo.png` yang sudah ada. |
| Lokasi file | `src/presentation/web/ui/agent-floor/` | Sejajar dengan file dashboard yang ada. |
| Rute | `src/presentation/web/routes/agent-floor-ui.ts`, didaftarkan di `app.ts` setelah `dashboardUiRoutes` | Pola yang sama: guard `dashboard.enabled`, `registerDashboardBasicAuth`, hook `onRequest`. |
| Mode demo | `/dashboard/agent-floor?demo=1` | Satu parameter, tanpa akses DB. |
| Data | Endpoint baca baru di bawah `/api/pipelines/...` | Tercakup `Path=/api` cookie dan aturan proxy `/api/pipelines*` yang ada. |

## 6. Gate yang habis

Ketiga gate mencatat hal yang sama di `pipeline_runs`: `final_status = NEEDS_HUMAN` (`use-case.ts:839`). Dari `final_status` saja, "QA habis" dan "implementasi habis" **tidak** bisa dibedakan.

Pembedanya ada di `agent_events`: event `gate_exhausted` terakhir membawa `agent_name` (`implementation-agents` / `caf-qa` / `caf-reviewer`) dan `artifact_link` yang menunjuk artifact gate tersebut (`:826-838`). Terbukti di data nyata: `CDR-43` berakhir dengan `implementation-agents` + `verify-report.md`, `GAN-57` dengan `caf-qa` + `qa-report.md`.

Keterbatasan: lima jalur `NEEDS_HUMAN` lain (daftar di bagian 1) tidak menulis event apa pun. Run seperti itu tampil `NEEDS_HUMAN` tanpa keterangan penyebab, dan UI tidak boleh menebaknya sebagai gate tertentu.

## 7. Multi-repo

- `repo_id` = `owner/repo`, diturunkan dari `repoCloneUrl` project (`pipeline-instrumentation.ts:26-29`, dipanggil di `use-case.ts:241`).
- Nilai nyata di DB: `ganjardbc/umkm-pos` (prefix tiket `GAN`) dan `ganjardbc/coderium-web-v2` (prefix `CDR`).
- `GET /api/pipelines?repoId=` memfilter di server (`pipelines.ts:90-94`). Detail memakai `:repoId` yang di-percent-encode (`:96-108`).
- Event SSE membawa `repoId`; penyaringan hanya bisa di klien.
- Tidak ada endpoint daftar repo. Dashboard menyusun pilihan repo dari run yang sudah termuat (`dashboard.js:145-149`), jadi repo tanpa run tidak muncul.
- Daftar run dibatasi 50 terbaru; rute tidak meneruskan parameter paginasi (`pipeline-run.repository.ts:164`, `pipelines.ts:93`).
- Satu baris per pasangan repo + tiket. Tiket yang dijalankan ulang menimpa status barisnya dan menambah event ke riwayat yang sama.

`db.path` di VPS: di repo, kedua service Docker memasang volume yang sama ke `/app/data` (`docker-compose.yml:34-38`, `:63`; `Dockerfile:68-72`), sehingga path relatif `./data/caf-dashboard.sqlite` mengarah ke file yang sama untuk web dan worker. Konfigurasi yang benar-benar berjalan di VPS tidak bisa saya periksa dari sini.

## 8. Script dan baseline

Package manager: pnpm. Script yang ada di `package.json`: `typecheck` (`tsc --noEmit`), `lint` (`eslint src --ext .ts`), `test` (`vitest run`), `build` (`tsc`). Keempat script quality gate tersedia; tidak ada gap infrastruktur.

| Gate | Hasil pada `a1d1ab3` |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS (hanya peringatan `MODULE_TYPELESS_PACKAGE_JSON` yang sudah lama ada) |
| `pnpm test` | **FAIL**: 34 file, 357 test; 355 lulus, 2 gagal. Hasil sama pada tiga kali jalan. |
| `pnpm build` | Tidak dijalankan (menulis `dist/`; Fase A read-only). |

Dua test yang gagal ada di `tests/unit/events-route.test.ts`:

- "delivers a broadcast event, tagged with the right repoId, to every connected client independently" (timeout)
- "stops the broadcaster from writing to a client after it disconnects" (`expected 0 to be greater than or equal to 1`)

Test tersebut menyambung dengan header `Authorization: Basic` (`events-route.test.ts:17-23`), sedangkan rute sejak commit `b521860` memeriksa cookie (`events.ts:19-36`). Ketidakcocokan itu konsisten dengan kedua kegagalan; saya belum membuktikannya dengan memperbaiki test.

Baseline di `tasks.md` ("35 file, 347 test") sudah tidak berlaku. Angka sekarang 34 file dan 357 test.

## Daftar gap

| # | Gap | Dampak | Butuh T1? |
|---|---|---|---|
| G1 | Token tidak disimpan | Panel Detail agent (FR-4) tidak bisa menampilkan token | Ya |
| G2 | Nomor PR tidak disimpan | `run_finished.prNumber` kosong; visual "dokumen ke kotak PR" tanpa nomor | Ya |
| G3 | Percobaan verify internal (n/3) dan `checks` tidak terlihat orchestrator | Baris FR-2 "Ulang n/3" dan "tiga bar lint/typecheck/test" tidak punya data nyata | Keputusan Ganjar |
| G4 | Tidak ada batas antar-attempt | Replay run yang pernah diulang memutar semua attempt sebagai satu rangkaian | Ya |
| G5 | Hasil per agent run tidak disimpan | Agent yang menyebabkan `ERROR` tidak bisa ditunjuk; status `step` hanya tebakan | Ya |
| G6 | `NEEDS_HUMAN` non-gate tanpa keterangan | UI tidak bisa menjelaskan penyebab | Opsional |
| G7 | `started_at` tidak diperbarui saat attempt baru | Durasi run yang diulang salah | Ya (kecil) |
| G8 | SSE hanya sinyal, tanpa `id`, tanpa filter | Kontrak bagian 7 harus dipenuhi di T3 | Bukan T1 (T3) |
| G9 | Handoff tidak dicatat | Harus diturunkan di normalizer | Bukan T1 (T2) |
| G10 | Cookie SSE hanya dipasang `/dashboard`, kedaluwarsa 1 jam | Agent Floor 401 bila dibuka langsung; putus setelah 1 jam | Bukan T1 (T3/T4) |
| G11 | 2 test gagal di `main` | Gate "jumlah test tidak turun" tidak punya baseline hijau | Keputusan Ganjar |
| G12 | `agent-floor.prototype.html` tidak ada di repo | T4 terblokir; kontrak belum bisa dicocokkan dengan tanda tangan fungsi prototype | Butuh file dari Ganjar |

## Rekomendasi T1

T1 diperlukan. Bentuk minimal yang saya usulkan, seluruhnya aditif dan tidak menyentuh alur retry, `report-reader.ts`, atau `caf-documentation`:

1. Kolom nullable baru di `agent_events`: `input_tokens`, `output_tokens` (G1), dan satu kolom hasil agent run, misalnya `exit_code` (G5).
2. Kolom nullable baru di `pipeline_runs`: `pr_number` (G2), ditulis setelah PR dibuat.
3. Penanda attempt (G4, G7): satu kolom `attempt` di `agent_events`, atau memperbarui `started_at` dan mencatat nomor attempt di `pipeline_runs`. Pilihan ini butuh keputusan karena menentukan arti "run" pada replay.
4. Migrasi lewat `ALTER TABLE ADD COLUMN` yang dijaga (cek kolom dulu), karena mekanisme sekarang hanya `CREATE IF NOT EXISTS`.

Yang saya sarankan dihindari: menambah nilai `event_type` atau `piv_phase` baru. Keduanya dikunci `CHECK`, sehingga perubahan butuh membangun ulang tabel pada DB produksi yang sudah berisi data.

Untuk T3, usulan saya: pertahankan SSE sebagai sinyal, dan sajikan event ber-kontrak dari endpoint baca yang menjalankan normalizer T2 di server dengan kursor `agent_events.id`. Jalur live dan replay lalu memakai kode yang sama, dan sambung ulang tidak menggandakan event karena klien meminta "setelah id terakhir". Alternatifnya, mengirim event ber-kontrak langsung lewat SSE, butuh `id:` dan penanganan `Last-Event-ID` di server.

## Keputusan yang dibutuhkan sebelum Fase B

1. **G3:** percobaan verify n/3 dan bar lint/typecheck/test tidak punya sumber data. Pilihannya: (a) tampilkan hanya di mode demo dan hilangkan dari live/replay, atau (b) cari sumbernya di `verify-report.md` repo target, yang berarti pembaca baru dan bergantung pada format laporan agent yang belum saya lihat.
2. **G4:** arti "run" untuk replay: satu attempt, atau seluruh riwayat tiket.
3. **G11:** dua test gagal diperbaiki dulu sebagai pekerjaan terpisah, atau baseline ditetapkan "355 lulus, 2 gagal yang sudah diketahui".
4. **Path rute:** `/dashboard/agent-floor` atau `/agent-floor`.
5. **Bentuk T3:** endpoint baca berkursor dengan SSE sebagai sinyal, atau event ber-kontrak langsung di SSE.
6. **G12:** file prototype perlu ditaruh di `.ai/tasks/CAF-DASHBOARD-02/`.
7. Cakupan T1: setuju dengan butir 1-4 di atas, atau dikurangi.
