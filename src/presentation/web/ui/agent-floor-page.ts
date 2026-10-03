import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CAF-DASHBOARD-02: the Agent Floor page as plain static files read once at
 * startup, same approach as dashboard-page.ts (no build step, no per-request
 * templating). agent-floor-ui.ts serves them under /dashboard/agent-floor.
 *
 * Everything is referenced through external <link>/<script src> tags, so
 * helmet's default CSP (`script-src 'self'`, no inline scripts or inline
 * event handlers) needs no changes.
 *
 * tsc does not copy non-TypeScript assets to dist/ — the Dockerfile has an
 * explicit COPY for this directory, same as the dashboard's own files.
 */
const dir = join(__dirname, 'agent-floor');

export interface AgentFloorAsset {
  contentType: string;
  body: string;
}

function asset(file: string, contentType: string): AgentFloorAsset {
  return { contentType, body: readFileSync(join(dir, file), 'utf-8') };
}

const page = asset('agent-floor.html', 'text/html');

/** Keyed by the file name in the URL (`/dashboard/agent-floor/<name>`). */
const assets: Readonly<Record<string, AgentFloorAsset>> = {
  'app.css': asset('agent-floor.css', 'text/css'),
  // render: world/canvas/panels. translate: contract event → render calls.
  // demo: mock scenarios. adapter: the only one that talks to the server.
  'render.js': asset('render.js', 'application/javascript'),
  'translate.js': asset('translate.js', 'application/javascript'),
  'demo.js': asset('demo.js', 'application/javascript'),
  'adapter.js': asset('adapter.js', 'application/javascript'),
};

export function renderAgentFloorHtml(): string {
  return page.body;
}

export function agentFloorAssets(): Readonly<Record<string, AgentFloorAsset>> {
  return assets;
}
