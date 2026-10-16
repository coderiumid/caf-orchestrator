# CAF-SDD-04d — Perbaikan pasca-04b/04c orchestrator

Status: APPROVED
Repo: caf-orchestrator (main 998561e, setelah merge 04c)

## Outcomes
- Repo campuran (planner baru + `caf-qa`, kasus umkm-pos) tidak lagi berhenti di Q-1 pada setiap run.
- Spec yang masih punya pertanyaan BLOCKING tanpa jawaban selalu berhenti di Clarify, dengan atau tanpa label gerbang.
- PR yang sebelumnya Draft (spec atau gate) menjadi Ready for review saat run akhirnya sukses.
- Command yang ditolak (`/caf-approve-spec`, retry, trigger saat menunggu approval) tidak mengubah baris dashboard ticket.
- Perilaku 04b/04c yang sudah diputuskan didokumentasikan.

## Scope
In:
- `run-agent-pipeline.use-case.ts`: pembuatan `acSummary`/Q-1, `stopForSpecIfNeeded`, jalur sukses PR, penempatan `recordPipelineStarted`/`finalizePipelineRun` pada jalur ditolak.
- Port `IVcsClient` + `GithubService`: satu method baru untuk menandai PR Ready for review.
- Test baru/penyesuaian, `CLAUDE.md`, `README.md`.

Out:
- Pengumpulan jawaban Clarify (komentar status orchestrator yang ikut terbaca sebagai jawaban). Bersyarat dari smoke test, bukan 04d.
- Routing `caf-implementer`, `caf-architect`, dan perubahan skema config.
- Perubahan format laporan agent atau parser `ac-summary.ts`.

## Findings (dari kode, main 998561e)
- F-1: `acSummary` dibuat dari laporan gate apa pun bila `qaReportFile !== undefined` (`run-agent-pipeline.use-case.ts`, blok "CAF-SDD-04b"). `caf-qa` tidak menulis tabel per AC, jadi untuk repo yang `requirements.md`-nya punya baris `AC-n` semua AC terbaca UNVERIFIED dan Q-1 menghentikan run walau `Status: PASS`.
- F-2: Gate dipilih oleh `resolveValidationGate()`: `VALIDATOR_GATE` bila ada `.claude/agents/caf-validator.md`, selain itu `QA_GATE`. Ringkasan yang sama dipakai di body PR sukses, Draft PR gate validasi, dan Draft PR gate reviewer lewat `acSummaryText`.
- F-3: `stopForSpecIfNeeded` berhenti untuk `NEEDS_CLARIFICATION` (selalu) dan `DRAFT` hanya bila `isSpecGated(job)`. `DRAFT` dengan BLOCKING tanpa Answer dan tanpa label lanjut ke implementasi.
- F-4: `execute()` memanggil `recordPipelineStarted` untuk setiap job sebelum cabang retry/approve. `upsertPipelineRun` mengosongkan `ended_at`/`final_status`, menambah `attempt`, dan menghapus `review_result`. Jalur ditolak lalu memanggil `finalizePipelineRun(..., 'NEEDS_HUMAN')`: branch tidak ada, workspace kotor, menunggu `spec-approval`, dan semua `reject()` di `approveSpecAndReadTasks`. Baris ticket yang sudah `SUCCESS` jadi `NEEDS_HUMAN` dengan `attempt` naik.
- F-5: Jalur sukses memakai `findOpenPullRequestByHead` + `updatePullRequest` untuk run lanjutan (`isRetry`/`approveSpec`). `updatePullRequest` hanya PATCH `body`; PR Draft dari gate/spec tetap Draft. `IVcsClient` tidak punya method mengubah status draft.
- F-6: `run-agent-pipeline.ac-summary.sdd04b.test.ts` menguji reviewer di jalur sukses/gate validasi; belum ada test yang memeriksa body Draft PR gate reviewer memuat ringkasan AC.

