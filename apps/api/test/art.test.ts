import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtDeps } from '../src/features/art/sources';
import { entities } from '../src/platform/db/schema';
import { publish } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const KEY = 'tmdb-secret-key-7f3a9c';
const START = Date.parse('2026-11-08T12:00:00Z');
const USER_AGENT = 'AMDB/0.1 (https://github.com/cake-in-a-paw/amdb)';

type Call = { url: string; method: string; headers: Headers; signal?: AbortSignal | null; body?: unknown };
type Reply = Response | Promise<Response>;

/** What each faked source answers. Every handler can be replaced per test. */
interface Sources {
  tmdb: (kind: 'movie' | 'tv', id: string) => Reply;
  olCover: (olid: string) => Reply;
  olWork: (olid: string) => Reply;
  anilist: (id: number) => Reply;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const defaults: Sources = {
  tmdb: (kind, id) => json({ id: Number(id), poster_path: `/${kind}${id}.jpg` }),
  olCover: () => new Response(null, { status: 200 }),
  olWork: () => json({ covers: [8231856] }),
  anilist: (id) =>
    json({
      data: {
        Media: {
          coverImage: {
            medium: `https://s4.anilist.co/file/anilistcdn/media/anime/cover/small/bx${id}.jpg`,
            large: `https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx${id}.jpg`,
          },
        },
      },
    }),
};

/** A clock that only moves when something sleeps; a sleep ends at its own start plus `ms`. */
function fakeClock() {
  let t = START;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      const end = t + ms;
      await Promise.resolve();
      t = Math.max(t, end);
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function setup(overrides: Partial<Sources> = {}, artDeps: Partial<ArtDeps> = {}) {
  const sources = { ...defaults, ...overrides };
  const clock = fakeClock();
  const calls: Call[] = [];
  const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      url: url.href,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      signal: init.signal,
      body,
    });
    const tmdb = /^\/3\/(movie|tv)\/(\d+)$/.exec(url.pathname);
    if (url.host === 'api.themoviedb.org' && tmdb) return sources.tmdb(tmdb[1] as 'movie' | 'tv', tmdb[2]!);
    const cover = /^\/b\/olid\/(OL\d+M)-M\.jpg$/.exec(url.pathname);
    if (url.host === 'covers.openlibrary.org' && cover) return sources.olCover(cover[1]!);
    const work = /^\/works\/(OL\d+W)\.json$/.exec(url.pathname);
    if (url.host === 'openlibrary.org' && work) return sources.olWork(work[1]!);
    if (url.host === 'graphql.anilist.co') {
      return sources.anilist((body as { variables: { id: number } }).variables.id);
    }
    throw new Error(`unexpected fetch ${url.host}${url.pathname}`);
  };
  const t = await setupTest({
    art: {
      // The fake implements the part of fetch the sources use.
      fetch: fakeFetch as typeof fetch,
      tmdbApiKey: KEY,
      now: clock.now,
      sleep: clock.sleep,
      ...artDeps,
    },
  });

  /** Imports a live work holding `ids`; returns its id. */
  const work = async (ids: Record<string, string> = {}, fields: Record<string, unknown> = {}) => {
    const { changes } = await t.importSubmission([
      {
        op: 'create',
        kind: 'work',
        ref: 'w',
        fields: { mediaType: 'film_tv', subtype: 'movie', title: 'W', ...fields },
      },
      ...Object.entries(ids).map(([scheme, value]) => ({
        op: 'relate',
        type: 'external_id',
        from: { ref: 'w' },
        data: { scheme, value },
      })),
    ]);
    // The create is always the first change, and it makes an entity.
    return changes[0]!.entityId!;
  };
  const book = (ids: Record<string, string>) => work(ids, { mediaType: 'book', subtype: null });

  const request = (query: string, ip = '203.0.113.7') =>
    t.app.request(`/api/art?${query}`, { headers: { 'x-forwarded-for': ip } });
  /** `GET /api/art` for `ids`, asserting a 200; returns `items`. */
  const art = async (...ids: string[]) => {
    const res = await request(`works=${ids.join(',')}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { items: Record<string, unknown> }).items;
  };
  const callsTo = (host: string) => calls.filter((c) => new URL(c.url).host === host);
  return { t, clock, calls, callsTo, work, book, art, request };
}

const tmdbFound = (kind: 'movie' | 'tv', id: string) => ({
  status: 'found',
  source: 'tmdb',
  thumb: `https://image.tmdb.org/t/p/w154/${kind}${id}.jpg`,
  full: `https://image.tmdb.org/t/p/w500/${kind}${id}.jpg`,
  link: `https://www.themoviedb.org/${kind}/${id}`,
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
});
/** `setup`, closing its database after the test. */
async function open(...args: Parameters<typeof setup>) {
  const s = await setup(...args);
  closers.push(s.t.close);
  return s;
}

