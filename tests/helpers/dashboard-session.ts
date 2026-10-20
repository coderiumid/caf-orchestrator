import { createHmac } from 'node:crypto';

/**
 * A valid `caf_dashboard_session` Cookie header value, built independently of
 * src/presentation/web/auth/dashboard-session.ts (same token format: `<expiresAtMs>.<hmac-sha256(password, "<user>.<expiresAtMs>")>`).
 */
export function sessionCookie(user: string, password: string, expiresAt = Date.now() + 3_600_000): string {
  const mac = createHmac('sha256', password).update(`${user}.${expiresAt}`).digest('hex');
  return `caf_dashboard_session=${expiresAt}.${mac}`;
}