## Assumptions
- A-1: `GithubService` punya `config.github.apiUrl` (default `https://api.github.com`); endpoint GraphQL turunannya `<origin>/graphql` untuk github.com, dan `<apiUrl>/graphql` untuk host lain (GHES memakai `<host>/api/graphql`). Dasar: skema config. T1 memverifikasi bentuk URL, tidak menebak GHES.
- A-2: Respons REST `GET /repos/{owner}/{repo}/pulls/{n}` memuat `draft` (boolean) dan `node_id`; mutasi GraphQL `markPullRequestReadyForReview(input:{pullRequestId})` dengan `node_id` itu mengubah Draft jadi Ready. Dasar: dokumentasi GitHub, belum dicoba di repo ini. T1 mencatat bila `GITHUB_TOKEN` yang dipakai butuh scope lain; test memakai fixture saja.
- A-3: Test `run-agent-pipeline.*.test.ts` meng-mock `pipeline-instrumentation` dan `vcsClient` sebagai objek; method baru port cukup ditambah ke mock tersebut.
- A-4: `execute()` tidak memerlukan baris dashboard sudah ada untuk jalur yang menolak command; baris hanya diperlukan begitu agent pertama berjalan (`recordAgentEvent`).

## Decisions already made
- D-1: Ringkasan AC dan aturan Q-1 hanya berlaku bila gate adalah `caf-validator` (Ganjar, 15 Okt).
- D-2: `Status: DRAFT` dengan pertanyaan BLOCKING tanpa Answer berhenti di Clarify, apa pun labelnya (Ganjar, 15 Okt).
- D-3: PR spec/gate menjadi Ready for review saat run sukses (Ganjar, 15 Okt).
- D-4: Command yang ditolak tidak mengubah baris dashboard (Ganjar, 15 Okt).
- D-5: Gate yang di-skip Planner tidak mendapat ringkasan dan tidak kena Q-1 (keputusan 04b, tetap).
- D-6: `APPROVED` dengan BLOCKING tanpa Answer tetap lanjut seperti sekarang (tidak diubah di 04d).

## Constraints
- Repo tanpa `caf-validator.md` berperilaku persis seperti sebelum 04b untuk ringkasan/Q-1: tidak ada ringkasan, tidak ada Q-1. Body PR tidak berubah.
- Gate tetap `return` bersih, bukan `throw`. Menandai Ready for review tidak boleh melempar: kegagalannya dicatat dan disebut di komentar ticket, PR tetap Draft. Melempar akan menyerahkan job ke retry BullMQ yang mengulang seluruh pipeline.
- Tidak ada perubahan skema SQLite dan tidak ada migrasi.
- Perilaku yang tidak disebut di AC tidak berubah. Test lama diubah hanya bila kontraknya memang berubah di sini, dan dicatat di `verify-report.md`.

## Open questions
Tidak ada.

## Acceptance criteria
- AC-1: When a ticket run's validation gate is `caf-qa` and `requirements.md` has `AC-n` lines, then the PR body, gate Draft PRs and ticket comments contain no AC summary and no Q-1 stop happens, even when `qa-report.md` has no per-AC table.
  Verify: automated test — `tests/unit/run-agent-pipeline.ac-summary.sdd04b.test.ts` (kasus `caf-qa` + `AC-n` + `Status: PASS` selesai sukses; body PR tanpa blok ringkasan).
- AC-2: When the gate is `caf-validator`, then the summary and Q-1 behave exactly as in 04b (summary at top of PR body; all-UNVERIFIED + `Status: PASS` stops with Draft PR and `NEEDS_HUMAN`).
  Verify: automated test — kasus 04b yang ada untuk validator tetap lulus tanpa perubahan asersi.
- AC-3: When a validator-gate run is stopped by reviewer `CHANGES_REQUESTED` after retry, then the Draft PR body contains the AC summary block above the reviewer artifact.
  Verify: automated test — `run-agent-pipeline.ac-summary.sdd04b.test.ts` kasus baru (menutup F-6).
- AC-4: When a Planner-skipped validation gate or a missing report leaves no gate report, then no summary and no Q-1 apply (tidak berubah).
  Verify: automated test — kasus skip 04b yang ada tetap lulus.
- AC-5: When the planner leaves `Status: DRAFT` with at least one `[BLOCKING]` question without an Answer and the ticket has no spec-gate label, then the pipeline stops as Clarify (`waitingFor: 'clarify'`, comment starts with `❓ CAF-CLARIFY`, branch pushed, `NEEDS_HUMAN`) and no implementation agent runs.
  Verify: automated test — `run-agent-pipeline.spec-gate.sdd04c.test.ts` kasus baru.
