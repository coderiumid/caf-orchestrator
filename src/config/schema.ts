import { z } from 'zod';

const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const nodeEnvs = ['development', 'production', 'test'] as const;

const boolEnvVar = (defaultVal: 'true' | 'false' = 'true') =>
  z.enum(['true', 'false', '1', '0']).default(defaultVal).transform(v => v === 'true' || v === '1');

// Exact-model-id allowlist for openai.defaultModel / agents.modelOverrides values —
// sourced solely from caf.config.yaml (openai.allowedModels), no built-in default
// list. Prefix matching (e.g. "gc/gemini-") let unverified model ids (like a
// nonexistent "gc/gemini-3.1-pro-preview") pass startup validation only to 404 at
// call time — exact-match closes that gap: a model must be individually verified
// and listed before it can be sent to the `claude` CLI. Fail-closed: an empty/unset
// list means no model passes.
export function isAllowedModel(model: string, allowedModels: readonly string[]): boolean {
  return allowedModels.includes(model);
}

// The set of `--agent <name>` values the pipeline ever spawns (see
// run-agent-pipeline.use-case.ts: caf-planner/caf-qa/caf-reviewer/caf-documentation are
// hardcoded literals, caf-frontend/caf-backend come from task-router.ts's TaskAgent union).
// There is no single existing source of truth for this list in the codebase — this is it.
export const KNOWN_AGENT_NAMES = ['caf-planner', 'caf-frontend', 'caf-backend', 'caf-qa', 'caf-reviewer', 'caf-documentation'] as const;

export interface AgentModelOverridesValidationResult {
  errors: string[];
}

// Validates the agents.modelOverrides map from caf.config.yaml (a native
// { agentName: model } object — YAML gives us structured data, so unlike the
// old AGENT_MODEL_OVERRIDES env var there is no "agentName=model" string to parse).
export function validateAgentModelOverrides(
  map: Record<string, string>,
  allowedModels: readonly string[],
): AgentModelOverridesValidationResult {
  const errors: string[] = [];

  for (const [agentName, model] of Object.entries(map)) {
    if (!(KNOWN_AGENT_NAMES as readonly string[]).includes(agentName)) {
      errors.push(`unknown agent "${agentName}" — known agents: ${KNOWN_AGENT_NAMES.join(', ')}`);
      continue;
    }
    if (!isAllowedModel(model, allowedModels)) {
      errors.push(`model "${model}" for agent "${agentName}" must be one of: ${allowedModels.join(', ')}`);
    }
  }

  return { errors };
}

// Secrets and operationally-toggled flags — stay in .env / secret manager,
// never move to the structural caf.config.yaml file.
const envSchema = z.object({
  NODE_ENV: z.enum(nodeEnvs).default('development'),
  LOG_LEVEL: z.enum(logLevels).default('info'),

  REDIS_URL: z.url({ message: 'REDIS_URL must be a valid URL' }),

  LINEAR_WEBHOOK_SECRET: z
    .string({ error: 'LINEAR_WEBHOOK_SECRET is required' })
    .min(1, 'LINEAR_WEBHOOK_SECRET cannot be empty'),
  LINEAR_API_KEY: z
    .string({ error: 'LINEAR_API_KEY is required' })
    .min(1, 'LINEAR_API_KEY cannot be empty'),

  GITHUB_TOKEN: z
    .string({ error: 'GITHUB_TOKEN is required' })
    .min(1, 'GITHUB_TOKEN cannot be empty'),

  // Secret configured on the GitHub repo webhook (Settings -> Webhooks) — signs
  // the raw body as `X-Hub-Signature-256: sha256=<hex>`. See
  // verifyGitHubSignature() in vcs/security.ts (CAF-PRREVIEW-01 Checkpoint B).
  GITHUB_WEBHOOK_SECRET: z
    .string({ error: 'GITHUB_WEBHOOK_SECRET is required' })
    .min(1, 'GITHUB_WEBHOOK_SECRET cannot be empty'),

  // Kill switch — kept in .env (not YAML) so it can be flipped without a
  // structural-config redeploy during an incident.
  ENABLE_PIPELINE_TRIGGER: boolEnvVar(),

  // Off by default: with this false, the pipeline behaves byte-for-byte like
  // it did before dynamic agent skip existed — routeTasks() ignores empty
  // Frontend/Backend Tasks sections and the "## Skip Agents" directives
  // Planner can emit are never even parsed. See
  // run-agent-pipeline.use-case.ts and task-router.ts's parseSkipDirectives.
  AGENT_SKIP_ENABLED: boolEnvVar('false'),

  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),

  OPENAI_API_KEY: z.string().min(1).optional(),

  // Native Claude Code CLI auth (OAuth token), passed through unchanged to the
  // spawned `claude` process via process.env — see spawn-agent.service.ts. This
  // is the only auth path besides openai.useOpenai; see superRefine below.
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),

  // Basic-auth password gating /admin/queues (Bull Board). Required in .env
  // only when dashboard.enabled is true in caf.config.yaml — see superRefine
  // below, same pairing pattern as TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID.
  DASHBOARD_BASIC_AUTH_PASSWORD: z.string().min(1).optional(),
});

