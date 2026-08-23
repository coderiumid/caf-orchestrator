# CAF-AUTO-PR — Auto PR creation (Fase 4)

Status: PLANNING ONLY — no implementation yet.

## Context

Pipeline (`run-agent-pipeline.use-case.ts`) currently stops after:
```
await gitService.commitAll(repoPath, `AI agent pipeline: ${job.ticketKey}`);
await gitService.push(repoPath, branch);

await linearClient.postComment(job.ticketId, `Agent pipeline complete. Branch pushed: \`${branch}\`...`);
```
No PR is opened. This adds a `github.service.ts` step between push and the
final `postComment`, using native `fetch` (same pattern as `linear.service.ts`
via `graphqlRequest`), not `gh` CLI / MCP / octokit.

Insertion point: `run-agent-pipeline.use-case.ts`, right after
`gitService.push(repoPath, branch)` and before the final `linearClient.postComment(...)`.
Both `qaReport.verdict`/`.raw` and `reviewerReport.verdict`/`.raw` are already
in scope at that point (local vars from earlier gates) — no new report reads needed.

## 1. Config (`src/config/schema.ts`)

Add as its own required var, NOT reused/merged with any other project's config object:
```ts
GITHUB_TOKEN: z
  .string({ error: 'GITHUB_TOKEN is required' })
  .min(1, 'GITHUB_TOKEN cannot be empty'),
GITHUB_API_URL: z.url().default('https://api.github.com'),
```
Repo owner/name: derive from existing `REPO_CLONE_URL` (parse
`github.com/{owner}/{repo}(.git)?`) rather than adding new env vars — avoids
duplicating info already in config. Add a small `parseGithubRepo(cloneUrl)`
helper (probably in `github.service.ts` itself, or `vcs/` since that's where
`isSafeBranchName` etc. already live).

`.env.example`: add `GITHUB_TOKEN=` under a new "GitHub Integration (required
for auto-PR)" section, next to `REPO_CLONE_URL`.

## 2. New interface + service

`src/domain/interfaces/vcs-client.interface.ts` (new, mirrors `ILinearClient`):
```ts
export interface IVcsClient {
  createPullRequest(input: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ url: string; number: number }>;
}
```

`src/infrastructure/vcs/github.service.ts` (new file in existing `vcs/` dir,
alongside `security.ts`):
- `POST {GITHUB_API_URL}/repos/{owner}/{repo}/pulls`
- Headers: `Authorization: Bearer ${config.GITHUB_TOKEN}`, `Accept: application/vnd.github+json`
- Body: `{ title, head, base, body }`
- On non-2xx: throw new `GithubApiError` (add to `domain/errors/app-errors.ts`,
  same pattern as `LinearApiError`)
- Return `{ url: json.html_url, number: json.number }`
- Export singleton `githubService` like `linearService`.

Wire into `RunAgentPipelineDeps` as `vcsClient: IVcsClient` and construct in
wherever `linearService`/`gitService` are currently instantiated (worker
bootstrap — need to locate that wiring point before implementing).

## 3. PR body content

Build from files already in the workspace (not re-read via new agent calls):
- Title: `${job.ticketKey}: ${job.ticketTitle}`
- Body: short summary + links as relative paths (since reviewers open the
  branch directly, these render as repo-relative links on GitHub):
  ```
  Ticket: ${job.ticketKey}
  ${job.ticketDescription ?? ''}

  ## Reports
  - Verify: `.ai/tasks/${job.ticketKey}/verify-report.md`
  - QA: `.ai/tasks/${job.ticketKey}/qa-report.md`
  - Review: `.ai/tasks/${job.ticketKey}/review-notes.md`
  ${docsNote}
  ```
- Requirements.md is referenced by planner/tasks.md convention — confirm
  exact filename tasks.md/planner actually produces (grep target repo's
  planner agent def) before hardcoding a path that may not exist.

## 4. Gate condition

Only call `createPullRequest` when `reviewerReport.verdict === 'APPROVE' ||
reviewerReport.verdict === 'DEFER'`. `CHANGES_REQUESTED` already returns early
above this point, so by the time we reach the push/PR step verdict is
guaranteed to be one of these two — an explicit check is still worth keeping
as a defensive assertion/comment, not a new branch of control flow.

## 5. Final Linear comment update

Replace:
```
`Agent pipeline complete. Branch pushed: \`${branch}\`\n\n${docsNote}\n\n${qaReport.raw}\n\n${reviewerReport.raw}`
```
with PR url included, e.g.:
```
`Agent pipeline complete. PR: ${pr.url}\n\n${docsNote}\n\n${qaReport.raw}\n\n${reviewerReport.raw}`
```
If PR creation itself throws, decide: should PR-creation failure fail the
whole job (BullMQ retry) or degrade gracefully like docs (caught, noted,
job still succeeds with branch-only comment)? Recommend: **fail the job** —
unlike docs, a missing PR means the whole pipeline output isn't usable by a
human yet, and it's not a "nice to have" like docs. Confirm with user before
implementing since this changes retry semantics.

## 6. GITHUB_TOKEN scope — BLOCKING, unresolved

Plan calls for reusing the `GITHUB_TOKEN` already used by `ai-code-review`.
No local checkout of `ai-code-review` or `umkm-pos` was found on this machine
to inspect scopes/permissions directly. **Cannot verify from here whether
that token has access to `umkm-pos`** (vs. only whatever repo
ai-code-review targets).

Action needed before implementation: user to confirm via one of:
- `gh auth status` (if using a `gh`-issued token)
- GitHub → Settings → Developer settings → (Fine-grained token) → check
  "Repository access" list includes `umkm-pos`
- Classic PAT: scope only controls `repo` (all-or-nothing across repos the
  token owner can access) — if classic, access is implied by owner
  permissions on `umkm-pos`, not token config.

If scope is insufficient: mint a new token (or add `umkm-pos` to the
fine-grained token's repo list) and store as this project's own
`GITHUB_TOKEN`, not shared inline with ai-code-review's `.env`.

## Open questions before implementation

1. Where is `linearService`/`gitService` currently constructed/injected
   (worker bootstrap file) — need exact file to wire `vcsClient` in.
2. PR creation failure: fail job vs. degrade-gracefully (see §5) — needs
   user decision.
3. Exact report filenames to link (confirm `verify-report.md` etc. paths
   match what's actually produced — should already be correct per
   `report-reader.ts` but double check against planner's actual output dir
   the ticket uses, in case ticket key casing/format differs).
4. GITHUB_TOKEN scope for `umkm-pos` (§6) — blocking, needs user to confirm.