describe('resolving a work’s art', () => {
  it('TMDB beats AniList for a film holding both, with w154/w500 URLs and a link to the movie', async () => {
    const s = await open();
    const id = await s.work({ tmdb_movie: '603', anilist: '21' });
    expect(await s.art(id)).toEqual({ [id]: tmdbFound('movie', '603') });
    expect(s.callsTo('graphql.anilist.co')).toEqual([]);
    const [call] = s.callsTo('api.themoviedb.org');
    expect(new URL(call!.url).searchParams.get('api_key')).toBe(KEY);
    expect(call!.headers.get('user-agent')).toBe(USER_AGENT);
    expect(call!.signal).toBeInstanceOf(AbortSignal);
  });

  it('a TV series uses TMDB’s tv endpoint and link', async () => {
    const s = await open();
    const id = await s.work({ tmdb_tv: '1396' }, { subtype: 'series' });
    expect(await s.art(id)).toEqual({ [id]: tmdbFound('tv', '1396') });
  });

  it('a TMDB poster_path of null falls through to AniList', async () => {
    const s = await open({ tmdb: (_k, id) => json({ id: Number(id), poster_path: null }) });
    const id = await s.work({ tmdb_movie: '603', anilist: '21' });
    expect(await s.art(id)).toEqual({
      [id]: {
        status: 'found',
        source: 'anilist',
        thumb: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/small/bx21.jpg',
        full: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21.jpg',
        link: 'https://anilist.co/anime/21',
      },
    });
    const [call] = s.callsTo('graphql.anilist.co');
    expect(call!.method).toBe('POST');
    expect(call!.headers.get('user-agent')).toBe(USER_AGENT);
    expect(call!.body).toMatchObject({ variables: { id: 21 } });
  });

  it('a TMDB 404 falls through to AniList', async () => {
    const s = await open({ tmdb: () => json({ success: false }, { status: 404 }) });
    const id = await s.work({ tmdb_movie: '603', anilist: '21' });
    expect(await s.art(id)).toMatchObject({ [id]: { status: 'found', source: 'anilist' } });
  });

  it('AniList saying the anime is unknown is none', async () => {
    const s = await open({
      anilist: () => json({ data: { Media: null }, errors: [{ message: 'Not Found.', status: 404 }] }, { status: 404 }),
    });
    const id = await s.work({ anilist: '21' });
    expect(await s.art(id)).toEqual({ [id]: { status: 'none' } });
  });

  it.each([
    ['a TMDB 500', () => new Response('oops', { status: 500 })],
    ['a TMDB timeout', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))],
    ['an unparsable TMDB body', () => new Response('<html>', { status: 200 })],
  ])('%s is unavailable, and AniList never stands in', async (_name, tmdb) => {
    const s = await open({ tmdb });
    const id = await s.work({ tmdb_movie: '603', anilist: '21' });
    expect(await s.art(id)).toEqual({ [id]: { status: 'unavailable' } });
    expect(s.callsTo('api.themoviedb.org')).toHaveLength(1);
    expect(s.callsTo('graphql.anilist.co')).toEqual([]);
  });

  it('a TMDB 429 with Retry-After: 30 is unavailable, and TMDB is not called again until 30 s pass', async () => {
    let limited = true;
    const s = await open({
      tmdb: (kind, id) =>
        limited ? new Response(null, { status: 429, headers: { 'Retry-After': '30' } }) : defaults.tmdb(kind, id),
    });
    const film = await s.work({ tmdb_movie: '603', anilist: '21' });
    const other = await s.work({ tmdb_tv: '1396', anilist: '22' }, { subtype: 'series' });
    expect(await s.art(film)).toEqual({ [film]: { status: 'unavailable' } });
    expect(s.callsTo('api.themoviedb.org')).toHaveLength(1);

    limited = false;
    s.clock.advance(29_000);
    expect(await s.art(film, other)).toEqual({ [film]: { status: 'unavailable' }, [other]: { status: 'unavailable' } });
    expect(s.callsTo('api.themoviedb.org')).toHaveLength(1);
    expect(s.callsTo('graphql.anilist.co')).toEqual([]);

    s.clock.advance(1_000);
    expect(await s.art(film)).toEqual({ [film]: tmdbFound('movie', '603') });
    expect(s.callsTo('api.themoviedb.org')).toHaveLength(2);
  });

  it('without a TMDB key, a film with TMDB and AniList ids is unavailable and nothing is fetched', async () => {
    const s = await open({}, { tmdbApiKey: undefined });
    const id = await s.work({ tmdb_movie: '603', anilist: '21' });
    expect(await s.art(id)).toEqual({ [id]: { status: 'unavailable' } });
    expect(s.calls).toEqual([]);
  });

  it('an Open Library edition id is checked with default=false and linked by OLID', async () => {
    const s = await open();
    const id = await s.book({ openlibrary: 'OL7440033M' });
    expect(await s.art(id)).toEqual({
      [id]: {
        status: 'found',
        source: 'openlibrary',
        thumb: 'https://covers.openlibrary.org/b/olid/OL7440033M-M.jpg',
        full: 'https://covers.openlibrary.org/b/olid/OL7440033M-L.jpg',
        link: 'https://openlibrary.org/books/OL7440033M',
      },
    });
    const [call] = s.callsTo('covers.openlibrary.org');
    expect(new URL(call!.url).searchParams.get('default')).toBe('false');
    expect(call!.method).toBe('HEAD');
    expect(call!.headers.get('user-agent')).toBe(USER_AGENT);
  });

  it('an edition with no cover (404) is none', async () => {
    const s = await open({ olCover: () => new Response(null, { status: 404 }) });
    const id = await s.book({ openlibrary: 'OL7440033M' });
    expect(await s.art(id)).toEqual({ [id]: { status: 'none' } });
  });

  it('an Open Library work id uses its first cover id', async () => {
    const s = await open();
    const id = await s.book({ openlibrary: 'OL45804W' });
    expect(await s.art(id)).toEqual({
      [id]: {
        status: 'found',
        source: 'openlibrary',
        thumb: 'https://covers.openlibrary.org/b/id/8231856-M.jpg',
        full: 'https://covers.openlibrary.org/b/id/8231856-L.jpg',
        link: 'https://openlibrary.org/works/OL45804W',
      },
    });
  });

  it.each([
    ['covers: [-1]', { covers: [-1] }],
    ['no covers', { title: 'Fantastic Mr Fox' }],
  ])('an Open Library work with %s is none', async (_name, body) => {
    const s = await open({ olWork: () => json(body) });
    const id = await s.book({ openlibrary: 'OL45804W' });
    expect(await s.art(id)).toEqual({ [id]: { status: 'none' } });
  });

  it('a work with no art ids is none and makes no outbound call', async () => {
    const s = await open();
    const id = await s.work({ imdb: 'tt0133093', wikidata: 'Q83495' });
    expect(await s.art(id)).toEqual({ [id]: { status: 'none' } });
    expect(s.calls).toEqual([]);
  });

  it('with no art sources configured, every work is none and nothing is fetched', async () => {
    const t = await setupTest();
    closers.push(t.close);
    const { changes } = await t.importSubmission([
      { op: 'create', kind: 'work', ref: 'w', fields: { mediaType: 'film_tv', subtype: 'movie', title: 'W' } },
      { op: 'relate', type: 'external_id', from: { ref: 'w' }, data: { scheme: 'tmdb_movie', value: '603' } },
    ]);
    const id = changes[0]!.entityId!;
    const res = await t.app.request(`/api/art?works=${id}`);
    expect(await res.json()).toEqual({ items: { [id]: { status: 'none' } } });
  });
});

