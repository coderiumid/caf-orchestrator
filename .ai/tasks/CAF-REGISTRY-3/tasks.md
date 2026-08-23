# CAF-REGISTRY-3: Migrate Pipeline Use-Case to Dynamic ProjectConfig — Plan

Status: **PLAN — awaiting review before implementation.**

## Context recap

Checkpoint 1 (merged): `ProjectRegistry` / `ProjectConfig` / `projectConfigSchema` — per-project
`ticketPrefix`, `repoCloneUrl`, `baseBranch`, `workspaceDir`, `agents.modelOverrides`, with
cross-project nested/duplicate `workspaceDir` validation at startup.

Checkpoint 2 (merged): `webhooks.ts` resolves the project by ticket prefix and attaches
`projectConfig: JobProjectContext` (`domain/interfaces/queue.interface.ts`) to every enqueued
job. **By explicit design in Checkpoint 2's plan**, `job.cloneUrl` / `job.baseBranch` (the
top-level `JobPayload` fields) were deliberately left sourced from global `config.repo.*` and
*not* repointed to the per-project values — that repointing was explicitly deferred to this
checkpoint. So finding "top-level `cloneUrl`/`baseBranch` are still global" below is expected,
not a surprise bug — it's exactly what Checkpoint 3 exists to fix.

`JobPayload` today (confirmed by reading `queue.interface.ts`):
```ts
export interface JobProjectContext {
  repoCloneUrl: string;
  baseBranch: string;
  workspaceDir: string;
  agents: { modelOverrides: Record<string, string> };
}

export interface JobPayload {
  jobId: string;
  ticketId: string;
  ticketKey: string;
  ticketTitle: string;
  ticketDescription: string;
  cloneUrl: string;       // legacy, global config.repo.cloneUrl — Checkpoint 2 output
  baseBranch: string;     // legacy, global config.repo.baseBranch — Checkpoint 2 output
  projectConfig: JobProjectContext;  // the real per-project source of truth from here on
}
```
`JobProjectContext` and the mapper (`infrastructure/linear/project-context-mapper.ts`) are
already correct and complete — nothing to change there.

## Audit: every point currently reading global `.env`/`caf.config.yaml`/constant instead of `job.projectConfig`

