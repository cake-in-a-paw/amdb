import { setupTest } from '@amdb/api/testing';
import { createApiClient } from '@amdb/shared/api';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, onTestFinished, vi } from 'vitest';
import { anonHeaders } from '@/lib/api';
import type { AuthClient } from '@/lib/auth';
import { createAppRouter } from '@/router';

/** The in-process API: `app`, `db`, `as(actor)` for raw requests, and `createUser`. */
export type TestApi = Awaited<ReturnType<typeof setupTest>>;

type ArtDeps = NonNullable<NonNullable<Parameters<typeof setupTest>[0]>['art']>;

export type SignedInAs = 'anonymous' | 'contributor' | 'moderator' | 'admin';

/**
 * Who the app and the API both think is signed in. The API client sends `x-test-user` from it on
 * every request, and the stub auth client changes it, so the two can't disagree.
 */
export interface Session {
  userId: string | null;
}

/** A Better Auth stand-in that acts on the shared session, with knobs to drive each flow. */
export interface StubAuth extends AuthClient {
  /** Every call, in order, with its arguments. */
  calls: { method: string; args: unknown }[];
  /** The user a successful email-code or passkey sign-in signs in as; set it before signing in. */
  signInAs: string | null;
  /** What `listUserPasskeys` returns. */
  passkeys: unknown[];
  /** Methods (`signOut`, `sendVerificationOtp`, `emailOtp`, `addPasskey`) that answer with an error. */
  failing: Set<string>;
}

export function stubAuth(session: Session): StubAuth {
  const calls: StubAuth['calls'] = [];
  const stub: StubAuth = {
    calls,
    signInAs: null,
    passkeys: [],
    failing: new Set(),
    signIn: {
      social: async (args) => {
        calls.push({ method: 'social', args });
        return { data: null, error: null };
      },
      emailOtp: async (args) => {
        calls.push({ method: 'emailOtp', args });
        if (stub.failing.has('emailOtp') || args.otp !== '123456') {
          return { error: { status: 400, error: { code: 'INVALID_OTP' } } };
        }
        session.userId = stub.signInAs;
        return { data: {}, error: null };
      },
      passkey: async () => {
        calls.push({ method: 'passkey', args: undefined });
        if (!stub.signInAs) return { error: { status: 400 } };
        session.userId = stub.signInAs;
        return { data: {}, error: null };
      },
    },
    emailOtp: {
      sendVerificationOtp: async (args) => {
        calls.push({ method: 'sendVerificationOtp', args });
        return stub.failing.has('sendVerificationOtp') ? { error: { status: 500 } } : { data: {}, error: null };
      },
    },
    passkey: {
      addPasskey: async () => {
        calls.push({ method: 'addPasskey', args: undefined });
        return stub.failing.has('addPasskey') ? { error: { status: 400 } } : { data: {}, error: null };
      },
      listUserPasskeys: async () => ({ data: stub.passkeys, error: null }),
    },
    signOut: async () => {
      calls.push({ method: 'signOut', args: undefined });
      if (stub.failing.has('signOut')) return { error: { message: 'down', status: 500 } };
      session.userId = null;
      return { data: { success: true }, error: null };
    },
  };
  return stub;
}

/**
 * Mounts the real router at `path` (memory history) on the real API, in process on a fresh
 * Postgres database: `app.fetch` behind the typed client, so requests take the same path as in
 * production minus the network. Only Better Auth's browser client is stubbed. `seed` runs before
 * the first render, so the first queries see its data. Teardown is registered here, unmounting
 * before the database closes so no query lands on a closed database.
 */
