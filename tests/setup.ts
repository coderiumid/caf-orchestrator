// Ensures src/config/index.ts (Zod-validated env) can load during tests
// without requiring a real .env file. Only sets vars that are missing so a
// developer's local .env still takes precedence if present. Structural
// (non-secret) fields — readyStateId, repo.cloneUrl, etc. — come from the
// real caf.config.yaml at the repo root, same as it does for `pnpm dev`.
const defaults: Record<string, string> = {
  REDIS_URL: 'redis://localhost:6379',
  LINEAR_WEBHOOK_SECRET: 'test-webhook-secret',
  LINEAR_API_KEY: 'test-linear-api-key',
  GITHUB_TOKEN: 'test-github-token',
  GITHUB_WEBHOOK_SECRET: 'test-github-webhook-secret',
  // caf.config.yaml sets openai.useOpenai: true, which requires this to be set.
  OPENAI_API_KEY: 'test-openai-api-key',
  // caf.config.yaml sets dashboard.enabled: true, which requires this to be set.
  DASHBOARD_BASIC_AUTH_PASSWORD: 'test-dashboard-password',
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
