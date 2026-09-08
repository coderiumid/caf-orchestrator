import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CAF-DASHBOARD-01: the dashboard SPA as three plain static files
 * (dashboard.html/.css/.js) read once at startup — nothing here is
 * request-specific, so there's no per-request templating to do.
 * dashboard-ui.ts serves the HTML at `/dashboard` and the CSS/JS at
 * `/dashboard/app.css` / `/dashboard/app.js`, all behind the same basic-auth
 * hook. Because these are referenced via external <link>/<script src> tags
 * (not inlined), helmet's default CSP (`script-src 'self'`, `style-src 'self'`)
 * already allows them — no CSP nonce plumbing needed, unlike the old
 * single-inline-file version this replaced.
 *
 * tsc does not copy non-TypeScript assets to dist/ — the Dockerfile has an
 * explicit COPY for these three files, same as schema.sql.
 */
const dashboardHtml = readFileSync(join(__dirname, 'dashboard.html'), 'utf-8');
const dashboardCss = readFileSync(join(__dirname, 'dashboard.css'), 'utf-8');
const dashboardJs = readFileSync(join(__dirname, 'dashboard.js'), 'utf-8');
const dashboardLogo = readFileSync(join(__dirname, '..', 'assets', 'logo.png'));

export function renderDashboardHtml(): string {
  return dashboardHtml;
}

export function renderDashboardCss(): string {
  return dashboardCss;
}

export function renderDashboardJs(): string {
  return dashboardJs;
}

export function renderDashboardLogo(): Buffer {
  return dashboardLogo;
}