export async function renderApp<Seeded = undefined>(
  path: string,
  opts: {
    as?: SignedInAs;
    seed?: (api: TestApi) => Promise<Seeded>;
    /** Where art comes from; omitted, every work has none and nothing is fetched. */
    art?: ArtDeps;
  } = {},
) {
  const api = await setupTest(opts.art ? { art: opts.art } : {});
  const role = opts.as ?? 'anonymous';
  const session: Session = { userId: role === 'anonymous' ? null : await api.createUser({ role }) };
  // Typed as Seeded: with no `seed`, Seeded defaults to undefined, which is what this holds.
  const seeded = (opts.seed ? await opts.seed(api) : undefined) as Seeded;

  const auth = stubAuth(session);
  const router = createAppRouter({
    api: createApiClient({
      baseUrl: 'http://amdb.test',
      // Hono's `request` takes a Request, a URL or a bare path, and resolves a relative one. It
      // doesn't follow redirects the way a browser's fetch does, so a 308 (a merged id) is followed here.
      fetch: async (input, init) => {
        let res = await api.app.request(input, init);
        for (let hops = 0; hops < 5 && res.status === 308; hops++) {
          const location = res.headers.get('location');
          if (!location) break;
          // Each hop carries the request's headers and its abort signal, as a browser's redirect does.
          res = await api.app.request(
            location,
            input instanceof Request
              ? { headers: input.headers, signal: input.signal }
              : { headers: init?.headers, signal: init?.signal ?? null },
          );
        }
        return res;
      },
      headers: (request): Record<string, string> => ({
        ...(session.userId ? { 'x-test-user': session.userId } : {}),
        ...anonHeaders(() => session.userId !== null, request),
      }),
    }),
    auth,
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
  return { user, router, auth, api, db: api.db, session, seeded, view };
}

type Client = ReturnType<TestApi['as']>;
type Created = { id: string; changes: { id: string; entityId: string | null }[] };

/** The signed-in contributor and moderator that `seed` and `publish` act as. */
export async function actors(api: TestApi) {
  return {
    contributor: api.as({ kind: 'user', userId: await api.createUser() }),
    moderator: api.as({ kind: 'user', userId: await api.createUser({ role: 'moderator' }) }),
  };
}

/** Submits `changes` with the CC0 agreement as `author` and approves each as `moderator`, the real way. */
export async function publish(author: Client, moderator: Client, changes: unknown[]): Promise<Created> {
  const res = await author.post('/api/submissions', { cc0: true, changes });
  expect(res.status, await res.clone().text()).toBe(201);
  const created = (await res.json()) as Created;
  for (const change of created.changes) {
    const approved = await moderator.post(`/api/changes/${change.id}/approve`);
    expect(approved.status, await approved.clone().text()).toBe(200);
  }
  return created;
}

/**
 * Publishes a small catalog the real way: a contributor submits with the CC0 agreement and a
 * moderator approves each change. Returns the ids by name, and the id of each entity's `create`.
 *
 *   Miyazaki directed Spirited Away, Howl's Moving Castle (film) and Princess Mononoke.
 *   Jones wrote Howl's Moving Castle (book, no. 1 of the "Howl's Castle" series) and Castle in
 *   the Air (no. 2, a sequel; added first so title order and position order differ).
 *   The film is adapted from the book; both belong to the property "Howl's Moving Castle".
 *   Spirited Away and Princess Mononoke are tagged Fantasy. Amélie is on its own.
 */
export async function seed(api: TestApi) {
  const { contributor, moderator } = await actors(api);
  const changes = [
    work('spiritedAway', 'Spirited Away', 'film_tv', 2001, {
      releaseMonth: 7,
      description: 'A girl works in a bathhouse for spirits.',
      lifecycle: 'released',
    }),
    work('howlsMovingCastle', "Howl's Moving Castle", 'film_tv', 2004),
    work('howlsNovel', "Howl's Moving Castle", 'book', 1986),
    work('castleInTheAir', 'Castle in the Air', 'book', 1990),
    work('mononoke', 'Princess Mononoke', 'film_tv', 1997),
    work('amelie', 'Amélie', 'film_tv', 2001),
    creator('miyazaki', 'Hayao Miyazaki'),
    creator('jones', 'Diana Wynne Jones'),
    { op: 'create', kind: 'series', ref: 'howlsSeries', fields: { title: "Howl's Castle" } },
    { op: 'create', kind: 'property', ref: 'howlsProperty', fields: { title: "Howl's Moving Castle" } },
    { op: 'create', kind: 'tag', ref: 'fantasy', fields: { kind: 'genre', name: 'Fantasy', slug: 'fantasy' } },
    credit('spiritedAway', 'miyazaki', 'director'),
    credit('howlsMovingCastle', 'miyazaki', 'director'),
    credit('mononoke', 'miyazaki', 'director'),
    credit('howlsNovel', 'jones', 'author'),
    credit('castleInTheAir', 'jones', 'author'),
    relate('series_work', 'howlsSeries', 'castleInTheAir', { position: 2 }),
    relate('series_work', 'howlsSeries', 'howlsNovel', { position: 1 }),
    relate('property_work', 'howlsProperty', 'howlsNovel'),
    relate('property_work', 'howlsProperty', 'howlsMovingCastle'),
    relate('work_tag', 'spiritedAway', 'fantasy'),
    relate('work_tag', 'mononoke', 'fantasy'),
    relate('work_link', 'howlsMovingCastle', 'howlsNovel', { linkType: 'adapted_from' }),
    relate('work_link', 'castleInTheAir', 'howlsNovel', { linkType: 'sequel_of' }),
  ];
  const created = await publish(contributor, moderator, changes);

  const ids: Record<string, string> = {};
  const createdBy: Record<string, string> = {};
  changes.forEach((change, seq) => {
    const made = created.changes[seq];
    if (change.op !== 'create' || !made?.entityId) return;
    ids[change.ref] = made.entityId;
    createdBy[change.ref] = made.id;
  });
  const pick = <K extends string>(refs: readonly K[]) =>
    Object.fromEntries(
      refs.map((ref) => {
        const id = ids[ref];
        if (!id) throw new Error(`seed made no entity for ${ref}`);
        return [ref, id];
      }),
    ) as Record<K, string>;
  return {
    works: pick(['spiritedAway', 'howlsMovingCastle', 'howlsNovel', 'castleInTheAir', 'mononoke', 'amelie']),
    creators: pick(['miyazaki', 'jones']),
    series: pick(['howlsSeries']),
    properties: pick(['howlsProperty']),
    tags: pick(['fantasy']),
    /** The id of the change that created each entity, by the same names. */
    createdBy,
  };
}

const work = (
  ref: string,
  title: string,
  mediaType: 'film_tv' | 'book',
  releaseYear: number,
  extra: Record<string, unknown> = {},
) => ({
  op: 'create' as const,
  kind: 'work',
  ref,
  fields: { mediaType, subtype: mediaType === 'film_tv' ? 'movie' : null, title, releaseYear, ...extra },
});
const creator = (ref: string, name: string) => ({
  op: 'create' as const,
  kind: 'creator',
  ref,
  fields: { name, kind: 'person' },
});
const credit = (workRef: string, creatorRef: string, role: string) =>
  relate('work_creator', workRef, creatorRef, { role });
const relate = (type: string, from: string, to: string, data: Record<string, unknown> = {}) => ({
  op: 'relate' as const,
  type,
  from: { ref: from },
  to: { ref: to },
  data,
});

/** A film/TV work of `subtype`, made under `ref`. */
export const tvWork = (ref: string, subtype: string, title: string) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType: 'film_tv', subtype, title },
});
export const partOf = (parent: string, child: string, position?: number) => ({
  op: 'relate',
  type: 'work_part',
  from: { ref: parent },
  to: { ref: child },
  data: position === undefined ? {} : { position },
});

