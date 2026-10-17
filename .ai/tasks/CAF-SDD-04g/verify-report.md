Status: SUCCESS

# CAF-SDD-04g — Verify report

Branch `ai-agent/CAF-SDD-04g`, stacked on `ai-agent/CAF-SDD-04e` (not yet merged to main). Local commits only; nothing pushed.

## Checks
- `pnpm typecheck`: pass. `pnpm lint`: pass (only the pre-existing `MODULE_TYPELESS_PACKAGE_JSON` node warning).
- `pnpm test`: **64 files / 773 tests pass** (baseline before changes: 63 files / 761 tests; +1 file, +12 tests).

## AC → evidence
| AC | Evidence |
|---|---|
| AC-1 | `git-auth.sdd04g.test.ts` "AC-1": real `git clone` from a local bare repo; `.git/config` has no token, `x-access-token` or base64; clone receives the userinfo-free URL. Spike T1 confirmed the same over real HTTP. |
| AC-2 | "AC-2": spawn wrapper records env per call; `clone`/`push`/`fetch`/`ls-remote` carry `GIT_CONFIG_*`, while `rev-parse`, `status`, `checkout`, `reset`, `clean`, `commit` (and `remote get-url`) do not. Global `GIT_ENV` untouched (per-call merge). |
| AC-3 | "AC-3": forced failure whose stderr echoes token + base64; neither appears in `error.message`, recorded argv or logger output (clone and push). |
| AC-4 | "AC-4": origin set to a `x-access-token:<tok>@github.com` URL; after `preflightCleanup` it is clean, `set-url` ran before `fetch`, fetch carried auth. Idempotent case: no `set-url` when already clean. |
| AC-5 | All pre-existing tests pass **unmodified** (`git.service`, `git-preflight-cleanup`, `workspace-mode-integration`, ...). |
| AC-6 | "AC-6": no `GITHUB_TOKEN` → `{}`/no header; non-github.com and local-path URL → `{}`, no version check. |
| AC-7 | "AC-7": stubbed `git version 2.30.1` → error naming 2.31 (via `buildGitAuthEnv` and `remoteBranchExists`); 2.31.0 accepted, check cached. |
| AC-8 | Numbers above. Test count did not decrease. |
| AC-9 | UNVERIFIED (manual) — paragraph "Git auth: no token in the workspace" added to `CLAUDE.md`, includes the manual `git remote set-url` step. Also updated the "Restricted validator" residual-risk bullet. Ganjar to read. |

## Adjustments to old tests
None. No existing test asserted the token-bearing URL form, so none was changed.

## Implementation notes
- `getAuthenticatedRepoUrl` replaced by exported `buildGitAuthEnv`, `toCleanRepoUrl`, `resetGitVersionCheck` (test seam) in `src/infrastructure/git/git.service.ts`; `runGit` takes optional per-call extra env and redacts token/base64 from stderr and spawn errors.
- `push` and `preflightCleanup` derive the auth host from `git remote get-url origin` (they receive no URL).
- `preflightCleanup` is the only reuse point that touches `origin`; resume/retry uses it (persistent) or `clone` (ephemeral), so both are covered.

## Not tested / risks
- **Not tested against real GitHub.** No token in the session env, and reading the repo `.env` token was blocked. Verified only against a local HTTP git server (spike). `http.https://github.com/.extraheader` + `basic x-access-token:<token>` is the standard scheme, but run one `ls-remote` with it on a private repo before deploying.
- Git versions < 2.31 verified only by stub.
- Existing clones on the VPS keep the token until their next `preflightCleanup` (persistent mode) or manual `git -C <workspace> remote set-url origin https://github.com/<owner>/<repo>.git`. Ephemeral job dirs are deleted after each job.
- Untracked `.ai/tasks/CAF-SDD-04e/CAF-STATUS-TERKINI.md.md` was left alone (not part of this ticket).