// Structural (non-secret) config — sourced from caf.config.yaml.
const yamlSchema = z.object({
  server: z.object({
    port: z.coerce.number().int().positive().default(3000),
  }).default(() => ({ port: 3000 })),

  linear: z.object({
    apiUrl: z.url({ message: 'linear.apiUrl must be a valid URL' }).default('https://api.linear.app/graphql'),
    readyStateId: z
      .string({ error: 'linear.readyStateId is required' })
      .uuid('linear.readyStateId must be a valid UUID'),
    webhookTimestampToleranceMs: z.coerce.number().int().positive().default(60_000),
    deliveryDedupeTtlSeconds: z.coerce.number().int().positive().default(86_400),
  }),

  github: z.object({
    apiUrl: z.url({ message: 'github.apiUrl must be a valid URL' }).default('https://api.github.com'),
    // Separate namespace/TTL from linear.deliveryDedupeTtlSeconds — different
    // provider, kept independently configurable even though the default matches
    // (CAF-PRREVIEW-01 Checkpoint B, plan-checkpoint-b.md poin 2 option (a)).
    deliveryDedupeTtlSeconds: z.coerce.number().int().positive().default(86_400),
    // GitHub analog of linear.readyStateId: the label that transitions a
    // GitHub Issue into "Ready for AI" and triggers the full agent pipeline.
    readyLabel: z.string().min(1, 'github.readyLabel cannot be empty').default('ready-for-ai'),
  }).default(() => ({ apiUrl: 'https://api.github.com', deliveryDedupeTtlSeconds: 86_400, readyLabel: 'ready-for-ai' })),

  claude: z.object({
    command: z.string().default('claude'),
    agentTimeoutMs: z.coerce.number().int().positive().default(30 * 60_000),
  }).default(() => ({ command: 'claude', agentTimeoutMs: 30 * 60_000 })),

  workspace: z.object({
    dir: z.string().default('/tmp/caf-orchestrator/workspace'),
    // 'ephemeral' (default): behavior unchanged — every job clones to a fresh
    // job-<uuid> dir under workspace.dir and removes it after. 'persistent':
    // a job reuses a per-repo subfolder under workspace.dir across runs
    // instead of cloning fresh each time (CAF-WSMODE-01).
    mode: z.enum(['ephemeral', 'persistent']).default('ephemeral'),
  }).default(() => ({ dir: '/tmp/caf-orchestrator/workspace', mode: 'ephemeral' as const })),

  queue: z.object({
    jobTtlSeconds: z.coerce.number().int().positive().default(86_400),
    maxJobsRetained: z.coerce.number().int().positive().default(100),
    // Full-retry v1: on a failed attempt (including a killed agent process) the
    // whole job re-runs from clone. No step-resume state is persisted (see risk
    // #2 in caf-orchestrator-plan.md). Default 3 matches the PIV retry-max-3x
    // pattern used across agent definitions (caf-frontend.md, caf-backend.md).
    jobAttempts: z.coerce.number().int().positive().default(3),
    backoffDelayMs: z.coerce.number().int().positive().default(10_000),
    // Concurrent Claude Code agent processes per worker. Default 1 — running
    // multiple concurrently is expensive (CPU + API cost + contention).
    workerConcurrency: z.coerce.number().int().positive().default(1),
  }).default(() => ({
    jobTtlSeconds: 86_400,
    maxJobsRetained: 100,
    jobAttempts: 3,
    backoffDelayMs: 10_000,
    workerConcurrency: 1,
  })),

  // Pipeline gate retries — how many times to re-run implementation agents
  // after a QA FAIL / reviewer CHANGES_REQUESTED before stopping for human
  // review. Also carries the per-agent model override map.
  agents: z.object({
    qa: z.object({
      maxRetries: z.coerce.number().int().nonnegative().default(1),
    }).default(() => ({ maxRetries: 1 })),
    reviewer: z.object({
      maxRetries: z.coerce.number().int().nonnegative().default(1),
    }).default(() => ({ maxRetries: 1 })),
    modelOverrides: z.record(z.string(), z.string()).default({}),
  }).default(() => ({ qa: { maxRetries: 1 }, reviewer: { maxRetries: 1 }, modelOverrides: {} })),

  // Opt-in routing of spawned Claude Code agents through OpenRouter's
  // Anthropic-compatible endpoint (failover + budget visibility). Off by
  // default; must be explicitly enabled, not inferred from key presence
  // alone, so a stray OPENAI_API_KEY in the environment during local
  // testing doesn't silently reroute traffic.
  openai: z.object({
    useOpenai: z.boolean().default(false),
    baseUrl: z.url({ message: 'openai.baseUrl must be a valid URL' }).default('https://openrouter.ai/api'),
    // Overrides the model the claude CLI uses when routed through OpenRouter
    // (maps to ANTHROPIC_DEFAULT_SONNET_MODEL in the child process). Optional —
    // unset means the CLI's own default model is used, same as pre-OpenRouter
    // behavior.
    defaultModel: z.string().min(1).optional(),
    // Exact model ids, not prefixes — see isAllowedModel above. No built-in default;
    // fail-closed to an empty list if caf.config.yaml doesn't set this.
    allowedModels: z.array(z.string().min(1)).default([]),
  }).default(() => ({
    useOpenai: false,
    baseUrl: 'https://openrouter.ai/api',
    allowedModels: [],
  })),

  // Global fallback for repo-registry entries that don't set their own
  // orchestration.maxOrchestrationRetries (see project-config.schema.ts) —
  // caps how many times CAF-RETRYPIPELINE-01's cross-invocation retry
  // (orchestrationRetryCount, persisted in orchestration-state.json) may
  // re-run before the pipeline stops offering automatic retry. Distinct from
  // agents.qa/reviewer maxRetries above, which are per-invocation gate
  // retries reset on every orchestrator run.
  orchestration: z.object({
    maxOrchestrationRetries: z.coerce.number().int().nonnegative().default(2),
  }).default(() => ({ maxOrchestrationRetries: 2 })),

  // Bull Board dashboard at /admin/queues, basic-auth gated. Off by default —
  // fail-safe, must be explicitly enabled.
  dashboard: z.object({
    enabled: z.boolean().default(false),
    basicAuthUser: z.string().min(1).optional(),
  }).default(() => ({ enabled: false })),
});

