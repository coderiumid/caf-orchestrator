# Multi-Runner Agent Support (Claude Code / OpenCode) — Feasibility & Plan

Status: PLANNING ONLY. No implementation yet.

## 1. Motivation & scope

Operational need: switch agent runner (Claude Code vs OpenCode) via config
when one provider hits rate limits / downtime / cost issues. **Manual
switching only** — set env var, restart worker. Auto-failover (detect
rate-limit mid-run, auto-switch runner) is explicitly out of scope; revisit
after manual switching is proven stable in production.

## 2. Current state (read from code)

- `IAgentRunner` (`src/domain/interfaces/agent-runner.interface.ts`): single
  method `run(agentName, cwd, prompt): Promise<AgentRunResult>`.
  `AgentRunResult = { exitCode, signal, stdout, stderr, timedOut }`.
- `SpawnAgentService` (`src/infrastructure/agent/spawn-agent.service.ts`)
  is the only implementation today. It:
  - spawns `claude --agent <name> --print --permission-mode bypassPermissions`
  - writes `prompt` to stdin, closes stdin
  - enforces its own timeout (`CLAUDE_AGENT_TIMEOUT_MS`, default 30 min),
    SIGTERM then SIGKILL after 10s grace
  - captures stdout/stderr as Buffers, resolves on `close`
  - distinguishes "killed by signal" vs "exited non-zero" vs "spawn error"
  - logs every run (info) and every failure (error) with full stdout/stderr
- `RunAgentPipelineUseCase` calls `agentRunner.run(...)` for planner then for
  each routed implementation agent (backend/frontend/etc from
  `routeTasks(tasksMarkdown)`), treating `signal` or non-zero `exitCode` as
  hard failure (throws, no retry logic itself).
- Retry/lock policy lives in the queue layer, not the runner:
  `src/infrastructure/queue/client.ts` sets `attempts: 3` (BullMQ job
  retries), `src/infrastructure/queue/worker.ts` sets `lockDuration` far
  above `CLAUDE_AGENT_TIMEOUT_MS` so BullMQ's stall detector doesn't fire
  mid-run. **This lives outside `IAgentRunner` and is runner-agnostic
  already** — no changes needed there for multi-runner support, as long as
  a new runner's own timeout stays under `lockDuration`.
- Agent definitions live in `.claude/agents/*.md` (frontmatter: `name`,
  `description`, `tools`, `model`) — this repo passes `agentName` straight
  through as `--agent <name>`, assuming the target repo (umkm-pos) has a
  matching `.claude/agents/<name>.md`.

## 3. OpenCode CLI — headless equivalent (verified locally, opencode installed)

Confirmed via `opencode run --help`:

```
opencode run [message..] --agent <name> --dir <cwd> --auto --format json
```

- `--agent <name>` — direct equivalent of `claude --agent <name>`.
- `--dir <cwd>` — equivalent of spawn's `cwd` option (no need to `cd`).
- `--auto` — "auto-approve permissions that are not explicitly denied
  (dangerous!)" — equivalent of `--permission-mode bypassPermissions`. Same
  justification applies: each run is in a disposable clone workspace, so
  bypassing prompts is safe.
- `--format json` — raw JSON event stream instead of formatted text. **Use
  this**, not the default formatted output — gives structured events
  (message/tool/error) instead of free text, which will make stdout
  parsing (for verify-report/tasks.md detection, and for
  error-classification below) far more reliable than scraping Claude
  Code's plain stdout.
- Message body: `opencode run "<prompt>"` (positional args), vs Claude's
  stdin-pipe. `OpenCodeRunner` should pass prompt as an argv message, not
  stdin.
- No dedicated `--timeout` flag found — timeout enforcement stays
  orchestrator-side (`setTimeout` + `SIGTERM`/`SIGKILL`), same pattern as
  `SpawnAgentService`. Good: this means `IAgentRunner`'s contract doesn't
  need to change, only the spawned command/args differ.

