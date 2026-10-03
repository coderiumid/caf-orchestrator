# Verify Report: CAF-DASHBOARD-02 (Agent Floor)

Status: SUCCESS

Mencakup Fase A (T0), Fase B (T1, T2, T3), Fase C (T4, T5, T6), dan Fase D (T7, T8). Fase E (T9, e2e nyata) belum dikerjakan dan butuh konfirmasi eksplisit.
Tidak ada pipeline yang dipicu, tidak ada commit, tidak ada push.

## Baseline

Ditetapkan 2026-10-04 pada `a1d1ab3`, setelah perbaikan test terpisah di bawah dan sebelum T1:
**34 file, 358 test, semua lulus.** Angka "35 file, 347 test" dari DASHBOARD-01 sudah tidak berlaku.

### Pekerjaan terpisah: 2 test merah di `tests/unit/events-route.test.ts`

Bukan bagian DASHBOARD-02. Commit `b521860` ("fix: authenticate dashboard SSE with cookie") tidak punya
isi pesan, tetapi judulnya dan komentar di kode yang ditambahkannya ("EventSource cannot set an
Authorization header...") menunjukkan auth cookie disengaja. Jadi test yang diperbarui, bukan kodenya:
test kini menyambung dengan cookie, dan ditambah satu kasus bahwa cookie salah maupun header Basic
tanpa cookie ditolak 401.

## T0 Audit data

Hasil di `audit.md`. Read-only.

## T1 Instrumentasi minimal

Semua aditif, kolom nullable, lewat `ALTER TABLE ADD COLUMN` yang dijaga (`connection.ts`). Tidak ada
nilai `event_type` / `piv_phase` baru; `CHECK` tetap berlaku (ada test-nya).

| Kebutuhan | Perubahan |
|---|---|
| Penanda attempt | `pipeline_runs.attempt` (1, naik tiap run dimulai lagi) dan `agent_events.attempt` (attempt saat baris ditulis) |
| Hasil agent run | `agent_events.exit_code`, `agent_events.outcome` (`OK` / `FAILED` / `KILLED` / `TIMEOUT`) pada event `end` |
| Nomor PR | `pipeline_runs.pr_number`, ditulis setelah PR final dibuat dan setelah Draft PR gate dibuat/diperbarui |
| Verify n/3 dan checks (keputusan 1) | `agent_events.verify_details` (JSON) pada event `end` agent implementasi, dari parser toleran baru `verify-report-details.ts` |

Titik sentuh di `run-agent-pipeline.use-case.ts`: 7 baris baru, 4 baris diubah. Empat panggilan
`recordAgentEnd` kini meneruskan hasil run (bukan hanya stdout), dua panggilan `recordPullRequest`
ditambah, dan satu pembacaan `verify-report.md` setelah agent implementasi selesai.

Tidak disentuh: loop retry (`qaRetryCount`, `reviewerRetryCount`), `queue.jobAttempts`, `report-reader.ts`
(tidak ada diff), dan `caf-documentation` (tetap tanpa event).

Catatan parser verify: format dicocokkan dengan `verify-report.md` nyata di checkout lokal `umkm-pos` dan
`coderium-web-v2`. Hasil lint/typecheck/test terbaca dari checklist. Nomor percobaan hampir tidak pernah
ditulis agent di laporan nyata, jadi `attempt` akan sering `null` sampai template laporan agent di repo
target mencantumkannya.

## T2 Normalizer event

`src/presentation/web/agent-floor/event-normalizer.ts`: fungsi murni `normalizeRun(run, rows, options)`.
Dipakai jalur live dan replay. Diverifikasi juga terhadap salinan DB lokal: ketujuh run nyata
menghasilkan urutan dengan kursor naik ketat.

Penyimpangan dari kontrak usulan di `requirements.md` bagian 7, keduanya demi hasil live = replay:

- `run_finished` tidak membawa `prNumber`. PR dicatat pipeline setelah run difinalisasi, sehingga klien
  live akan melihat event itu tanpa nomor dan replay melihatnya dengan nomor. Nomor PR dikirim lewat
  event `step` untuk `pr` yang menyusul.
- `usage.tokens` selalu `null` (token ditunda sesuai keputusan 6).

Keterbatasan yang diketahui:

- Status akhir attempt yang sudah digantikan tidak tersimpan (`pipeline_runs` hanya menyimpan status
  attempt terakhir). Attempt lama dilaporkan `NEEDS_HUMAN` hanya bila ada baris `gate_exhausted`;
  selain itu `finalStatus: null` dengan `superseded: true`.
- Baris sebelum T1 tidak punya penanda attempt dan dihitung sebagai attempt 1.
- `started_at` tidak diperbarui saat attempt baru (di luar cakupan T1). Waktu mulai attempt ke-2 dst.
  diambil dari baris pertamanya.
- Handoff diturunkan dari urutan agent, bukan dicatat pipeline.

## T3 Endpoint baca berkursor

- `GET /api/pipelines/:repoId/:ticketId/floor-events?after=<cursor>` di `routes/pipelines.ts`, basic auth
  yang sama. Mengembalikan `{ run, events, nextCursor }`. SSE tetap hanya sinyal.
- Kursor berbentuk `<agent_events.id>.<sub>`: id baris ditambah sub-indeks, karena satu baris
  menghasilkan beberapa event dan awal/akhir attempt tidak punya baris sendiri.
- Cookie SSE: pembuatnya dipindah ke `auth/dashboard-auth-cookie.ts`, dipakai `/dashboard` dan stream.
  Stream kini memperbarui cookie di setiap sambungan yang berhasil.
- `GET /api/pipelines*` menambah field `attempt` dan `prNumber` (aditif).

Sisa keputusan 4 (rute halaman yang memasang cookie, muat ulang saat 401) dikerjakan di T4/T5.

## T4 Port render dari prototype

Halaman terpisah di `/dashboard/agent-floor`, basic auth yang sama, memasang cookie SSE yang sama dengan
`/dashboard`. File statis di `src/presentation/web/ui/agent-floor/`, tanpa build step:

| File | Isi |
|---|---|
| `agent-floor.html`, `agent-floor.css` | Markup dan gaya prototype. Tanpa skrip inline (CSP `script-src 'self'`). |
| `render.js` | Dunia, sprite, canvas, panel. Kode gambar disalin apa adanya dari prototype. Tidak pernah mengambil data. |
| `demo.js` | Kelima skenario mock, dipindah (bukan dihapus), kini lewat API publik. Aktif dengan `?demo=1`. |
| `translate.js` | Fungsi murni: event ber-kontrak menjadi panggilan API publik. |
| `adapter.js` | Satu-satunya yang berbicara dengan server, hanya GET. |

API publik `window.AgentFloor`: `setState`, `say`, `sendDoc`, `step`, `setStatus`, `log` dipertahankan.
Ditambah empat pintu masuk yang di prototype dilakukan dengan mengubah variabel internal secara
langsung: `reset` dan `setRun` (untuk `run_started`), `usage` (panel Detail agent), `checks` (bar verify
demo). Sisanya (`wait`, `ready`, `later`, `fire`, `celebrate`) adalah pengatur waktu animasi, bukan data.

Lain-lain: logo base64 diganti `/dashboard/logo.png`; tautan "Agent Floor" ditambah di header dashboard;
satu baris `COPY` direktori ditambah di `Dockerfile`.

## T5 Adapter live

- Daftar run dari `GET /api/pipelines`, pemilih repo (tanpa opsi "semua", pilihan disimpan di `?repo=`).
- Tanpa pilihan manual, kantor mengikuti run `RUNNING` di repo terpilih. Tanpa run aktif: semua di
  pantry, Docs off duty.
- SSE hanya sinyal; setiap sinyal dijawab dengan `floor-events?after=<kursor>`. Saat SSE tersambung
  kembali, daftar run dan event diambil ulang dari kursor terakhir.
- Status koneksi "Terhubung" / "Terputus, mencoba lagi" (`role="status"`).
- 401 dari API atau dari stream memuat ulang halaman, paling banyak sekali per 30 detik.
- Biaya dan durasi dari data nyata. Token tampil "tidak dicatat" (ditunda di keputusan 6).
- Live tanpa bar verify; hasil verify muncul di log dan di "Percobaan verify" setelah agent selesai.

## T6 Replay

Klik run yang sudah selesai memutar ulang event yang sama dari endpoint yang sama, dari awal. Jarak
waktu nyata dipadatkan 30x (batas 0,35 sampai 3,5 detik per event). Tombol Jeda dan 1x/2x/4x bekerja
lewat waktu simulasi render. Read-only: adapter hanya GET (ada test statis) dan endpoint tidak menulis
(ada test yang membandingkan isi kedua tabel sebelum dan sesudah).

## Verifikasi di browser (Fase C)

Dijalankan terhadap server pratinjau sementara di luar repo: hanya rute dashboard, helmet/CSP yang
sama, **salinan** DB lokal, tanpa rute webhook, tanpa queue, tanpa worker. DB asli di `data/` tidak
disentuh.

- Demo: halaman tampil, 5 skenario, lencana "Data contoh", tidak ada request ke `/api/`, tidak ada
  error console, tidak ada scroll window pada 1440x900.
- Live tanpa run: "Tidak ada run aktif", semua agent di pantry, "Terhubung".
- Replay `GAN-57` (run nyata): urutan plan, implement, QA, retry gate QA 1/1 dengan biaya dan durasi nyata.
- Live: run simulasi ditulis ke DB salinan baris demi baris. Halaman mengikuti otomatis, tiap kejadian
  muncul sekali, berakhir `SUCCESS` dengan `PR #321`, Docs tetap off duty.

Batas verifikasi ini:

- Tab pengujian berada di latar belakang, sehingga `requestAnimationFrame` tidak berjalan. Animasi
  digerakkan lewat pengganti `requestAnimationFrame` yang saya suntikkan. Logika dan DOM terverifikasi;
  **kehalusan animasi dan kemiripan visual dengan prototype belum dilihat mata manusia**.
- Di tengah sesi, tab itu dua kali berpindah keadaan tanpa saya picu (membuka run lain, lalu kembali
  ke URL tanpa `?repo`). Penyebabnya tidak saya temukan dan tidak terulang pada pengujian terakhir.
- Dua perubahan kecil dibuat setelah pengujian browser dan belum dilihat ulang di browser: warna teks
  tautan header (`a.btn`) dan `catch{}` di `adapter.js` (perbaikan lint).
- Perbandingan sisi-ke-sisi dengan file prototype tidak dilakukan.

## T7 Aksesibilitas dan performa

Perubahan:

- **Dijeda tetap jujur.** Pengguna `prefers-reduced-motion` mulai dalam keadaan jeda (dari prototype).
  Sebelumnya data live ikut tertahan karena menunggu waktu simulasi. Kini jeda antar event live memakai
  waktu nyata, agent yang berganti state saat dijeda langsung berada di tujuannya, dan dokumen terbang
  dilewati. Replay tetap ikut Jeda dan kecepatan.
- **Keyboard.** Daftar status agent dan daftar run adalah `<button>`; tab Kejadian/Detail mengikuti pola
  tab WAI-ARIA (panah kiri/kanan, hanya tab aktif di urutan Tab); tombol Jeda membawa `aria-pressed`.
- **Screen reader.** `role="log"` + `aria-live` pada log, `aria-live` pada status run, `role="status"`
  pada status koneksi, `role="img"` berlabel pada canvas, `aria-label` pada tablist.
- **Kontras** (dihitung dari token warna, terhadap latar halaman): tema terang 4,85 sampai 19,4; tema
  gelap 7,3 sampai 16,9. Semua di atas 4,5 (WCAG AA untuk teks normal).

Performa:

- Tidak ada polling. Seluruh skrip tidak memakai `setInterval`; `setTimeout` hanya dua, keduanya di
  `adapter.js` (debounce daftar run 300 ms, jeda antar event live). Jalur per frame (`render.js`) tidak
  pernah menyentuh jaringan. Dijaga test statis.
- Biaya satu frame penuh (gambar canvas + pembaruan DOM, 7 karakter, canvas 1442x1082 pada DPR 2),
  diukur selama skenario demo berjalan: **0,11 sampai 0,37 ms per frame**, rata-rata per 150 frame.
  Anggaran 60 fps adalah 16,7 ms.

Yang **tidak** terukur:

- **Frame rate nyata.** Tab uji selalu berstatus `hidden`, sehingga `requestAnimationFrame` asli tidak
  berjalan (terukur 0 fps). Angka di atas adalah biaya kerja per frame, bukan fps di layar.
- **Tanpa scroll window pada ukuran selain 1395x923.** Perintah ubah ukuran jendela tidak berpengaruh
  pada tab uji. Pada ukuran itu tidak ada scroll window dan tiga panel scroll di dalam. Untuk ukuran
  lain hanya ada penjaga di tingkat CSS (grid tinggi tetap, `overflow:auto` di panel).
- **Perilaku saat dijeda di browser.** Hanya dijaga test statis.

Catatan harness: cara saya menggerakkan animasi di tab tersembunyi (memuat ulang skrip halaman dengan
`requestAnimationFrame` pengganti) menyisakan dua instance skrip yang berebut satu DOM. Tangkapan layar
terakhir menunjukkan gejalanya (canvas hitam, angka panel tidak sinkron). Perpindahan keadaan tak
terjelaskan di Fase C kemungkinan besar berasal dari sebab yang sama, tetapi itu belum saya buktikan.
Halaman yang dimuat biasa hanya punya satu instance.

## T8 Dokumentasi

`docs/dashboard.md` dilengkapi (bukan diganti) dengan bagian "Agent Floor": rute dan catatan proxy, tiga
mode, cara membaca kantor, alur data dan kontrak event, kolom baru, cara menambah state agent, dan
perilaku saat "Terputus". Tercantum eksplisit: `caf-documentation` sengaja off duty, dan kontrak parser
(`Status: SUCCESS` untuk `verify-report.md`, `Status: PASS` untuk `qa-report.md`) serta alur retry tidak
disentuh.

Atas instruksi Ganjar (2026-10-04), dokumen DASHBOARD-01 ikut diperbarui: `verify-report.md`-nya kini
`Status: SUCCESS` dengan catatan pembaruan di bagian atas (isi asli dipertahankan), dan bagian "Known
limitation (as of Task 7)" di `docs/dashboard.md` diganti "End-to-end verification". Keduanya mencatat
apa yang tidak tercatat di data: pengamatan live, dan dua repo berbeda yang berjalan bersamaan.

## Perubahan setelah review Ganjar: agent duduk di meja (2026-10-04)

Permintaan Ganjar: perubahan state terlalu cepat untuk diikuti karakter yang berjalan, jadi agent tetap
duduk di mejanya. Ini menggantikan perilaku prototype (berjalan antara pantry dan meja) dan baris FR-2
"semua agent di pantry".

- Setiap agent punya tempat tetap. Kode pergerakan (`goTo`, `stepAgent`, posisi pantry) dihapus dari
  `render.js`.
- Bekerja: mengetik membelakangi kita, sandaran kursi terlihat. Idle: menghadap depan, memegang cangkir
  dan menyeruput kopi kira-kira tiap 3 detik (fase berbeda per agent).
- Pantry disesuaikan untuk Docs: sofa dipindah ke tengah dan Docs duduk di sana dengan mata terpejam,
  tanpa meja kerja; ditambah meja kopi dan kulkas. Docs tetap off duty.
- API publik, `translate.js`, `adapter.js`, dan `demo.js` tidak berubah. `ready()` kini langsung selesai.
- Teks "Arti animasi" dan `docs/dashboard.md` disesuaikan.

Dilihat di browser (tab terlihat, satu instance skrip, frame digerakkan lewat shim di server
pratinjau): keadaan idle live, skenario demo "Berjalan lancar" sampai selesai, tanpa error console.

## Perubahan setelah review Ganjar: bahasa Inggris dan satu ruangan (2026-10-04)

- **Bahasa Inggris.** Semua teks UI Agent Floor, plus komentar kode dan CSS di `ui/agent-floor/`.
  Ada test yang menjaga tidak ada teks Indonesia tersisa.
- **Satu ruangan open-plan.** Enam zona berdinding dan koridor dihapus. Enam meja dirapatkan jadi satu
  pod 3 x 2 menghadap dinding belakang: Planner, Backend, Frontend di depan; QA, Reviewer, Ganjar di
  belakang. Docs di sofa sudut lounge. Dinding belakang: papan tulis, poster, rak server, jendela,
  kulkas, meja kopi, jam. Ditambah meja rapat; kotak PR di kanan bawah.
- Posisi yang digambar dua kali (latar statis dan bagian animasinya) kini diambil dari satu konstanta
  (`BOARD`, `RACK`, `COUNTER`, `PRBOX`), jadi tidak bisa bergeser sendiri-sendiri.

Dilihat di browser (tab terlihat, mode demo): skenario "Smooth run" dan "QA rejects once" sampai
selesai, tanpa error console. Label "Done, PR ready for review" tidak terpotong. Mode live dan tema
terang belum dilihat dengan tata letak baru.

## Quality Gate

- `pnpm typecheck` — PASS
- `pnpm lint` — PASS (hanya peringatan lama `MODULE_TYPELESS_PACKAGE_JSON`)
- `pnpm test` — PASS, 40 file / 448 test (baseline 34 / 358)
- `pnpm build` — PASS

Test baru sejak baseline (90): `verify-report-details` (10), `db-migration` (4),
`agent-floor-event-normalizer` (26), `agent-floor-events-route` (6), `agent-floor-ui` (18, termasuk 7 penjaga T7),
`agent-floor-translate` (16), tambahan di `pipeline-run.repository` (4),
`pipeline-instrumentation-integration` (4), `events-route` (1), `dashboard-ui` (1).
Regresi jalur retry: test QA/Reviewer retry dan gate yang sudah ada di
`run-agent-pipeline.use-case.test.ts` lulus tanpa diubah.

Percobaan verify: T1 sampai T3 lulus pada percobaan 1; Fase C lulus pada percobaan 2 (percobaan 1 gagal lint: tiga variabel `catch` tak terpakai di `adapter.js`); Fase D lulus pada percobaan 1.

## DB lokal `data/caf-dashboard.sqlite`

Pukul 01:11:15 (2026-10-04) file WAL DB lokal berubah: keenam kolom T1 ditambahkan. Isi baris tidak
berubah (tetap 7 run, 67 event). Ini bukan dari pekerjaan saya: `pnpm typecheck` / `lint` / `test` /
`build` terbukti tidak menyentuh file itu (diulang, cap waktu tidak bergerak), dan server pratinjau saya
memakai salinan di luar repo pada port 3999. Pada jam yang sama ada proses `tsx` yang mulai berjalan dari
repo ini di terminal lain dan mendengarkan port 3030, yaitu server web aplikasi; migrasi otomatis
berjalan saat ia membuka DB dengan kode working tree. Kolomnya nullable dan aditif, jadi kode lama tetap
bisa membaca DB tersebut.

Server itu memuat file statis saat start (01:11), sebelum perubahan T7 (01:13). Perlu di-restart untuk
melihat perilaku T7.

## Belum diverifikasi

- Migrasi terhadap DB produksi di VPS. Diuji pada DB skema lama buatan test dan pada salinan DB lokal.
- Perilaku nyata browser untuk perpanjangan cookie lewat respons SSE. Diuji di tingkat header HTTP saja.
