# CAF-DASHBOARD-03: Audit (T0)

Read-only. Dasar untuk T1–T6.

## A. Jalur keluar `RunPrReviewUseCase.execute()`

| Jalur | Terjadi di | `final_status` | `review_result` |
|---|---|---|---|
| Head branch bukan `ai-agent/<KEY>` | `extractTicketKey`, sebelum workspace dibuat | tidak dicatat (tidak ada ticket key) | — |
| Mode `initial` selesai | `postInitialReview` | `SUCCESS` | `{type: verdict, verdict, postedAsComment: false}` |
| Mode `initial`, self-review 422 → fallback `COMMENT` | `postInitialReview` | `SUCCESS` | `{type: verdict, verdict, postedAsComment: true}` |
| Mode `global`/`scoped` selesai | `postFixReview` | `SUCCESS` | `{type: fix, fixed, skipped, notApplicable}` |
| Agent exit non-zero / killed / timeout | setelah `agentRunner.run` | `ERROR` | kosong |
| `review-notes.md` / `fix-review-log.md` tidak ada, Verdict tidak dikenali | reader | `ERROR` | kosong |
| GitHub API gagal (selain 422 self-review) | posting | `ERROR` | kosong |

Semua jalur gagal sudah melempar lewat satu `catch`, jadi satu titik finalisasi `ERROR` cukup. Hasil untuk FR-2 sudah ada di memori saat posting (Verdict dari `readInitialReviewReport`, entri dari `readFixReviewLog`) — tidak perlu membaca ulang artifact.

Mode fix: use case tidak melakukan commit/push sendiri; hanya membaca `fix-review-log.md`, membalas comment, dan memposting ringkasan. Tidak ada langkah PR baru untuk divisualkan.

## B. Asumsi "satu baris per (repo, ticket)"

| Tempat | Asumsi | Perubahan |
|---|---|---|
| `schema.sql` — unique index `idx_pipeline_runs_repo_ticket` | semua baris unik per repo+ticket | jadi partial index, hanya baris pipeline |
| `pipelineRunId(repoId, ticketId)` | id = `repo:ticket` | tetap untuk pipeline; review pakai `pr-review:<jobId>` |
| `getPipelineDetail(repoId, ticketId)` | `SELECT ... WHERE repo_id AND ticket_id` mengembalikan satu baris | difilter ke baris pipeline; tambah `getRunById` |
| `GET /api/pipelines/:repoId/:ticketId[/floor-events]` | repo+ticket mengidentifikasi run | tetap = run pipeline; tambah `/api/pipelines/by-run/:runId[...]` |
| `dashboard.js` — `selected = repo|ticket` | kunci pilihan | jadi `runId` |
| `adapter.js` — `isCurrent`, `eventsUrl` | kunci run = repo+ticket | jadi `runId`; URL dipilih dari `kind` |
| Sinyal SSE `{repoId, ticketId}` | cukup untuk memicu refetch | tidak diubah: polling berbasis cursor, sinyal berlebih tidak berbahaya |

## C. Migrasi index

`schema.sql` dijalankan sebelum `ALTER TABLE ADD COLUMN`, jadi partial index yang merujuk `kind` tidak bisa dibuat di sana pada DB lama. Index dipindah ke `connection.ts`, dijalankan setelah kolom ditambah:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_repo_ticket_pipeline
  ON pipeline_runs (repo_id, ticket_id) WHERE kind IS NULL OR kind = 'pipeline';
DROP INDEX IF EXISTS idx_pipeline_runs_repo_ticket;
```

Keduanya idempoten dan aman bila web server dan worker bermigrasi bersamaan. Tidak ada rebuild tabel: review memakai `piv_phase = 'verify'` dan `event_type` `start`/`end` yang sudah lolos CHECK.

## D. Asumsi "run = plan → impl → qa → review → pr" di UI

| Tempat | Asumsi | Perubahan |
|---|---|---|
| `event-normalizer.ts` `normalizeRun` | handoff dan step diturunkan dari urutan agent pipeline | cabang `normalizeReviewRun` terpisah; jalur pipeline tidak disentuh |
| `render.js` `STEPS` | daftar 5 tahap tetap | `setSteps()` + dikembalikan saat reset |
| `render.js` `PILL.success` | teks "Done, PR ready for review" | `setStatus(k, text)` opsional |
| `translate.js` `run_started` / `run_finished` | teks pipeline | cabang untuk `kind: pr-review` / `review` |
| `dashboard.js` `phaseRail` | rail Plan / Implement / Verify | rail satu tahap + hasil untuk review |

## E. Kontrak data (requirements bagian 7)

Dikonfirmasi tanpa perubahan struktur. Rincian yang ditetapkan di sini: `kind` disimpan `NULL` untuk pipeline (tulis pipeline tidak berubah sama sekali) dan `pr-review` untuk review; judul run review dipinjam dari run pipeline tiket itu bila ada, kalau tidak `PR #<n>`.

## F. Temuan di luar scope

- `tests/unit/run-pr-review.use-case.test.ts` tidak me-mock `config`. Begitu use case ter-instrument, test itu menulis ke `db.path` asli. Ditangani di T2 dengan me-mock `pipeline-instrumentation.js` di file itu.
- `/caf-review` dicocokkan dengan `startsWith`, jadi `/caf-review-fix`, `/caf-reviewer`, dst. ikut terpicu sebagai review `initial`. Tidak diubah (non-goal ticket ini).