## 4. Agent definitions — NOT directly reusable (confirmed empirically)

Ran `opencode agent list` inside umkm-pos (which has `.claude/agents/{backend,
frontend,planner,qa,reviewer,architect,documentation}.md`): OpenCode only
listed its own default `build` agent — **none of the `.claude/agents/*.md`
agents were picked up.** OpenCode does not read Claude Code's agent
directory format.

Confirmed OpenCode's own mechanism (from `~/.config/opencode/opencode.json`):
agents are declared under a top-level `"agent"` key in `opencode.json`
(JSON, not markdown frontmatter), e.g.:

```json
"agent": {
  "explorer": {
    "description": "...",
    "mode": "subagent",
    "model": "provider/model"
  }
}
```

OpenCode also supports (per its docs convention, not directly verified
in this session) per-agent markdown files under `.opencode/agent/*.md`
(singular `agent`, distinct from Claude's `.claude/agents/` plural) with
its own frontmatter schema (`mode`, `model`, `description` — no `tools`
array in the same shape as Claude's).

**Implication:** umkm-pos would need a parallel `.opencode/agent/*.md` (or
`opencode.json` `"agent"` block) defining `backend`, `frontend`, `planner`,
`qa`, `reviewer`, `architect`, `documentation` with OpenCode's schema and
equivalent prompts/scope restrictions. This is a **separate, non-trivial
task in the target repo (umkm-pos)**, not something caf-orchestrator can
paper over. Flag this explicitly as a blocking prerequisite for OpenCode
runner to be *useful* (the runner code itself can be built and tested
against OpenCode's default `build` agent, but won't produce equivalent
results to the Claude planner/backend/frontend/etc. agents until umkm-pos
gets matching agent defs).

## 5. Rate-limit error differentiation — open risk, not resolved

Motivation for this whole feature is rate-limit/downtime resilience, so
logs must clearly distinguish "agent failed because of a bug in its own
run" vs "agent failed because provider rate-limited it" — otherwise a
developer switching to OpenCode because Claude Code is rate-limited has no
way to tell if OpenCode is *also* rate-limited (e.g. if OpenCode is
configured to route through the same underlying Claude models via the
"9router" proxy seen in local opencode.json — worth checking whether
umkm-pos's OpenCode setup ultimately hits Claude/Anthropic anyway, which
would defeat the fallback's purpose).

Could not confirm OpenCode's exact rate-limit exit code / stderr format
in this session — no local package source for the CLI binary itself
(`~/.opencode/bin/opencode` is a compiled binary; `@opencode-ai/sdk` and
`@opencode-ai/plugin` packages in node_modules contain no rate-limit
string constants). This needs an **empirical test**: deliberately trigger
a rate limit (or find OpenCode's documented exit codes) and inspect the
`--format json` event stream for an explicit error-type field, which is
much safer to key off than stderr string-matching.

**Recommendation for implementation phase:** don't guess-parse stderr text
for both runners. Instead:
- For Claude Code: known behavior needs the same empirical check — grep
  existing production logs (if any exist) for what a real Claude Code rate
  limit looks like in stderr/exit code, or check Claude Code CLI docs.
- For OpenCode: use `--format json`, look for a structured `error` event
  with a `type`/`code` field rather than exit code alone.
- Add a `classifyFailure(result): 'rate_limit' | 'error' | 'timeout'` step
  per runner (not in the shared interface — each runner knows its own
  provider's error shape), surfaced as a new field on log output (not
  necessarily on `AgentRunResult` itself, to avoid coupling the domain
  interface to provider-specific error taxonomies prematurely).
- This classification work should happen with real failure samples in
  hand, not blind pattern-guessing — treat as a spike before finalizing.

## 6. Proposed structure

- **Config** (`src/config/schema.ts`): add
  ```ts
  AGENT_RUNNER: z.enum(['claude', 'opencode']).default('claude'),
  OPENCODE_COMMAND: z.string().default('opencode'),
  OPENCODE_AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60_000),
  ```
  (separate timeout var per runner, since the two CLIs may have different
  realistic run times; falls back to same default as Claude's).
- **`ClaudeCodeRunner`**: rename/move existing `SpawnAgentService` as-is
  (no behavior change) — just rename the class for symmetry with the new
  one. Keep `spawnAgentService` singleton export or replace with factory
  (see below).
- **`OpenCodeRunner`** (new, implements `IAgentRunner`): same
  spawn/timeout/kill/logging skeleton as `ClaudeCodeRunner`, but:
  - command: `config.OPENCODE_COMMAND`
  - args: `['run', prompt, '--agent', agentName, '--dir', cwd, '--auto', '--format', 'json']`
  - prompt passed as argv, not stdin
  - stdout is JSON-event-stream; `AgentRunResult.stdout` can stay raw text
    (use-case layer already just logs it and looks for files on disk via
    `report-reader.ts`, doesn't parse stdout as data) — so no interface
    change needed there.
- **Runner selection**: a small factory in composition root (wherever
  `spawnAgentService` is currently instantiated/injected — check
  `src/main.ts` or DI wiring), keyed on `config.AGENT_RUNNER`, chosen once
  at **worker startup**, not per-job. This matches the requirement:
  one runner per deployment/process lifetime, no mid-pipeline mixing.
- **No change** to `IAgentRunner`, `RunAgentPipelineUseCase`,
  `queue.interface.ts`, or BullMQ retry/lockDuration config — those are
  already runner-agnostic. Confirmed by reading
  `run-agent-pipeline.use-case.ts` (only depends on the interface) and
  `queue/client.ts` + `queue/worker.ts` (attempts: 3, lockDuration sized off
  `CLAUDE_AGENT_TIMEOUT_MS` — will need lockDuration to account for
  whichever of the two timeout configs is larger, if both could be active
  across restarts/deploys).

## 7. Consistency checklist for OpenCodeRunner (must not "forget" mitigations)

- [ ] Own timeout enforcement (SIGTERM → SIGKILL escalation), configurable,
      independent of BullMQ lock/stall detection
- [ ] `timedOut` flag surfaced same as Claude runner
- [ ] Distinguish signal-kill vs non-zero-exit vs spawn-error, same
      `AgentRunResult` shape
- [ ] Full stdout/stderr captured and logged on every run (success and
      failure), matching existing log fields (`agentName`, `exitCode`,
      `signal`, `timedOut`, `stdout`, `stderr`)
- [ ] Runs in the disposable per-job workspace clone (no shared state risk
      from `--auto` bypass)
- [ ] `lockDuration` in `queue/worker.ts` re-checked to stay above whichever
      timeout config is active for the selected runner

## 8. Remaining open questions before implementation

1. Does umkm-pos already have (or will someone write) `.opencode/agent/*.md`
   defs for backend/frontend/planner/qa/reviewer/architect/documentation?
   Without these, OpenCode runner is functional but not useful for the real
   pipeline — worth confirming scope/owner before implementing the runner.
2. Does OpenCode in umkm-pos's actual provider config route to a genuinely
   different backend than Claude Code (real fallback), or to the same
   Anthropic models through a proxy (no real rate-limit independence)? Check
   umkm-pos's own `.opencode`/`opencode.json` provider config, not the
   global `~/.config/opencode/opencode.json` inspected here.
3. Rate-limit signature for both CLIs — needs empirical capture, not
   guessed, before building the classifyFailure step (section 5).

## 9. Note (unrelated, flagged in passing)

While inspecting `~/.config/opencode/opencode.json` for agent config
format, found a live-looking API key in plaintext (`9router` provider
block, `sk-...`). Not part of this repo, not touched by this plan — flagging
only because it's a plaintext credential in a config file, worth the user's
own attention outside this task.
