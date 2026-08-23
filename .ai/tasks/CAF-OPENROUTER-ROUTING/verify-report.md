STATUS: SUCCESS

## Scope
Opt-in, backward-compatible OpenRouter routing for spawned Claude Code agents.
Off by default; requires explicit `USE_OPENAI=true` (not inferred from key
presence). Originally model routing (`ANTHROPIC_DEFAULT_SONNET_MODEL`) was
excluded pending separate tool-use reliability testing; user explicitly
requested it be added now via `OPENAI_DEFAULT_MODEL` (still optional,
no-op unless set).

## Changes
- `src/config/schema.ts`: added `USE_OPENAI` (boolEnvVar, default `false`),
  `OPENAI_API_KEY` (optional string), `OPENAI_BASE_URL` (URL,
  default `https://openrouter.ai/api`), and `OPENAI_DEFAULT_MODEL`
  (optional string, no validation on the model id itself). Extended
  `superRefine` to reject `USE_OPENAI=true` without `OPENAI_API_KEY`
  — fails fast at startup, no silent fallback to direct Anthropic.
- `src/infrastructure/agent/spawn-agent.service.ts`: conditionally builds
  `env` for the spawned `claude` process — `USE_OPENAI=false` (default)
  passes `process.env` unchanged (identical to pre-change behavior); `true`
  spreads `...process.env` plus `ANTHROPIC_BASE_URL: config.OPENAI_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY: ''`, and — only when
  `OPENAI_DEFAULT_MODEL` is set — `ANTHROPIC_DEFAULT_SONNET_MODEL`. No
  secret values logged anywhere.
- `.env.example`: documented all four new vars as optional, commented out by
  default.
- Tests:
  - `tests/unit/spawn-agent.service.test.ts`: mocks `config` and
    `node:child_process.spawn`; asserts (1) `USE_OPENAI=false` → `env`
    passed to `spawn` is `process.env` by reference, `ANTHROPIC_BASE_URL`
    undefined, `PATH` intact; (2) `USE_OPENAI=true` + key set → all
    OpenRouter env vars present with correct values, `ANTHROPIC_DEFAULT_SONNET_MODEL`
    undefined when `OPENAI_DEFAULT_MODEL` unset, `PATH` still intact;
    (3) `OPENAI_DEFAULT_MODEL` set → `ANTHROPIC_DEFAULT_SONNET_MODEL`
    injected with matching value; (4) custom `OPENAI_BASE_URL` honored.
  - `tests/unit/schema.test.ts`: asserts default parse leaves
    `USE_OPENAI=false`, `OPENAI_BASE_URL` at the OpenRouter default,
    `OPENAI_DEFAULT_MODEL` unset; `true`+key parses successfully; `true`
    without key fails validation with an issue on `OPENAI_API_KEY`;
    custom `OPENAI_BASE_URL` accepted; non-URL `OPENAI_BASE_URL`
    rejected; `OPENAI_DEFAULT_MODEL` accepted when provided.

## Acceptance Criteria
- [x] Default behavior (no env vars set) unchanged — no new env injected into
      child process.
- [x] `USE_OPENAI=true` + `OPENAI_API_KEY` set → child process gets
      `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` overrides.
- [x] `USE_OPENAI=true` without key → config validation fails at startup
      (not silent).
- [x] `process.env` (incl. `PATH`) passed through intact in both branches.
- [x] No secrets logged.
- [x] `OPENAI_DEFAULT_MODEL` unset → no `ANTHROPIC_DEFAULT_SONNET_MODEL`
      override (behavior unchanged); set → overridden to given value.

## Quality Gate
- `pnpm test` — 6 test files, 47 tests, all PASS (incl. new
  `OPENAI_BASE_URL`/`OPENAI_DEFAULT_MODEL` cases).
- `pnpm typecheck` (`tsc --noEmit`) — clean.
- `pnpm lint` (`eslint src`) — clean.
