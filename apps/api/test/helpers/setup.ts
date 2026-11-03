import type { Role } from '@amdb/shared';
import { createApp, type AppDeps } from '../../src/app';
import { openDb } from '../../src/platform/db/open';
import { users } from '../../src/platform/db/schema';

/** Who a test request comes from: a signed-in user, an anonymous visitor with a token, or no one. */
export type Actor = { kind: 'user'; userId: string } | { kind: 'anon'; token: string } | { kind: 'none' };

/**
 * In-memory database + app. Requests authenticate with the `x-test-user` header; an anonymous
 * visitor is identified by `x-amdb-anon`.
 */
export async function setupTest(opts: Partial<Omit<AppDeps, 'db'>> = {}) {
  const { db, close } = await openDb('pglite:memory');
  const app = createApp({
    db,
    getSession: async (headers) => {
      const userId = headers.get('x-test-user');
      return userId ? { userId, createdAt: new Date() } : null;
    },
    ...opts,
  });
  const headersFor = (actor: Actor): Record<string, string> =>
    actor.kind === 'user'
      ? { 'x-test-user': actor.userId }
      : actor.kind === 'anon'
        ? { 'x-amdb-anon': actor.token }
        : {};
  const as = (actor: Actor) => ({
    get: (path: string) => app.request(path, { headers: headersFor(actor) }),
    post: (path: string, body?: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { ...headersFor(actor), 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
  });
  /** Inserts a user row directly; the user then signs in by sending its id in `x-test-user`. */
  const createUser = async ({ role = 'contributor', email }: { role?: Role; email?: string } = {}) => {
    const id = crypto.randomUUID();
    await db.insert(users).values({ id, email: email ?? `${id}@example.test`, name: 'Test User', role });
    return id;
  };
  return { app, db, close, as, createUser };
}