| # | File:Line | What it reads today | Fix |
|---|-----------|---------------------|-----|
| 1 | `src/application/use-cases/run-agent-pipeline.use-case.ts:122` — `gitService.clone(job.cloneUrl, job.baseBranch, repoPath)` | Legacy top-level `job.cloneUrl`/`job.baseBranch` (→ global `config.repo.*` via webhooks.ts) | Read `job.projectConfig.repoCloneUrl` / `job.projectConfig.baseBranch` instead |
| 2 | `run-agent-pipeline.use-case.ts:399` — `parseGithubRepo(job.cloneUrl)` | Same legacy field | Use `job.projectConfig.repoCloneUrl` |
| 3 | `run-agent-pipeline.use-case.ts:404` — `base: job.baseBranch` (PR base branch) | Same legacy field | Use `job.projectConfig.baseBranch` |
| 4 | `run-agent-pipeline.use-case.ts:111` — `workspaceManager.createWorkspace()` (no args) | `WorkspaceManager` computes its workspace root from module-level `WORKSPACE_ROOT = resolve(config.workspace.dir)` (`infrastructure/git/workspace.manager.ts:10`), global for every job regardless of project | `createWorkspace()` must take the per-project root and create `job-<uuid>` under *that* — see interface change below |
| 5 | `infrastructure/git/workspace.manager.ts:10,15` — `WORKSPACE_ROOT` module constant used both to build the path and in `validatePath()`'s escape check | Same global constant | `validatePath` must validate against the same per-project root that was used to create the workspace, not a fixed module constant |
| 6 | `infrastructure/git/git.service.ts:8,30` — `WORKSPACE_ROOT` module constant used in `assertInsideWorkspace()` for every git op (`clone`/`createBranch`/`commitAll`/`push`) | Same global constant, independent of (4)/(5) | Must be repointed the same way, or the escape-check will now reject every legitimate per-project workspace path (since `targetDir` will live under the project's `workspaceDir`, not the global one) — **this is the sharpest correctness risk in the whole checkpoint**: if only (4)/(5) are fixed and this one is missed, every job breaks at the first `git clone` with a false-positive `ValidationError` |
| 7 | `infrastructure/git/git.service.ts:82` — `runGit([...clone args], WORKSPACE_ROOT)` (cwd for the clone command itself, since there's no cwd yet pre-clone) | Same global constant | Must run from the per-project root (or any real dir under it) — cosmetic vs (6) but same source |
| 8 | `infrastructure/agent/spawn-agent.service.ts:62` — `config.agents.modelOverrides[agentName]` | Global `agents.modelOverrides` from `caf.config.yaml` | Needs `job.projectConfig.agents.modelOverrides[agentName]` — requires threading the map into `IAgentRunner.run(...)` (interface currently takes only `agentName, cwd, prompt`) |
| 9 | `run-agent-pipeline.use-case.ts` — every `agentRunner.run(name, repoPath, prompt)` call site (planner, frontend/backend via `runImplementationAgents`, qa, reviewer, documentation) | N/A today (runner reads config internally) | Once (8) changes the `IAgentRunner` signature, every call site here must pass `job.projectConfig.agents.modelOverrides` through |

### Checked, no change needed
- **Branch naming** (`run-agent-pipeline.use-case.ts:113`, `const branch = \`ai-agent/${job.ticketKey}\``): already uses the job's own `ticketKey` dynamically — no hardcoded `GAN-` or any other prefix literal anywhere in `src/`. Confirmed via grep across the whole tree. Nothing to fix.
- **`.env` secrets** (`GITHUB_TOKEN` in `git.service.ts`'s `getAuthenticatedRepoUrl`, `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` in `spawn-agent.service.ts`): correctly stay global/`.env` — these are credentials, not structural per-project config, consistent with the project's config-governance principle. Not in scope to change.
- **`config.claude.command` / `config.claude.agentTimeoutMs`** (`spawn-agent.service.ts`): global operational settings (which CLI binary, how long to wait), not per-project routing data. `JobProjectContext` doesn't carry these and shouldn't — out of scope.
- **Concurrency / same-project race check** (functional requirement #3): `WorkerConcurrency` defaults to `1` (`config/schema.ts:156`, confirmed `queue.workerConcurrency` default `1`, wired into `infrastructure/queue/worker.ts:20,48` as BullMQ's `concurrency` option) — same-project concurrent jobs are not possible today at default config, consistent with the "not a new problem" framing in the prompt. Independent of that: `WorkspaceManager.createWorkspace()` already suffixes every workspace with `job-${randomUUID()}` (`workspace.manager.ts:19`), so even if concurrency were ever raised above 1, two jobs for the *same* project would still get distinct, non-colliding workspace directories under the shared project root — this is not broken by the migration and doesn't need new code to stay safe.

## Findings to report separately (NOT fixed in this checkpoint — out of scope / needs human decision)

1. **Per-project `agents.modelOverrides` is never validated against `openai.allowedModels`.**
   `config/schema.ts`'s `superRefine` (`validateAgentModelOverrides`, ~line 249) only checks the
   *global* `agents.modelOverrides` against `openai.allowedModels` at startup. `project-config.schema.ts`'s
   per-project `agents.modelOverrides` (used by every project in `projects:`, including `umkm-pos`)
   has no equivalent check anywhere. Once this checkpoint repoints agent model selection to
   `job.projectConfig.agents.modelOverrides` (audit point 8 above), a typo'd/unlisted model id in
   a project's config would no longer be caught at startup by the documented fail-closed allowlist
   — it would only surface as a runtime 404 from the agent call. This is a real gap in the
   Checkpoint 1 schema, not something introduced by this checkpoint, but this checkpoint is what
   makes it load-bearing in production. Recommend a follow-up checkpoint to add the same
   `validateAgentModelOverrides` check to every project's `agents.modelOverrides` in
   `projectsSchema`'s existing `superRefine`. **Not fixing here** per instructions (report, don't
   silently patch a different checkpoint's schema).

## Plan for IMPLEMENT (after this plan is approved)

Minimal, point-by-point changes — no broad refactor, per the prompt's explicit risk guidance:

1. `domain/interfaces/agent-runner.interface.ts`: extend `IAgentRunner.run(...)` to accept the
   model-override map, e.g. `run(agentName, cwd, prompt, modelOverrides: Record<string, string>)`.
2. `infrastructure/agent/spawn-agent.service.ts`: read the override from the passed-in map instead
   of `config.agents.modelOverrides`. Keep `config.claude.command`/`agentTimeoutMs`/`openai.*` as
   global (unchanged).
3. `domain/interfaces/git.interface.ts`: extend `IWorkspaceManager.createWorkspace(...)` to accept
   the per-project `workspaceDir` (root), and give `validatePath`/`cleanupWorkspace` a way to
   validate against that same root instead of a fixed module constant (likely: derive/pass the
   root alongside the created path, or accept root as a param on `validatePath` too — exact shape
   decided during implementation, kept as small as possible).
4. `infrastructure/git/workspace.manager.ts`: drop the module-level `WORKSPACE_ROOT` constant;
   compute the job's workspace under the root passed in per-call.
5. `infrastructure/git/git.service.ts`: same — `assertInsideWorkspace` needs the per-project root
   for each call. Since `IGitService` methods only take `targetDir` (already an absolute path
   under the right project root by construction from step 3/4), the simplest fix that doesn't
   change `IGitService`'s public signature is to validate that `targetDir` is an absolute path
   with no `..` traversal rather than pinning it to one fixed root — needs care since this is the
   path-escape safety check; will propose the exact validation logic in the implementation diff
   for review, not silently loosen it.
6. `run-agent-pipeline.use-case.ts`: swap `job.cloneUrl`/`job.baseBranch` → `job.projectConfig.repoCloneUrl`/`job.projectConfig.baseBranch` (audit 1-3); pass `job.projectConfig.workspaceDir` into `createWorkspace()` (audit 4); pass `job.projectConfig.agents.modelOverrides` into every `agentRunner.run(...)` call (audit 8-9). `qaRetryCount`/`reviewerRetryCount` loop structure, gate `return`-vs-`throw` semantics: **untouched**, only the data source changes.
7. Update `tests/unit/run-agent-pipeline.use-case.test.ts`'s `makeJob()` to include a `projectConfig`
   fixture (currently missing entirely from the test file's `JobPayload` mock, pre-existing gap —
   `tests/` is excluded from `tsc --noEmit`'s `include`, so this doesn't fail typecheck today, but
   it means the current test suite exercises a `JobPayload` shape without `projectConfig` at all).
   Add the two required test cases from the Verify Checklist (real `umkm-pos`-shaped config vs. a
   dummy inline project object) once step 6 lands.
8. Update `tests/unit/spawn-agent.service.test.ts` and any `IWorkspaceManager`/`IGitService` mocks
   elsewhere for the new signatures.

## Pre-existing baseline (confirmed before touching anything)

- `pnpm typecheck`: clean, 0 errors.
- `pnpm test`: 159 passed, **2 pre-existing failures** in `tests/unit/spawn-agent.service.test.ts`
  (`ANTHROPIC_BASE_URL` env-pollution from this sandbox's own environment leaking into
  `process.env` assertions) — unrelated to this checkpoint, not introduced by it, not fixed by it.

## Verify Checklist (for after implementation)
- [ ] Typecheck, lint clean
- [ ] Unit test: `umkm-pos`-shaped `projectConfig` → resolves workspace/repo/branch/model override from it, not `.env`/global config
- [ ] Unit test: dummy inline `projectConfig` (not registered anywhere) → use-case resolves from the dummy values, proving no `umkm-pos` hardcode remains
- [ ] Regression: `qaRetryCount`/`reviewerRetryCount` retry/gate semantics unchanged
- [ ] End-to-end: real `GAN-` ticket through the full pipeline to PR-open or verify-report

## Retry Logic
Verify fails → fix, max 3x. Still failing → STOP, `Status: NEEDS_HUMAN` with detail.
