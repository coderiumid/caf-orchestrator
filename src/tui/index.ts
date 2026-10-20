import { resolve } from 'node:path';
import { CLOUDFLARED_INSTALL_HINT } from '../tunnel/tunnel-options.js';
import { loadTuiConfig } from './infrastructure/config/tui-config.js';
import { TuiDataSource } from './infrastructure/data/tui-data-source.js';
import { ProcessManager } from './infrastructure/process/process-manager.js';
import { copyToClipboard } from './infrastructure/system/clipboard.js';
import { openUrl } from './infrastructure/system/open-url.js';
import { runApp } from './presentation/app.js';

/**
 * `pnpm tui` — terminal control panel: start/stop the web server, worker and
 * Cloudflare tunnel, and watch pipeline runs. This is the composition root:
 * the only place that knows the concrete infrastructure. Nothing under
 * src/tui/ may import config/index.ts (it throws without a full env), so the
 * TUI opens even when config is broken and reports the problems in a modal.
 */
async function main(): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error('caf tui needs an interactive terminal (stdout is not a TTY).');
    process.exit(1);
  }

  const repoRoot = resolve(process.cwd());
  const loaded = loadTuiConfig(repoRoot);
  // Best-effort settings are returned even for invalid config, so there is always something to show.
  const settings = loaded.settings!;

  const processes = new ProcessManager({
    repoRoot,
    // Worker waits for the running job on SIGTERM; give it the agent timeout plus a margin before SIGKILL.
    workerGraceMs: settings.agentTimeoutMs + 60_000,
    tunnel: settings.tunnel ? { command: settings.tunnel.command, args: settings.tunnel.args, notFoundHint: CLOUDFLARED_INSTALL_HINT } : null,
  });
  const data = new TuiDataSource(settings);

  // Last-resort: never leave children behind if the TUI itself dies.
  process.on('exit', () => processes.killAllNow());

  await runApp({
    settings,
    processes,
    data,
    configErrors: loaded.ok ? [] : loaded.errors,
    copyToClipboard: (text) => copyToClipboard(text),
    openUrl,
    version: process.env.npm_package_version ?? '',
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
