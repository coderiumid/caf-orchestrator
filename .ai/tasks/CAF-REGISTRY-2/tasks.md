# CAF-REGISTRY-2: Webhook Routing by Ticket Prefix — Plan

Status: **PLAN — awaiting review before implementation.**

## Context recap

Checkpoint 1 (merged to `main`) added:
- `src/config/project-config.schema.ts` — `projectConfigSchema` / `ProjectConfig` type, `projectsSchema` (record keyed by project name, cross-project validated).
- `src/config/project-registry.ts` — `ProjectRegistry` class, `.load(filePath)` / `.fromRawProjects(raw)` / `.getByPrefix(prefix)` / `.getAll()`. Confirmed present on `main`, not touched here.
- `caf.config.yaml` has a `projects:` map with one entry, `umkm-pos` (`ticketPrefix: GAN`, own `repoCloneUrl`/`baseBranch`/`workspaceDir`/`agents.modelOverrides`).

`ProjectRegistry` is currently standalone — nothing constructs or calls it. This checkpoint wires it into the Linear webhook path only.

## Current webhook handler (`src/presentation/web/routes/webhooks.ts`)

Order of gates today, confirmed by reading the file:
1. HMAC signature verify (`verifyLinearSignature`) → 401
2. Timestamp freshness → 401
3. `Linear-Delivery` header present → 400
4. Delivery dedupe (Redis) → 200 `ignored` if replay
5. Zod parse (`linearIssueWebhookSchema`) → 200 `ignored` if payload doesn't match
6. "Is this a real transition into Ready-for-AI" check → 200 `ignored` if not
7. `ENABLE_PIPELINE_TRIGGER` kill switch → 200 `disabled`
8. Build `JobPayload`, `pipelineQueue.addJob(...)`, return 202 `enqueued`

The new prefix-routing step slots in as **step 7.5**, after the kill-switch check and before building the job payload. This keeps signature verification untouched as the earliest gate (regression requirement) and keeps the change localized — no restructuring of the handler needed.

`JobPayload` (domain/interfaces/queue.interface.ts) today:
```ts
export interface JobPayload {
  jobId: string;
  ticketId: string;
  ticketKey: string;
  ticketTitle: string;
  ticketDescription: string;
  cloneUrl: string;
  baseBranch: string;
}
```
Per checkpoint scope, `cloneUrl`/`baseBranch` stay as-is (sourced from global `config.repo.*`, unchanged) — we only *add* a field, we don't repoint existing ones. `run-agent-pipeline.use-case.ts` reading `projectConfig` is explicitly out of scope (Checkpoint 3).

## Planned changes

### 1. Prefix extraction helper — new file `src/infrastructure/linear/ticket-prefix.ts`
Sibling to the existing `delivery-dedupe.ts` in the same directory (Linear-specific webhook plumbing).
```ts
const TICKET_PREFIX_PATTERN = /^([A-Z]+)-\d+$/;

export function extractTicketPrefix(identifier: string): string | undefined {
  const match = TICKET_PREFIX_PATTERN.exec(identifier);
  return match?.[1];
}
```
- Anchored full-match (`^...$`), not the loose `^([A-Z]+)-\d+` from the prompt, so trailing garbage (`"GAN-43-extra"`) doesn't falsely match — tightening this is within the spirit of "fail-closed on unrecognized format" and is a one-line difference I'll flag explicitly rather than silently deviate: **open question below**.
- Returns `undefined` on no match (empty string, lowercase, no dash, no digits, etc.) — caller treats `undefined` the same as "no project found."

### 2. Wire `ProjectRegistry` into config bootstrap — `src/config/index.ts`
Add a second export next to `config`, loaded from the same YAML file/path so there's one source of truth for "where is caf.config.yaml":
```ts
import { ProjectRegistry } from './project-registry.js';
...
export const projectRegistry: ProjectRegistry = ProjectRegistry.load(YAML_CONFIG_PATH);
```
Loaded eagerly at module init (same pattern as `config`), so a bad `projects:` block fails startup fast (consistent with existing `config` fail-fast behavior), not silently at first webhook.

### 3. `JobPayload` gets `projectConfig` — `src/domain/interfaces/queue.interface.ts`
```ts
import type { ProjectConfig } from '../../config/project-registry.js';

export interface JobPayload {
  ...
  projectConfig: ProjectConfig;
}
```
Required (not optional) — reaching the enqueue step below is conditional on having found a matching project, so by construction every enqueued job has one. This is a small, deliberate domain→config import; `ProjectConfig` is a plain validated data shape (like `AppConfig`), not an infra detail, so I'm treating it the same tier as the config types already used elsewhere. Flagged as **open question** below in case you'd rather it live in `domain/interfaces` instead.

### 4. Webhook handler changes — `src/presentation/web/routes/webhooks.ts`
After the `ENABLE_PIPELINE_TRIGGER` check, before building `jobData`:
```ts
const prefix = extractTicketPrefix(payload.data.identifier);
const projectConfig = prefix ? projectRegistry.getByPrefix(prefix) : undefined;

if (!projectConfig) {
  logger.error('No project registered for ticket prefix', undefined, {
    identifier: payload.data.identifier,
    prefix,
  });
  return reply.status(200).send({ status: 'ignored', reason: 'No project registered for ticket prefix' });
}
```
Then add `projectConfig` into the existing `jobData` object literal. No other lines in the handler change.