describe('cache', () => {
  it('a second identical request makes no outbound call', async () => {
    const s = await open();
    const film = await s.work({ tmdb_movie: '603' });
    const book = await s.book({ openlibrary: 'OL45804W' });
    const first = await s.art(film, book);
    const before = s.calls.length;
    expect(before).toBe(2);
    expect(await s.art(film, book)).toEqual(first);
    expect(s.calls).toHaveLength(before);

    // A `none` is cached too.
    const absent = await open({ olCover: () => new Response(null, { status: 404 }) });
    const noneId = await absent.book({ openlibrary: 'OL7440033M' });
    await absent.art(noneId);
    await absent.art(noneId);
    expect(absent.calls).toHaveLength(1);
  });

  it('found expires after 7 days and none after 1 day', async () => {
    const s = await open({ olCover: () => new Response(null, { status: 404 }) });
    const film = await s.work({ tmdb_movie: '603' });
    const book = await s.book({ openlibrary: 'OL7440033M' });
    await s.art(film, book);
    s.clock.advance(24 * 3600_000);
    await s.art(film, book);
    expect(s.callsTo('api.themoviedb.org')).toHaveLength(1);
    expect(s.callsTo('covers.openlibrary.org')).toHaveLength(2);
    s.clock.advance(6 * 24 * 3600_000);
    await s.art(film);
    expect(s.callsTo('api.themoviedb.org')).toHaveLength(2);
  });

  it('unavailable is not cached: the next request asks again', async () => {
    let fail = true;
    const s = await open({
      tmdb: (kind, id) => (fail ? new Response(null, { status: 500 }) : defaults.tmdb(kind, id)),
    });
    const id = await s.work({ tmdb_movie: '603' });
    expect(await s.art(id)).toEqual({ [id]: { status: 'unavailable' } });
    fail = false;
    expect(await s.art(id)).toEqual({ [id]: tmdbFound('movie', '603') });
    expect(s.callsTo('api.themoviedb.org')).toHaveLength(2);
  });

  it('a new art id on a work is seen at once, not hidden by the cached answer', async () => {
    const s = await open({ tmdb: (_k, id) => json({ id: Number(id), poster_path: null }) });
    const { changes } = await s.t.importSubmission([
      { op: 'create', kind: 'work', ref: 'w', fields: { mediaType: 'film_tv', subtype: 'movie', title: 'W' } },
      { op: 'relate', type: 'external_id', from: { ref: 'w' }, data: { scheme: 'tmdb_movie', value: '603' } },
    ]);
    const id = changes[0]!.entityId!;
    expect(await s.art(id)).toEqual({ [id]: { status: 'none' } });
    await s.t.importSubmission([
      { op: 'relate', type: 'external_id', from: { id }, data: { scheme: 'anilist', value: '21' } },
    ]);
    expect(await s.art(id)).toMatchObject({ [id]: { status: 'found', source: 'anilist' } });
  });
});

