import type { Role } from '@amdb/shared';
import { createApp, type AppDeps } from '../../src/app';
import { ChangeInput } from '../../src/features/changes/schemas';
import { createChangesService } from '../../src/features/changes/service';
import { createImportsService } from '../../src/features/imports/service';
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
    patch: (path: string, body: unknown) =>
      app.request(path, {
        method: 'PATCH',
        headers: { ...headersFor(actor), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    post: (path: string, body?: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { ...headersFor(actor), 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
  });
  /** Inserts a user row directly; the user then signs in by sending its id in `x-test-user`. */
  const createUser = async ({
    role = 'contributor',
    email,
    name = 'Test User',
  }: { role?: Role; email?: string; name?: string } = {}) => {
    const id = crypto.randomUUID();
    await db.insert(users).values({ id, email: email ?? `${id}@example.test`, name, role });
    return id;
  };
  /**
   * Starts a Wikidata run, writes `changes` as one of its submissions the way the importer does, and
   * finishes the run (only one may be running at a time).
   */
  const importSubmission = async (changes: unknown[], params: Record<string, unknown> = {}) => {
    const imports = createImportsService(db);
    const { id: runId } = await imports.startRun({
      source: 'wikidata',
      params,
      licenseUrl: 'https://www.wikidata.org/wiki/Wikidata:Licensing',
      licenseCheckedOn: '2026-11-05',
    });
    try {
      const created = await createChangesService(db).importSubmission(
        runId,
        changes.map((c) => ChangeInput.parse(c)),
      );
      return { runId, ...created };
    } finally {
      await imports.finishRun(runId, { status: 'finished', stats: {} });
    }
  };
  return { app, db, close, as, createUser, importSubmission };
}