### 5. Telegram notification on fail-closed — recommendation, not planned for this checkpoint

Investigated: `TelegramNotifier` (`INotifier`) is only ever instantiated in `src/worker.ts` (the BullMQ worker process). The webhook handler runs in the **web server process** (`src/presentation/web/server.ts` / `app.ts`), which currently has zero notifier wiring. Adding a Telegram ping here means either:
- constructing a second `TelegramNotifier` instance in the web process (duplicated env-gated construction logic), or
- adding a new `INotifier`-shaped method (`notifyUnroutedTicket` or similar) and threading it through `buildApp()`.

Both are more than a one-line addition and touch app wiring beyond "webhook handler + job payload." Per your instructions I'm not doing this silently — **recommend deferring it** to a follow-up (or folding into whichever checkpoint next touches web-process notifications) and shipping just the `logger.error(...)` call for this checkpoint. Log-level `error` should already be visible to whatever log aggregation/alerting exists. Let me know if you want it in-scope now instead.

## Test plan

New file `tests/unit/webhook-routing.test.ts` (or extend an existing webhooks test if one is added first — currently there is none for the route itself, only fixture reuse in `security.test.ts` for the crypto helpers). Uses Fastify's `app.inject()` against `buildApp()`, with `pipelineQueue.addJob` mocked (vitest `vi.mock` on `infrastructure/queue/client.js`) so no real Redis/BullMQ connection is needed, and a valid HMAC signature computed with the same secret the test config uses so requests pass gate 1 legitimately (not bypassing it).

Cases:
1. **`GAN-99` (registered prefix)** → mock queue's `addJob` called once; assert the payload it received has `projectConfig` matching `umkm-pos`'s config from `caf.config.yaml`; response is 202 `enqueued`.
2. **`XYZ-1` (well-formed, unregistered prefix)** → `addJob` NOT called; response 200; `logger.error` spy called with the identifier.
3. **Malformed identifiers** (`""`, `"12345"`, `"gan-1"` lowercase, `"GAN"` no dash/digits) → same fail-closed path as case 2, no 500s.
4. **Regression — signature gate still first**: a request with a bad/missing signature is rejected 401 *before* touching prefix logic, even if the body's `identifier` would otherwise match `GAN-*`. Verifiable by asserting `addJob` is never called and no `projectRegistry`-related log fires.
5. **Regression — existing dedupe/parse/state-transition/kill-switch gates unaffected**: reuse the existing fixture (`tests/fixtures/linear-issue-update-ready-for-ai.json`, identifier `CAF-123`) for a duplicate-delivery and a non-transition case to confirm those still short-circuit at 200 before reaching the new step (this fixture's `CAF` prefix is itself unregistered, so it also incidentally covers case 2's fail-closed path once it clears the earlier gates — using a `GAN-*` fixture for the earlier-gate tests to avoid conflating two behaviors in one assertion).

`ENABLE_PIPELINE_TRIGGER` and `LINEAR_WEBHOOK_SECRET` will need to be true/set in the test's config — check `tests/setup.ts` for how config is currently mocked/stubbed for other route-adjacent tests (`dashboard.test.ts` is the closest precedent) and follow the same pattern rather than inventing a new one.

## Verify checklist (from the prompt)
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] Test: `GAN-99` → enqueued with correct `projectConfig`
- [ ] Test: `XYZ-1` → 200, no enqueue, error logged
- [ ] Test: malformed identifier → fail-closed, no crash
- [ ] Regression: signature verification still gates first
- [ ] Regression: existing dedupe/parse/transition/kill-switch behavior unchanged

## Open questions (need your call before IMPLEMENT)

1. **Regex strictness**: prompt specifies `^([A-Z]+)-\d+` (unanchored at the end, so `"GAN-43-foo"` or `"GAN-43x"` would still match `"GAN"` under a literal reading with `.exec()`/`.match()` without a trailing `$`). I'd rather anchor with a trailing `$` so only a clean `PREFIX-<digits>` counts as recognized, per your own instruction that "format tidak dikenali" should fail closed rather than lenient-match. Confirm this tightening is fine, or you want literal unanchored behavviour.
2. **`ProjectConfig` import into `domain/interfaces/queue.interface.ts`**: is a domain interface importing a type from `config/` acceptable in this codebase's layering, or would you rather I define a local/duplicate shape in the domain layer (or move `ProjectConfig`'s type export to somewhere domain-visible)? No behavior difference, just where the type lives.
3. **Telegram notification on fail-closed** (see section 5 above): confirmed out of scope for this checkpoint unless you say otherwise — recommend a follow-up rather than wiring a second notifier instance into the web process now.

Once these are confirmed, I'll move to IMPLEMENT and write `verify-report.md` with actual command output.