describe('being a good client', () => {
  it('with Open Library’s limit full, books still waiting at the 3 s deadline are unavailable, and a retry fills more', async () => {
    const s = await open();
    const books = [];
    for (let i = 1; i <= 20; i++) books.push(await s.book({ openlibrary: `OL${i}M` }));
    const items = await s.art(...books);
    // 5/s: slots at 0, 1, 2 s fit inside the deadline; the fourth second's five do not.
    const statuses = books.map((b) => (items[b] as { status: string }).status);
    expect(statuses.filter((x) => x === 'found')).toHaveLength(15);
    expect(statuses.filter((x) => x === 'unavailable')).toHaveLength(5);
    expect(s.callsTo('covers.openlibrary.org')).toHaveLength(15);
    expect(s.clock.now() - START).toBeLessThan(3000);

    const retry = await s.art(...books);
    expect(Object.values(retry).every((v) => (v as { status: string }).status === 'found')).toBe(true);
    expect(s.callsTo('covers.openlibrary.org')).toHaveLength(20);
  });
});

describe('which ids resolve', () => {
  it('unknown, removed and non-work ids are none, and nothing is fetched', async () => {
    const s = await open();
    const removed = await s.work({ tmdb_movie: '603' });
    await s.t.db.update(entities).set({ removedAt: new Date() }).where(eq(entities.id, removed));
    const { changes } = await s.t.importSubmission([
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Lana Wachowski', kind: 'person' } },
      { op: 'relate', type: 'external_id', from: { ref: 'c' }, data: { scheme: 'tmdb_movie', value: '604' } },
    ]);
    const creator = changes[0]!.entityId!;
    const unknown = crypto.randomUUID();
    expect(await s.art(unknown, removed, creator)).toEqual({
      [unknown]: { status: 'none' },
      [removed]: { status: 'none' },
      [creator]: { status: 'none' },
    });
    expect(s.calls).toEqual([]);
  });

  it('a merged-away work gives its winner’s art, keyed by the id asked for', async () => {
    const s = await open();
    const author = s.t.as({ kind: 'user', userId: await s.t.createUser() });
    const mod = s.t.as({ kind: 'user', userId: await s.t.createUser({ role: 'moderator' }) });
    const winner = await s.work({ tmdb_movie: '603' });
    const loser = await s.work();
    await publish(author, mod, [{ op: 'merge', kind: 'work', from: loser, into: winner }]);
    expect(await s.art(loser)).toEqual({ [loser]: tmdbFound('movie', '603') });
  });

  it('a removed work that was merged away is none', async () => {
    const s = await open();
    const author = s.t.as({ kind: 'user', userId: await s.t.createUser() });
    const mod = s.t.as({ kind: 'user', userId: await s.t.createUser({ role: 'moderator' }) });
    const winner = await s.work({ tmdb_movie: '603' });
    const loser = await s.work();
    await publish(author, mod, [{ op: 'merge', kind: 'work', from: loser, into: winner }]);
    await s.t.db.update(entities).set({ removedAt: new Date() }).where(eq(entities.id, loser));
    expect(await s.art(loser)).toEqual({ [loser]: { status: 'none' } });
  });
});

