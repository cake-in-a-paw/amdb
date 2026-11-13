import { randomInt } from 'node:crypto';
import { createApp } from '../../src/app';
import { parseEnv } from '../../src/env';
import { createBeforeUserCreate } from '../../src/features/users/auth-hooks';
import { createAuth, getSessionFromAuth } from '../../src/platform/auth/auth';
import { openTestDb } from './test-db';

export const authTestEnv = (adminEmails = '') =>
  parseEnv({
    DATABASE_URL: 'pglite:memory',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    BETTER_AUTH_URL: 'http://localhost:3000',
    WEB_ORIGIN: 'http://localhost:5173',
    GOOGLE_CLIENT_ID: 'g',
    GOOGLE_CLIENT_SECRET: 'g',
    GITHUB_CLIENT_ID: 'h',
    GITHUB_CLIENT_SECRET: 'h',
    EMAIL_API_KEY: 'k',
    EMAIL_FROM: 'AMDB <code@example.test>',
    ADMIN_EMAILS: adminEmails,
  });

/**
 * Per-test Postgres database + an app wired like server.ts with real Better Auth. Email delivery is
 * faked: codes land in `sent`.
 */
export async function setupAuthTest(opts: { adminEmails?: string } = {}) {
  const { db, close } = await openTestDb();
  const env = authTestEnv(opts.adminEmails);
  const sent: { to: string; code: string }[] = [];
  const auth = createAuth(db, env, {
    beforeUserCreate: createBeforeUserCreate({ adminEmails: env.ADMIN_EMAILS }),
    sendSignInCode: async (to, code) => {
      sent.push({ to, code });
    },
  });
  const app = createApp({
    db,
    getSession: (h) => getSessionFromAuth(auth, h),
    authHandler: (req) => auth.handler(req),
  });
  // Better Auth's in-memory rate-limit store is shared across instances, so each gets its own client IP.
  const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const headers = (cookie?: string) => ({
    origin: 'http://localhost:5173',
    'x-forwarded-for': ip,
    ...(cookie ? { cookie } : {}),
  });
  const post = (path: string, body: unknown, cookie?: string) =>
    app.request(path, {
      method: 'POST',
      headers: { ...headers(cookie), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Sends a code to `email`, signs in with it and returns the session cookie. */
  const signInWithCode = async (email: string): Promise<string> => {
    const send = await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' });
    if (send.status !== 200) throw new Error(`send-verification-otp answered ${send.status}`);
    const code = sent.at(-1)?.code;
    if (!code) throw new Error('no code was sent');
    const res = await post('/api/auth/sign-in/email-otp', { email, otp: code });
    if (res.status !== 200) throw new Error(`sign-in/email-otp answered ${res.status}`);
    return res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  };

  return { app, db, close, post, signInWithCode };
}
