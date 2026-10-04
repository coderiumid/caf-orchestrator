import { config } from '../../../config/index.js';

/**
 * The cookie that authenticates the dashboard's SSE stream. EventSource can't
 * send an Authorization header, so a page handler sets this after Basic Auth
 * has succeeded and events.ts checks it. Shared by every page that opens the
 * stream (/dashboard, /dashboard/agent-floor) and by the stream itself, which
 * re-issues it on each successful connect so an open page keeps a fresh one.
 */
export const DASHBOARD_AUTH_COOKIE = 'caf_dashboard_auth';
const MAX_AGE_SECONDS = 3600;

export function dashboardAuthCookieValue(): string {
  return Buffer.from(`${config.dashboard.basicAuthUser}:${config.DASHBOARD_BASIC_AUTH_PASSWORD}`).toString('base64');
}

/** A complete Set-Cookie header value. `Path=/api` — the cookie is only ever needed by /api/events/stream. */
export function dashboardAuthSetCookie(): string {
  return `${DASHBOARD_AUTH_COOKIE}=${dashboardAuthCookieValue()}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`;
}