/** Publishes `changes` the real way and returns each create's entity id by its ref. */
export async function publishTree(api: TestApi, changes: ReturnType<typeof tvWork | typeof partOf>[]) {
  const { contributor, moderator } = await actors(api);
  const made = await publish(contributor, moderator, changes);
  return idsByRef(changes, made.changes);
}

/**
 * Publishes the show `Show` the real way: season `S1` (no. 1) holding episodes `Pilot` (no. 1) and
 * `Two` (no. 2), and the creator `Showrunner`, who wrote `Pilot` and directed `Two`. With
 * `directedShow`, they also directed `Show` itself. Returns each id by name, and `showCreate`, the
 * id of the change that created `Show`.
 */
export async function publishShowCredits(api: TestApi, opts: { directedShow?: boolean } = {}) {
  const changes = [
    tvWork('show', 'series', 'Show'),
    tvWork('s1', 'season', 'S1'),
    tvWork('pilot', 'episode', 'Pilot'),
    tvWork('two', 'episode', 'Two'),
    creator('showrunner', 'Showrunner'),
    partOf('show', 's1', 1),
    partOf('s1', 'pilot', 1),
    partOf('s1', 'two', 2),
    credit('pilot', 'showrunner', 'writer'),
    credit('two', 'showrunner', 'director'),
    ...(opts.directedShow ? [credit('show', 'showrunner', 'director')] : []),
  ];
  const { contributor, moderator } = await actors(api);
  const made = (await publish(contributor, moderator, changes)).changes;
  const { show, s1, pilot, two, showrunner } = idsByRef(changes, made);
  const showCreate = made[0]?.id;
  if (!show || !s1 || !pilot || !two || !showrunner || !showCreate) {
    throw new Error('the show fixture is missing an entity');
  }
  return { show, s1, pilot, two, creator: showrunner, showCreate };
}

export function idsByRef(changes: { op: string; ref?: string }[], made: { entityId: string | null }[]) {
  const ids: Record<string, string> = {};
  changes.forEach((change, i) => {
    const id = made[i]?.entityId;
    if (change.op === 'create' && change.ref && id) ids[change.ref] = id;
  });
  return ids;
}

const urlOf = (input: Request | string | URL) => (input instanceof Request ? input.url : String(input));

/**
 * Watches the in-process API; the returned function lists the bodies of the submission POSTs so
 * far. A request's body can be read once, so each is copied before the API takes it.
 */
export function watchSubmissionBodies(t: { api: TestApi }) {
  const real = t.api.app.request.bind(t.api.app);
  const bodies: Promise<{ cc0: boolean; changes: Record<string, unknown>[] }>[] = [];
  vi.spyOn(t.api.app, 'request').mockImplementation((input, init) => {
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    if (urlOf(input).endsWith('/api/submissions') && method === 'POST') {
      const text = input instanceof Request ? input.clone().text() : Promise.resolve(String(init?.body));
      bodies.push(text.then((raw) => JSON.parse(raw)));
    }
    return real(input, init);
  });
  return () => Promise.all(bodies);
}