- AC-6: When the planner leaves `Status: DRAFT` with an unanswered BLOCKING question and the ticket carries the gate label, then it stops as Clarify, not as spec approval (no Draft PR spec-only is opened).
  Verify: automated test — kasus baru di berkas yang sama.
- AC-7: When `Status: DRAFT` has no unanswered BLOCKING question, then behavior is unchanged: gated → spec approval stop; ungated → continues.
  Verify: automated test — kasus 04c yang ada tetap lulus.
- AC-8: When a resumed run (`isRetry` or `approveSpec`) succeeds and the open PR on `ai-agent/<KEY>` is a Draft, then after the body update the PR is marked Ready for review through a new `IVcsClient` method, and the success comment says so.
  Verify: automated test — kasus baru: `vcsClient.markPullRequestReadyForReview` dipanggil dengan `owner`, `repo`, `prNumber` PR yang diperbarui.
- AC-9: When a first run (no resume) succeeds, then no ready-marking call is made (PR dibuat non-draft).
  Verify: automated test — `markPullRequestReadyForReview` tidak dipanggil.
- AC-10: When marking Ready for review fails (method throws), then the job still ends `SUCCESS`, no throw reaches BullMQ, and the ticket comment says the PR stayed Draft and why.
  Verify: automated test — method di-mock menolak; `finalizePipelineRun(..., 'SUCCESS')`, tidak ada throw, komentar memuat catatan.
- AC-11: When the PR is already non-draft, then `GithubService.markPullRequestReadyForReview` makes no mutation and returns without error.
  Verify: automated test — `tests/unit/github-service.*.test.ts` baru dengan `fetch` di-mock (GET `draft:false` → tanpa panggilan GraphQL).
- AC-12: When the PR is a Draft, then `GithubService.markPullRequestReadyForReview` reads `node_id` and calls the GraphQL mutation `markPullRequestReadyForReview` with it; a GraphQL `errors` array throws `GithubApiError`.
  Verify: automated test — `fetch` di-mock; asersi URL, body mutasi, dan lemparan error.
- AC-13: When a `/caf-approve-spec` job is rejected (not waiting for approval, no `Status:` line, `NEEDS_CLARIFICATION`, unanswered BLOCKING), then the ticket's dashboard row keeps its previous `final_status`, `ended_at`, `attempt` and `review_result`, and the explanatory PR comment is still posted.
  Verify: automated test — `recordPipelineStarted` dan `finalizePipelineRun` tidak dipanggil pada jalur ini; komentar tetap diposting (mock instrumentation).
- AC-14: When a resumed job stops without running any agent because the branch is gone, the persistent workspace has uncommitted residue, the ticket is waiting for spec approval, or the retry budget is spent, then the dashboard row is likewise untouched.
  Verify: automated test — satu kasus per jalur; instrumentation tidak dipanggil.
- AC-15: When a resumed job does run agents (Clarify resume, gate resume, approved spec), then the dashboard row starts and finalizes as before (`recordPipelineStarted` sebelum agent pertama, `finalizePipelineRun` di akhir).
  Verify: automated test — kasus 04c yang ada tetap lulus; `recordPipelineStarted` dipanggil sebelum `agentRunner.run` pertama.
- AC-16: When a first (non-resume) job starts, then `recordPipelineStarted` is called exactly as before.
  Verify: automated test — kasus yang ada tetap lulus.
- AC-17: `CLAUDE.md` and `README.md` state: the Clarify marker `❓ CAF-CLARIFY` (and that deleting that comment makes all human comments count as answers); the spec-gate label is read at the moment the ready trigger arrives; a ticket whose `ai-agent/<KEY>` branch exists without `orchestration-state.json` gets a "nothing to resume" comment and needs the branch deleted to restart; AC summary and Q-1 only for `caf-validator`; `DRAFT` + unanswered BLOCKING → Clarify; resumed success marks the PR Ready for review.
  Verify: manual check — baca bagian terkait di kedua berkas.
- AC-18: `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass.
  Verify: command: `pnpm typecheck && pnpm lint && pnpm test` | expect: exit 0

## Coverage
- Outcome 1 → AC-1, AC-2, AC-3, AC-4
- Outcome 2 → AC-5, AC-6, AC-7
- Outcome 3 → AC-8, AC-9, AC-10, AC-11, AC-12
- Outcome 4 → AC-13, AC-14, AC-15, AC-16
- Outcome 5 → AC-17
- Semua outcome → AC-18