describe('the request', () => {
  it('50 ids succeed; 51, a bad uuid or no ids are 400 in the standard error shape', async () => {
    const s = await open();
    const fifty = Array.from({ length: 50 }, () => crypto.randomUUID());
    expect(Object.keys(await s.art(...fifty))).toHaveLength(50);
    for (const query of [`works=${[...fifty, crypto.randomUUID()].join(',')}`, 'works=not-a-uuid', 'works=', '']) {
      const res = await s.request(query);
      expect(res.status, query).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.any(String) } });
    }
  });

  it('the 121st request in a minute from one address is 429; another address is unaffected', async () => {
    const s = await open();
    const id = crypto.randomUUID();
    for (let i = 0; i < 120; i++) expect((await s.request(`works=${id}`, '198.51.100.1')).status).toBe(200);
    const limited = await s.request(`works=${id}`, '198.51.100.1');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect((await s.request(`works=${id}`, '198.51.100.2')).status).toBe(200);
  });

  it('art requests write nothing: every table’s row count is unchanged', async () => {
    const s = await open({ olCover: () => new Response(null, { status: 404 }) });
    const ids = [
      await s.work({ tmdb_movie: '603', anilist: '21' }),
      await s.book({ openlibrary: 'OL7440033M' }),
      await s.book({ openlibrary: 'OL45804W' }),
    ];
    // Both drivers (PGlite here, node-postgres in production) return `{ rows }` from execute.
    const rows = async <T>(query: ReturnType<typeof sql>) => ((await s.t.db.execute(query)) as { rows: T[] }).rows;
    const counts = async () => {
      const tables = await rows<{ tablename: string }>(
        sql`select tablename from pg_tables where schemaname = 'public' order by tablename`,
      );
      const out: Record<string, number> = {};
      for (const { tablename } of tables) {
        const [count] = await rows<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(tablename)}`);
        out[tablename] = count!.n;
      }
      return out;
    };
    const before = await counts();
    expect(Object.keys(before).length).toBeGreaterThan(5);
    await s.art(...ids);
    await s.art(...ids);
    expect(await counts()).toEqual(before);
  });

  it('the TMDB key appears in no response body and no console output, even when TMDB fails', async () => {
    const logged: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(...args));
    }
    const s = await open({ tmdb: () => new Response(`bad key ${KEY}`, { status: 500 }) });
    const film = await s.work({ tmdb_movie: '603', anilist: '21' });
    const res = await s.request(`works=${film}`);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toEqual({ items: { [film]: { status: 'unavailable' } } });

    // A network error whose message carries the URL (and so the key) is not passed on either.
    const thrown = await open({
      tmdb: () => Promise.reject(new TypeError(`fetch failed: https://api.themoviedb.org/3/movie/604?api_key=${KEY}`)),
    });
    const other = await thrown.work({ tmdb_movie: '604' });
    const res2 = await thrown.request(`works=${other}`);
    expect(await res2.text()).not.toContain(KEY);
    expect(
      JSON.stringify(logged, (_k, v: unknown) => (v instanceof Error ? `${v.message} ${v.stack}` : v)),
    ).not.toContain(KEY);
  });
});
