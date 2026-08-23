## Ticket: CAF-REGISTRY-1
## Status: SUCCESS

## Scope
Checkpoint 1 only — standalone `ProjectRegistry` foundation. No webhook
handler, no `run-agent-pipeline.use-case.ts`, no queue changes touched or
integrated with, per plan (`tasks.md`).

## Attempt Log
- Attempt 1: PASS — implemented per approved plan, all checks green on
  first pass.

## Acceptance Criteria
- [x] `ProjectConfig` zod schema (`ticketPrefix`, `repoCloneUrl`,
      `baseBranch`, `workspaceDir`, `agents.modelOverrides`) —
      `src/config/project-config.schema.ts`
- [x] `ProjectRegistry` reads `caf.config.yaml`'s `projects:` section,
      builds `Map<ticketPrefix, ProjectConfig>` — `src/config/project-registry.ts`
- [x] `getByPrefix(prefix)` and `getAll()` implemented
- [x] Startup validation collects **all** errors, throws once (verified
      empirically: Zod v4 `superRefine` on a `z.record` coexists with
      per-value base-schema issues in one `safeParse` result — see
      "combined errors" test case)
- [x] Duplicate `ticketPrefix` → error names both projects
- [x] Empty/undefined required field → error names project + field
- [x] Identical `workspaceDir` → error names both projects
- [x] Nested `workspaceDir` (either direction) → error names both projects
- [x] `ticketPrefix` format (uppercase A-Z only) → error on lowercase, dash,
      digits
- [x] `caf.config.yaml`'s existing `umkm-pos` config (`repo.*`,
      `workspace.dir`) left byte-for-byte unchanged; new `projects.umkm-pos`
      section added (`ticketPrefix: GAN`, confirmed by user) — real-file
      regression test passes
- [x] `ProjectRegistry` not imported/wired into any existing code
      (webhooks, pipeline use-case, queue, `config/index.ts`) — confirmed via
      grep, zero references outside the new files/tests

## Quality Gate
- Typecheck (`pnpm typecheck`): PASS, no errors.
- Lint (`pnpm lint`): PASS, no errors (one unrelated ESM/CJS warning from
  `eslint.config.js`'s missing `"type": "module"`, pre-existing, not
  touched by this checkpoint).
- Test (`pnpm test`): 142/144 pre-existing tests pass; 26/26 new tests
  (`project-config.schema.test.ts`, `project-registry.test.ts`) pass.
  **2 pre-existing failures in `tests/unit/spawn-agent.service.test.ts`**
  (`ANTHROPIC_BASE_URL` env leakage) — confirmed via `git stash` that these
  fail identically on the base commit before any of this checkpoint's
  changes, caused by `ANTHROPIC_BASE_URL` being set in this sandbox's shell
  environment. Unrelated file, not modified by this checkpoint. Not
  something CAF-REGISTRY-1 introduced or is responsible for fixing.

## Files changed
- `src/config/project-config.schema.ts` (new) — `projectConfigSchema`,
  `projectsSchema` (with `crossProjectChecks` cross-project `superRefine`),
  `ProjectConfig` type.
- `src/config/project-registry.ts` (new) — `ProjectRegistry` class:
  `fromRawProjects(raw)`, `load(filePath)`, `getByPrefix(prefix)`,
  `getAll()`.
- `tests/unit/project-config.schema.test.ts` (new) — 18 cases covering
  valid input, duplicate prefix, empty required fields, identical/nested
  workspaceDir, non-absolute workspaceDir, ticketPrefix format, combined
  multi-category errors.
- `tests/unit/project-registry.test.ts` (new) — 12 cases covering
  `fromRawProjects` behavior (including the same validation categories via
  the class API) and `load()` (missing file, no `projects:` key, valid temp
  YAML, and the real-`caf.config.yaml` regression check).
- `caf.config.yaml` — added `projects.umkm-pos` section
  (`ticketPrefix: GAN`, `repoCloneUrl`/`baseBranch` mirrored from existing
  `repo.*`, new `workspaceDir: /tmp/caf-orchestrator/workspace/umkm-pos`,
  empty `modelOverrides`). Existing `repo.*`/`workspace.dir` fields
  untouched.
- `caf.config.example.yaml` — added a commented-out `projects:` example
  block for documentation, mirroring the file's existing convention for
  optional sections (`dashboard`, `openai.defaultModel`).
- `.ai/tasks/CAF-REGISTRY-1/tasks.md` — plan, updated with resolved open
  questions after user review.

## Catatan
- **Design decisions confirmed with user during plan review** (not
  unilateral): `umkm-pos` ticket prefix is `GAN` (not documented anywhere
  else in the repo — `job.ticketKey` is always read from the Linear webhook
  payload at runtime, never hardcoded, since v1 is single-project);
  `workspaceDir` required to be an absolute path (needed for the
  nesting/identical check to be well-defined, not explicitly in the
  original checklist); no fabricated dummy project added to the real
  `caf.config.yaml` (all dummy/multi-project fixtures live in test files
  only).
  - Note for whoever wires the Linear webhook to `GAN` going forward: the
    user commented they don't know where the Linear-side ticket prefix is
    configured/changed — worth surfacing when Checkpoint 2 (webhook
    routing) actually starts consuming `ticketPrefix` for real, in case the
    value needs to be re-verified against Linear's actual team settings
    rather than trusted from this file alone.
- `ProjectRegistry.load(filePath)` takes `filePath` as a required parameter
  (no default resolving to `caf.config.yaml` at cwd) — deliberate, since
  nothing calls this yet; a future checkpoint should decide where/how the
  default path is resolved when it actually wires this in
  (`config/index.ts`'s `YAML_CONFIG_PATH` pattern is the obvious precedent).
- Cross-project validation (duplicate prefix, identical/nested
  `workspaceDir`) is implemented via `.superRefine()` on the top-level
  `z.record(...)` schema rather than a hand-rolled aggregator function —
  confirmed via a throwaway script (not committed) that Zod v4 still runs
  `superRefine` and merges its issues with per-project base-schema issues
  into one `ZodError`, even when some individual projects in the record
  also have field-level errors. This keeps the validation logic consistent
  with the existing `configSchema` pattern in `schema.ts` rather than
  introducing a second, different validation style.
- Per scope: `ProjectRegistry` is fully standalone — zero imports of the
  new files from anywhere except the new test files. Ready for Checkpoint 2
  (webhook routing) and Checkpoint 3 (pipeline migration) to consume
  `getByPrefix`/`getAll` without needing changes to this checkpoint's
  public API.
