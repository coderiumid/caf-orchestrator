## Ticket: CAF-AUTO-PR
## Agent: implementation (per plan.md)
## Status: SUCCESS

## Yang diimplementasi

1. `src/domain/errors/app-errors.ts`
   - Tambah `GithubApiError` (code `GITHUB_API_ERROR`, statusCode 502),
     mirror `LinearApiError`.

2. `src/config/schema.ts` + `.env.example`
   - `GITHUB_TOKEN` (required, tidak reuse config project lain — env var
     terpisah, hanya disimpan sebagai nilai di `.env` deployment).
   - `GITHUB_API_URL` (default `https://api.github.com`).

3. `src/domain/interfaces/vcs-client.interface.ts` (baru)
   - `IVcsClient.createPullRequest(input)` → `{ url, number }`.

4. `src/infrastructure/vcs/github.service.ts` (baru)
   - `parseGithubRepo(cloneUrl)` — regex extract owner/repo dari
     `REPO_CLONE_URL`/`job.cloneUrl`, throw `GithubApiError` kalau tidak
     match (bukan silent fallback).
   - `GithubService.createPullRequest()` — `POST /repos/{owner}/{repo}/pulls`
     via native `fetch`, `Authorization: Bearer ${GITHUB_TOKEN}`, sama pola
     dengan `linear.service.ts` (`graphqlRequest`). Non-2xx → throw
     `GithubApiError` dengan status + body.
   - Export singleton `githubService`.

5. `src/application/use-cases/run-agent-pipeline.use-case.ts`
   - `RunAgentPipelineDeps.vcsClient: IVcsClient` (required, bukan
     optional — PR creation bukan fitur nice-to-have seperti Docs Agent).
   - `buildPrBody()` — private helper, isi: ticket desc + link relatif ke
     `requirements.md`/`verify-report.md`/`qa-report.md`/`review-notes.md`
     (path referensi, karena file ada di branch yang sama) + docsNote +
     qaReport.raw + reviewerReport.raw.
   - Insert point: setelah `gitService.push()`, sebelum final
     `linearClient.postComment()`. Hanya path sukses reviewer
     (APPROVE/DEFER) yang sampai baris ini — CHANGES_REQUESTED sudah
     return early di gate sebelumnya, jadi tidak perlu extra if-check.
   - PR creation throw → **tidak** di-catch (beda dari Documentation
     Agent) → propagate ke `catch` blok utama → `notifyPipelineFailed` →
     rethrow → BullMQ retry (attempts:3, sudah default di
     `queue/client.ts`, tidak perlu config tambahan).
   - Final comment ganti `Branch pushed: \`${branch}\`` → `PR: ${pullRequest.url}`.

6. `src/worker.ts`
   - Import `githubService`, wire sebagai `vcsClient` di
     `RunAgentPipelineUseCase` constructor.

7. `tests/unit/run-agent-pipeline.use-case.test.ts`
   - Tambah `vcsClient` mock (`createPullRequest` default resolve ke PR
     dummy) di semua 18 titik konstruksi `RunAgentPipelineUseCase`.
   - `makeJob().cloneUrl` diganti ke URL GitHub asli
     (`https://github.com/ganjardbc/umkm-pos.git`) supaya
     `parseGithubRepo` tidak throw di test path sukses lain yang sudah
     ada sebelumnya.
   - 2 test case baru:
     - PR dibuat dengan `owner`/`repo`/`head`/`base` benar, URL PR masuk
       ke `postComment` akhir.
     - `createPullRequest` throw → job reject, `postComment` TIDAK
       dipanggil (no partial success state), `notifyPipelineFailed`
       dipanggil, `notifyPipelineComplete` tidak dipanggil,
       `cleanupWorkspace` tetap jalan (finally block).

8. `tests/setup.ts`
   - Tambah default `GITHUB_TOKEN=test-github-token` supaya config
     zod-validated bisa load di test tanpa `.env` asli.

## Konfirmasi keputusan (dari user, bukan asumsi)

- GITHUB_TOKEN classic PAT scope `repo`: dikonfirmasi user sudah cukup
  untuk akses `umkm-pos` (all-or-nothing berdasar permission akun
  pemilik token) — tidak ada perubahan kode terkait ini, murni
  konfirmasi operasional sebelum deploy.
- PR creation failure: FAIL THE JOB, retry via BullMQ attempts:3 (sudah
  ada, tidak perlu ubah `queue/client.ts`) — bukan degrade-gracefully
  seperti Documentation Agent.

## Verifikasi

```
pnpm typecheck   → PASS (tsc --noEmit, no errors)
pnpm test        → PASS (4 test files, 37 tests total, termasuk 2 baru)
pnpm lint        → PASS (eslint src, no errors; hanya warning
                   MODULE_TYPELESS_PACKAGE_JSON, tidak terkait perubahan ini)
```

## Belum dikerjakan (di luar scope task ini)

- `readRequirements()` di `report-reader.ts` sudah ada sebelumnya tapi
  tidak dipanggil langsung di use-case — PR body hanya link ke path
  `requirements.md`, tidak membaca isi filenya (sesuai plan.md §3, opsi
  yang lebih murah karena file sudah ada di branch yang sama).
- Tidak ada perubahan pada `queue/client.ts` — `attempts: 3` sudah
  global default, cukup untuk requirement retry PR failure.