export const configSchema = envSchema.extend(yamlSchema.shape).superRefine((data, ctx) => {
  const hasToken = !!data.TELEGRAM_BOT_TOKEN;
  const hasChatId = !!data.TELEGRAM_CHAT_ID;
  if (hasToken !== hasChatId) {
    const missing = hasToken ? 'TELEGRAM_CHAT_ID' : 'TELEGRAM_BOT_TOKEN';
    ctx.addIssue({
      code: 'custom' as const,
      path: [missing],
      message: `${missing} is required when the other TELEGRAM_* variable is set`,
    });
  }

  if (data.openai.useOpenai && !data.OPENAI_API_KEY) {
    ctx.addIssue({
      code: 'custom' as const,
      path: ['OPENAI_API_KEY'],
      message: 'OPENAI_API_KEY is required when openai.useOpenai is true',
    });
  }

  // Fail-fast: the claude CLI needs exactly one valid auth path at startup.
  // Without this, useOpenai:false + no CLAUDE_CODE_OAUTH_TOKEN silently spawns
  // an unauthenticated `claude` process — it only surfaces when the first job
  // runs and the agent fails to spawn.
  if (!data.openai.useOpenai && !data.CLAUDE_CODE_OAUTH_TOKEN) {
    ctx.addIssue({
      code: 'custom' as const,
      path: ['CLAUDE_CODE_OAUTH_TOKEN'],
      message:
        'No valid Claude Code CLI auth path configured. Set openai.useOpenai: true with OPENAI_API_KEY, or provide CLAUDE_CODE_OAUTH_TOKEN.',
    });
  }

  if (data.openai.defaultModel && !isAllowedModel(data.openai.defaultModel, data.openai.allowedModels)) {
    ctx.addIssue({
      code: 'custom' as const,
      path: ['openai', 'defaultModel'],
      message: `openai.defaultModel must be one of: ${data.openai.allowedModels.join(', ')}`,
    });
  }

  const { errors } = validateAgentModelOverrides(data.agents.modelOverrides, data.openai.allowedModels);
  for (const message of errors) {
    ctx.addIssue({
      code: 'custom' as const,
      path: ['agents', 'modelOverrides'],
      message: `agents.modelOverrides ${message}`,
    });
  }

  if (data.dashboard.enabled) {
    if (!data.dashboard.basicAuthUser) {
      ctx.addIssue({
        code: 'custom' as const,
        path: ['dashboard', 'basicAuthUser'],
        message: 'dashboard.basicAuthUser is required when dashboard.enabled is true',
      });
    }
    if (!data.DASHBOARD_BASIC_AUTH_PASSWORD) {
      ctx.addIssue({
        code: 'custom' as const,
        path: ['DASHBOARD_BASIC_AUTH_PASSWORD'],
        message: 'DASHBOARD_BASIC_AUTH_PASSWORD is required when dashboard.enabled is true',
      });
    }
  }
});

export type AppConfig = z.infer<typeof configSchema>;
