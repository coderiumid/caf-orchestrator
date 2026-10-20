import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../../config/index.js';

/**
 * Dashboard login session: a stateless signed cookie, issued by
 * POST /dashboard/login after the credentials (`dashboard.basicAuthUser` /
 * `DASHBOARD_BASIC_AUTH_PASSWORD`) check out. Replaces the browser's native
 * Basic Auth prompt, which EventSource could not use anyway. The one cookie
 * covers the pages, /api/pipelines* and the SSE stream (Path=/).
 *
 * Token: `<expiresAtMs>.<hmac>`, HMAC-SHA256 over `<user>.<expiresAtMs>` keyed
 * with the password — changing the password or the user invalidates every
 * session. Callers must only use this when `dashboard.enabled` is true (the
 * user and password are guaranteed set then, see schema.ts's `superRefine`).
 */
export const DASHBOARD_SESSION_COOKIE = 'caf_dashboard_session';
export const DASHBOARD_LOGIN_PATH = '/dashboard/login';
const SESSION_SECONDS = 12 * 60 * 60;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Equal-length comparison anyway so failure timing doesn't leak the length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function sign(expiresAt: number): string {
  const user = config.dashboard.basicAuthUser as string;
  const password = config.DASHBOARD_BASIC_AUTH_PASSWORD as string;
  return createHmac('sha256', password).update(`${user}.${expiresAt}`).digest('hex');
}

export function credentialsValid(username: unknown, password: unknown): boolean {
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  const userOk = safeEqual(username, config.dashboard.basicAuthUser as string);
  const passOk = safeEqual(password, config.DASHBOARD_BASIC_AUTH_PASSWORD as string);
  return userOk && passOk;
}

export function createSessionToken(now = Date.now()): string {
  const expiresAt = now + SESSION_SECONDS * 1000;
  return `${expiresAt}.${sign(expiresAt)}`;
}

export function verifySessionToken(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [expiresRaw, mac] = token.split('.');
  const expiresAt = Number(expiresRaw);
  if (!mac || !Number.isFinite(expiresAt) || expiresAt <= now) return false;
  return safeEqual(mac, sign(expiresAt));
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  return request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function hasValidSession(request: FastifyRequest): boolean {
  return verifySessionToken(readCookie(request, DASHBOARD_SESSION_COOKIE));
}

function secureFlag(request: FastifyRequest): string {
  return request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
}

export function sessionSetCookie(request: FastifyRequest): string {
  return `${DASHBOARD_SESSION_COOKIE}=${createSessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secureFlag(request)}`;
}

export function sessionClearCookie(request: FastifyRequest): string {
  return `${DASHBOARD_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(request)}`;
}

/** onRequest hook for HTML pages and their private assets: no session → redirect to the login page. */
export async function requireSessionOrRedirect(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!hasValidSession(request)) {
    return reply.redirect(DASHBOARD_LOGIN_PATH);
  }
}

/** onRequest hook for /api/*: no session → 401 JSON (the page reloads itself, which lands on the login page). */
export async function requireSessionOr401(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!hasValidSession(request)) {
    return reply.code(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Dashboard authentication required',
    });
  }
}
