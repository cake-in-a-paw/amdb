import { setupTest } from '@amdb/api/testing';
import { createApiClient } from '@amdb/shared/api';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, onTestFinished } from 'vitest';
import type { AuthClient } from '@/lib/auth';
import { createAppRouter } from '@/router';

/** The in-process API: `app`, `db`, `as(actor)` for raw requests, and `createUser`. */
export type TestApi = Awaited<ReturnType<typeof setupTest>>;

export type SignedInAs = 'anonymous' | 'contributor' | 'moderator' | 'admin';

/**
 * Who the app and the API both think is signed in. The API client sends `x-test-user` from it on
 * every request, and the stub auth client changes it, so the two can't disagree.
 */
export interface Session {
  userId: string | null;
}

/** A Better Auth stand-in that acts on the shared session; pass your own to assert on calls. */
export function stubAuth(session: Session): AuthClient {
  return {
    signOut: async () => {
      session.userId = null;
      return { data: { success: true }, error: null };
    },
  };
}

/**
 * Mounts the real router at `path` (memory history) on the real API, in process on a fresh
 * PGlite: `app.fetch` behind the typed client, so requests take the same path as in production
 * minus the network. Only Better Auth's browser client is stubbed. `seed` runs before the first
 * render, so the first queries see its data. Teardown is registered here, unmounting before the
 * database closes so no query lands on a closed database.
 */
export async function renderApp<Seeded = undefined>(
  path: string,
  opts: { as?: SignedInAs; seed?: (api: TestApi) => Promise<Seeded> } = {},
) {
  const api = await setupTest();
  const role = opts.as ?? 'anonymous';
  const session: Session = { userId: role === 'anonymous' ? null : await api.createUser({ role }) };
  // Typed as Seeded: with no `seed`, Seeded defaults to undefined, which is what this holds.
  const seeded = (opts.seed ? await opts.seed(api) : undefined) as Seeded;

  const router = createAppRouter({
    api: createApiClient({
      baseUrl: 'http://amdb.test',
      // Hono's `request` takes a Request, a URL or a bare path, and resolves a relative one.
      fetch: async (input, init) => api.app.request(input, init),
      headers: (): Record<string, string> => (session.userId ? { 'x-test-user': session.userId } : {}),
    }),
    auth: stubAuth(session),
    history: createMemoryHistory({ initialEntries: [path] }),
    queryDefaults: { queries: { retry: false }, mutations: { retry: false } },
  });
  const user = userEvent.setup();
  const view = render(<RouterProvider router={router} />);
  onTestFinished(async () => {
    view.unmount();
    await router.options.context.queryClient.cancelQueries();
    router.options.context.queryClient.clear();
    await api.close();
  });
  // The root route loads before anything renders; wait so callers can query the shell at once.
  await router.load();
  return { user, router, api, db: api.db, session, seeded, view };
}

/**
 * Publishes a small catalog the real way: a contributor submits with the CC0 agreement and a
 * moderator approves each change. Returns the ids by name.
 */
export async function seed(api: TestApi) {
  const contributor = api.as({ kind: 'user', userId: await api.createUser() });
  const moderator = api.as({ kind: 'user', userId: await api.createUser({ role: 'moderator' }) });

  const res = await contributor.post('/api/submissions', {
    cc0: true,
    changes: [
      work('spiritedAway', 'Spirited Away', 'film_tv', 2001),
      work('howlsMovingCastle', "Howl's Moving Castle", 'film_tv', 2004),
      work('howlsNovel', "Howl's Moving Castle", 'book', 1986),
      creator('miyazaki', 'Hayao Miyazaki'),
      creator('jones', 'Diana Wynne Jones'),
      credit('spiritedAway', 'miyazaki', 'director'),
      credit('howlsMovingCastle', 'miyazaki', 'director'),
      credit('howlsNovel', 'jones', 'author'),
      {
        op: 'relate',
        type: 'work_link',
        from: { ref: 'howlsMovingCastle' },
        to: { ref: 'howlsNovel' },
        data: { linkType: 'adapted_from' },
      },
    ],
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const created = (await res.json()) as { changes: { id: string; entityId: string | null }[] };
  for (const change of created.changes) {
    const approved = await moderator.post(`/api/changes/${change.id}/approve`);
    expect(approved.status, await approved.clone().text()).toBe(200);
  }

  const id = (seq: number) => {
    const entityId = created.changes[seq]?.entityId;
    if (!entityId) throw new Error(`change ${seq} created no entity`);
    return entityId;
  };
  return {
    works: { spiritedAway: id(0), howlsMovingCastle: id(1), howlsNovel: id(2) },
    creators: { miyazaki: id(3), jones: id(4) },
  };
}

const work = (ref: string, title: string, mediaType: 'film_tv' | 'book', releaseYear: number) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType, subtype: mediaType === 'film_tv' ? 'movie' : null, title, releaseYear },
});
const creator = (ref: string, name: string) => ({
  op: 'create',
  kind: 'creator',
  ref,
  fields: { name, kind: 'person' },
});
const credit = (workRef: string, creatorRef: string, role: string) => ({
  op: 'relate',
  type: 'work_creator',
  from: { ref: workRef },
  to: { ref: creatorRef },
  data: { role },
});
