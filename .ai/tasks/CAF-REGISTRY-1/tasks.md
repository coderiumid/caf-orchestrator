# Plan — CAF-REGISTRY-1: ProjectRegistry Foundation

## Scope reminder
Checkpoint 1 only. Standalone `ProjectRegistry` — no webhook handler, no
`run-agent-pipeline.use-case.ts`, no queue changes. Nothing existing gets
wired to it yet. New files only, plus additive changes to `caf.config.yaml`.

## Current state (read 2026-07-13)

- **Zod is already the project's validation library** (`src/config/schema.ts`),
  so per CLAUDE.md instructions this plan uses Zod for `ProjectConfig`
  validation too — no new/parallel validation library. No open question here,
  confirmed by reading the code.
- Config today is split env (`.env`, secrets) + YAML (`caf.config.yaml`,
  structural) via `envSchema.extend(yamlSchema.shape).superRefine(...)`
  (`src/config/schema.ts:208`). Cross-field checks (Telegram pairing, OpenAI
  auth, model allowlist, dashboard auth) all live in that one `superRefine`,
  and `configSchema.safeParse(...)` returns **all** issues (per-field +
  superRefine-added) in a single `result.error.issues` array — this is the
  existing precedent for "collect everything, throw once."
- `src/config/yaml-config.ts` (`readYamlConfig(filePath)`) reads + parses the
  YAML file and throws actionable errors for missing-file/bad-YAML. I'll
  reuse this as-is (no changes) rather than re-implement file reading.
- `caf.config.yaml` today has no `projects:` section — `repo.cloneUrl` /
  `workspace.dir` are the single global (umkm-pos) values consumed
  elsewhere. Those stay untouched; `projects:` is a net-new top-level key.
- Test convention: unit tests call `schema.safeParse(plainObject)` directly
  (`tests/unit/schema.test.ts`) for validation-logic tests, and use
  `mkdtempSync` + real temp files (`tests/unit/yaml-config.test.ts`) only for
  file-IO-specific behavior (missing file, bad YAML syntax). I'll follow the
  same split: validation-logic tests parse plain objects; only the
  regression-check test (real `caf.config.yaml` loads clean) touches the
  actual file on disk.

## Files to add

```
src/config/project-config.schema.ts   # ProjectConfig zod schema + type + cross-project validation
src/config/project-registry.ts        # ProjectRegistry class (load/getByPrefix/getAll)
tests/unit/project-config.schema.test.ts
tests/unit/project-registry.test.ts
```

Nothing under `src/domain/interfaces/` — those are ports for existing DI
seams (`IGitService`, `IAgentRunner`, etc.) that already have concrete
adapters wired into the pipeline. `ProjectRegistry` isn't a port yet since
nothing consumes it this checkpoint; it lives next to `schema.ts` because
it's the same kind of thing (zod-validated structural config), consistent
with existing layering.

## 1. `src/config/project-config.schema.ts`

```ts
export const projectConfigSchema = z.object({
  ticketPrefix: z.string({ error: 'ticketPrefix is required' })
    .min(1, 'ticketPrefix cannot be empty')
    .regex(/^[A-Z]+$/, 'ticketPrefix must be uppercase A-Z only, no dashes/digits/spaces'),
  repoCloneUrl: z.string({ error: 'repoCloneUrl is required' }).min(1, 'repoCloneUrl cannot be empty'),
  baseBranch: z.string({ error: 'baseBranch is required' }).min(1, 'baseBranch cannot be empty'),
  workspaceDir: z.string({ error: 'workspaceDir is required' })
    .min(1, 'workspaceDir cannot be empty')
    .refine((v) => path.isAbsolute(v), 'workspaceDir must be an absolute path'),
  agents: z.object({
    modelOverrides: z.record(z.string(), z.string()).default({}),
  }).default(() => ({ modelOverrides: {} })),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

// projects: { <projectName>: ProjectConfig }
export const projectsSchema = z.record(z.string(), projectConfigSchema)
  .superRefine(crossProjectChecks);
```

`workspaceDir` absolute-path enforcement isn't explicitly in the checklist,
but the nesting/duplicate check below is only well-defined for absolute
paths (a relative path resolves differently depending on cwd) — flagging
this as a deliberate addition, not scope creep, since without it the nesting
check can't be implemented correctly. **Will call out for approval.**

### Cross-project checks (`crossProjectChecks`, used inside `superRefine`)

Runs on the whole `Record<projectName, ProjectConfig>`:

1. **Duplicate `ticketPrefix`** — group project names by prefix, any group
   with length > 1 → one issue per duplicate group, message lists all
   project names sharing that prefix.
2. **Identical/nested `workspaceDir`** — pairwise compare every project pair
   (O(n²), registry size is small, no perf concern) using
   `path.resolve()`-normalized paths:
   - equal → "identical" issue naming both projects.
   - one is an ancestor of the other (checked via `path.relative(a, b)` not
     starting with `..` and not empty, tried in both directions) → "nested"
     issue naming both projects + which one is nested under which.

Required-field-empty and `ticketPrefix` format issues are already produced
by `projectConfigSchema` itself (per-project, per-field) — no separate pass
needed for those two categories.

### Open technical question — verify before relying on it

Need to confirm empirically (first thing in IMPLEMENT) that Zod's
`superRefine` on `projectsSchema` still runs — and its issues still land in
the same `safeParse` result — even when one or more individual projects
*also* have base-schema errors (e.g. project A missing `repoCloneUrl` AND
project B duplicates project C's prefix, in the same input). The existing
`configSchema` precedent suggests yes (superRefine issues + per-field
issues do coexist in one `result.error.issues`), but I haven't verified that
holds when the base-schema errors are inside a `z.record`'s *values* rather
than direct siblings of the refined object. If it turns out Zod skips
`superRefine` when nested value errors exist, fallback: run cross-project
checks manually against the raw (untyped) input in `ProjectRegistry` rather
than via `superRefine`, still collecting into one combined error list. Will
write a throwaway test for this first and note the outcome in
`verify-report.md`; doesn't change the public API either way.

## 2. `src/config/project-registry.ts`

```ts
export class ProjectRegistry {
  private constructor(private readonly byPrefix: Map<string, ProjectConfig>) {}

  static fromRawProjects(raw: unknown): ProjectRegistry {
    const result = projectsSchema.safeParse(raw ?? {});
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  - projects.${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
      throw new Error(`Project registry validation failed:\n${issues}`);
    }
    const byPrefix = new Map<string, ProjectConfig>();
    for (const project of Object.values(result.data)) {
      byPrefix.set(project.ticketPrefix, project);
    }
    return new ProjectRegistry(byPrefix);
  }

  static load(filePath: string): ProjectRegistry {
    const raw = readYamlConfig(filePath);
    const projects = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).projects : undefined;
    return ProjectRegistry.fromRawProjects(projects);
  }

  getByPrefix(prefix: string): ProjectConfig | undefined {
    return this.byPrefix.get(prefix);
  }

  getAll(): ProjectConfig[] {
    return [...this.byPrefix.values()];
  }
}
```

- `fromRawProjects` is the pure, no-filesystem entry point — this is what
  most unit tests call directly with plain objects (mirrors
  `configSchema.safeParse(plainObject)` in `schema.test.ts`).
- `load(filePath)` is the filesystem entry point, reusing `readYamlConfig`
  unchanged. No default `filePath` param — caller (a future checkpoint, or a
  test) passes it explicitly, same as `YAML_CONFIG_PATH` is resolved once in
  `config/index.ts` today. Not wiring a `ProjectRegistry` singleton into
  `config/index.ts` this checkpoint per scope (that's presumably Checkpoint
  2/3's job) — **flagging this as an assumption**, since "berdiri sendiri"
  could also reasonably mean "export it but don't call it anywhere," which
  is what this gives you either way (nothing imports `project-registry.ts`
  yet).
- No `.env` involvement — projects are 100% structural, no secrets in
  `ProjectConfig`'s shape.

## 3. `caf.config.yaml` change

Add a `projects:` top-level section with **one real entry** (`umkm-pos`,
derived from the existing `repo.cloneUrl` / `repo.baseBranch` / `workspace.dir`
values already in the file) so the regression-check test
(`ProjectRegistry.load()` against the real file) actually exercises
something meaningful, not just "empty map parses fine."

```yaml
projects:
  umkm-pos:
    ticketPrefix: GAN
    repoCloneUrl: git@github.com:ganjardbc/umkm-pos.git
    baseBranch: main
    workspaceDir: /tmp/caf-orchestrator/workspace/umkm-pos
    agents:
      modelOverrides: {}
```

**Deliberately not** adding a second fake/dummy project into the committed
`caf.config.yaml` — all multi-project test fixtures (duplicate prefix,
nested workspaceDir, etc.) will live in the test files as plain objects or
temp YAML files, not in real config. Checkpoint spec allows a dummy project
in the YAML but doesn't require it, and keeping fabricated data out of the
one file that's meant to reflect real deployment config seems better —
**flagging for approval**, happy to add a second dummy entry directly to
`caf.config.yaml` instead if you'd rather have it there.

`workspaceDir: /tmp/caf-orchestrator/workspace/umkm-pos` is a new value,
distinct from the existing top-level `workspace.dir:
/tmp/caf-orchestrator/workspace` (no trailing subpath) — chosen so that if
a second project is ever added later under `/tmp/caf-orchestrator/workspace/<other>`
it won't collide, and so it doesn't silently equal the untouched legacy
field. Existing `workspace.dir` and `repo.*` fields are left byte-for-byte
unchanged, only a new sibling key is added.

## Open Questions — RESOLVED (2026-07-13)

1. **umkm-pos's real Linear ticket prefix: `GAN`** — confirmed by user.
   `caf.config.yaml`'s `projects.umkm-pos.ticketPrefix` will be `GAN`.
2. `workspaceDir` absolute-path enforcement — **confirmed, add it**
   (`.refine(path.isAbsolute)` in `projectConfigSchema`).
3. No second dummy project in the real `caf.config.yaml` — **confirmed**,
   all dummy/duplicate/nested fixtures stay in test files only.
4. `ProjectRegistry.load()` taking `filePath` as a required param (no
   default) — not objected to, proceeding as planned.

Plan approved. Proceeding to IMPLEMENT.

## Test plan

`tests/unit/project-config.schema.test.ts` — schema/validation-logic only,
plain objects via `projectsSchema.safeParse(...)`:
- 2 valid dummy projects → `success: true`.
- Duplicate `ticketPrefix` across 2 dummy projects → issue message names
  both project keys.
- 1 dummy project with empty `repoCloneUrl` → issue path/message names the
  project and field.
- 2 dummy projects with identical `workspaceDir` → issue names both.
- 2 dummy projects with nested `workspaceDir` (e.g. `/tmp/a` and
  `/tmp/a/sub`) → issue names both + nesting direction.
- `ticketPrefix` lowercase (`"gan"`) → format issue.
- `ticketPrefix` with dash (`"GAN-1"`) → format issue.
- Combined case (if the Zod superRefine-coexistence question above resolves
  "yes"): one project missing a required field AND a separate duplicate
  prefix pair in the same input → both issues present in one
  `result.error.issues` array, proving "collect all, don't stop at first."

`tests/unit/project-registry.test.ts` — `ProjectRegistry` class behavior:
- `fromRawProjects` with 2 valid dummy projects → `getByPrefix('X')` returns
  the right config, `getAll()` returns both, length 2.
- Each invalid-input case above, called through
  `ProjectRegistry.fromRawProjects(...)`, asserted to `throw` with a message
  containing the relevant project name(s)/field(s) (thin wrapper test over
  the schema-level cases, confirms the class surfaces the same combined
  error text).
- `getByPrefix` on an unknown prefix → `undefined` (not throw).
- Regression: `ProjectRegistry.load(<repo-root>/caf.config.yaml)` (real
  file) → does not throw, `getAll()` includes the `umkm-pos` entry with the
  expected fields.
- `ProjectRegistry.load()` against a temp YAML file with no `projects:` key
  at all → does not throw, `getAll()` returns `[]` (a registry with zero
  projects is valid, not an error — this checkpoint doesn't require at
  least one project to exist).

## Verify checklist

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test` (full suite — confirms nothing existing breaks, even
      though nothing existing imports the new files)
- [ ] All new-file unit test cases above pass
- [ ] Regression case: real `caf.config.yaml` loads clean through
      `ProjectRegistry.load()`

## Retry logic

Per CAF.md / `.ai/workflows/piv-workflow.md`: verify fail → fix → retry, max
3 attempts. 3rd failure → stop, `verify-report.md` gets `Status: NEEDS_HUMAN`
with the last attempt's actual error output, no force-pass.

## Not doing (explicitly out of scope, confirmed against the prompt)

- No changes to any webhook route.
- No changes to `run-agent-pipeline.use-case.ts` or any queue/BullMQ code.
- No wiring of `ProjectRegistry` into `config/index.ts` or anywhere else
  that currently runs.
- No removal/modification of existing `repo.*` / `workspace.dir` top-level
  fields in `caf.config.yaml`.

---

No code written yet. Waiting for plan approval (and answers to the Open
Questions above, especially #1) before starting IMPLEMENT.
