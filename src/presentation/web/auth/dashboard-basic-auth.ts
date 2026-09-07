import { timingSafeEqual } from 'node:crypto';
import basicAuth from '@fastify/basic-auth';
import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers so failure timing
    // doesn't leak the correct credential length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Registers @fastify/basic-auth on `instance` using the same credentials as
 * Bull Board (`config.dashboard.basicAuthUser` / `DASHBOARD_BASIC_AUTH_PASSWORD`) —
 * CAF-DASHBOARD-01 Task 5's "reuse basic auth middleware yang sama dengan Bull
 * Board (bukan bikin auth baru)". Extracted from dashboard.ts (which used to
 * inline this) so /api/pipelines* and /api/events/stream share the exact
 * same validate logic instead of drifting copies.
 *
 * Each caller registers its own plugin instance scoped to its own Fastify
 * encapsulation branch — decorators don't cross sibling `app.register()`
 * branches, so this must be called (and the resulting `onRequest` hook
 * added) separately in every route file that needs it, same as before
 * extraction. Callers must guard on `config.dashboard.enabled` themselves
 * before calling this — `basicAuthUser`/`DASHBOARD_BASIC_AUTH_PASSWORD` are
 * only guaranteed set when that flag is on (see schema.ts's `superRefine`).
 */
export async function registerDashboardBasicAuth(instance: FastifyInstance): Promise<void> {
  const expectedUser = config.dashboard.basicAuthUser as string;
  const expectedPassword = config.DASHBOARD_BASIC_AUTH_PASSWORD as string;

  await instance.register(basicAuth, {
    validate: (username, password, _req, _reply, done) => {
      const userOk = timingSafeCompare(username, expectedUser);
      const passOk = timingSafeCompare(password, expectedPassword);
      done(userOk && passOk ? undefined : new Error('Unauthorized'));
    },
    authenticate: { realm: 'caf-orchestrator dashboard' },
  });
}
