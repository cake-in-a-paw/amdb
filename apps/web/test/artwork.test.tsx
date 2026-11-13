import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { actors, publish, renderApp, type TestApi } from './harness';

const NOTICE = 'This product uses the TMDB API but is not endorsed or certified by TMDB.';

type Reply = Response | Promise<Response>;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Fake art sources: TMDB movies answer a poster, Open Library works a cover, others have none. */
function fakeSources(tmdb: (id: string) => Reply = (id) => json({ poster_path: `/p${id}.jpg` })) {
  const calls: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.href);
    const movie = /^\/3\/movie\/(\d+)$/.exec(url.pathname);
    if (url.host === 'api.themoviedb.org' && movie) return tmdb(movie[1] ?? '');
    if (url.host === 'openlibrary.org') return json({ covers: [123] });
    return new Response(null, { status: 404 });
  };
  // A clock that moves only when the rate limiter sleeps, so 50 lookups don't wait out TMDB's limit.
  let clock = Date.parse('2026-11-08T12:00:00Z');
  const art = {
    fetch: fetch as typeof globalThis.fetch,
    tmdbApiKey: 'test',
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
  return { art, tmdbCalls: (id: string) => calls.filter((c) => c.includes(`/3/movie/${id}?`)).length };
}

/** Films A (tmdb 1), B (tmdb 2), a film with no ids, and a book with an Open Library work id. */
async function seedWorks(api: TestApi) {
  const { contributor, moderator } = await actors(api);
  const film = (ref: string, title: string, ids: Record<string, string>) => [
    { op: 'create', kind: 'work', ref, fields: { mediaType: 'film_tv', subtype: 'movie', title } },
    ...Object.entries(ids).map(([scheme, value]) => ({
      op: 'relate',
      type: 'external_id',
      from: { ref },
      data: { scheme, value },
    })),
  ];
  const changes = [
    ...film('a', 'Alpha', { tmdb_movie: '1' }),
    ...film('b', 'Bravo', { tmdb_movie: '2' }),
    ...film('c', 'Charlie', {}),
    { op: 'create', kind: 'work', ref: 'd', fields: { mediaType: 'book', subtype: null, title: 'Delta' } },
    { op: 'relate', type: 'external_id', from: { ref: 'd' }, data: { scheme: 'openlibrary', value: 'OL45W' } },
  ];
  const created = await publish(contributor, moderator, changes);
  const idOf = (ref: string) => {
    const index = changes.findIndex((c) => 'ref' in c && c.op === 'create' && c.ref === ref);
    return created.changes[index]?.entityId ?? '';
  };
  return { a: idOf('a'), b: idOf('b'), c: idOf('c'), d: idOf('d') };
}

afterEach(() => {
  vi.useRealTimers();
});

test('a film page shows its poster with a credit link to TMDB', async () => {
  const { art } = fakeSources();
  const t = await renderApp('/', { seed: seedWorks, art });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.a } });

  const poster = await screen.findByRole('img', { name: 'Poster for Alpha' });
  expect(poster).toHaveAttribute('src', 'https://image.tmdb.org/t/p/w500/p1.jpg');
  expect(screen.getByRole('link', { name: 'Poster: TMDB' })).toHaveAttribute(
    'href',
    'https://www.themoviedb.org/movie/1',
  );
});

test('a book page shows its cover with a credit to Open Library', async () => {
  const { art } = fakeSources();
  const t = await renderApp('/', { seed: seedWorks, art });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.d } });

  expect(await screen.findByRole('img', { name: 'Cover for Delta' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Cover: Open Library' })).toHaveAttribute(
    'href',
    'https://openlibrary.org/works/OL45W',
  );
});

test('a work with no art shows the no-cover placeholder', async () => {
  const { art } = fakeSources();
  const t = await renderApp('/', { seed: seedWorks, art });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.c } });

  expect(await screen.findByRole('img', { name: 'No cover for Charlie' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /^(Poster|Cover):/ })).not.toBeInTheDocument();
});

test('an image that fails to load falls back to the placeholder', async () => {
  const { art } = fakeSources();
  const t = await renderApp('/', { seed: seedWorks, art });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.a } });

  fireEvent.error(await screen.findByRole('img', { name: 'Poster for Alpha' }));

  expect(await screen.findByRole('img', { name: 'No cover for Alpha' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Poster: TMDB' })).not.toBeInTheDocument();
});

test('an unavailable item is asked for once more after 5 seconds, and then left alone', async () => {
  let first = true;
  const { art, tmdbCalls } = fakeSources((id) => {
    if (id === '1' && first) {
      first = false;
      // Everything is loaded but this answer; from here only setTimeout is faked, so the in-process
      // API and Testing Library keep running and the 5 second wait can be stepped.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      return new Response(null, { status: 500 });
    }
    return json({ poster_path: `/p${id}.jpg` });
  });
  const t = await renderApp('/', { seed: seedWorks, art });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.a } });

  // Testing Library's async helpers wait on setTimeout, which is faked from here on; vi.waitFor steps it.
  await vi.waitFor(() => expect(tmdbCalls('1')).toBe(1));
  expect(screen.getByRole('img', { name: 'No cover for Alpha' })).toBeInTheDocument();

  // The wait starts once the first answer is in; step it only after its timer exists.
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(5000);
  await vi.waitFor(() => expect(screen.getByRole('img', { name: 'Poster for Alpha' })).toBeInTheDocument());
  expect(tmdbCalls('1')).toBe(2);

  await vi.advanceTimersByTimeAsync(20_000);
  expect(tmdbCalls('1')).toBe(2);
});

test('the footer carries the TMDB notice and logo, and links to Open Library and AniList', async () => {
  await renderApp('/');

  const footer = screen.getByRole('contentinfo');
  expect(footer).toHaveTextContent(NOTICE);
  expect(within(footer).getByRole('img', { name: 'TMDB' })).toHaveAttribute('src', '/tmdb-logo.svg');
  expect(within(footer).getByRole('link', { name: 'Open Library' })).toHaveAttribute('href', 'https://openlibrary.org');
  expect(within(footer).getByRole('link', { name: 'AniList' })).toHaveAttribute('href', 'https://anilist.co');
});

/** A film directed by a creator, with a TMDB id. */
async function seedDirected(api: TestApi) {
  const { contributor, moderator } = await actors(api);
  const created = await publish(contributor, moderator, [
    { op: 'create', kind: 'creator', ref: 'dir', fields: { kind: 'person', name: 'Director' } },
    { op: 'create', kind: 'work', ref: 'w', fields: { mediaType: 'film_tv', subtype: 'movie', title: 'Alpha' } },
    { op: 'relate', type: 'external_id', from: { ref: 'w' }, data: { scheme: 'tmdb_movie', value: '1' } },
    { op: 'relate', type: 'work_creator', from: { ref: 'w' }, to: { ref: 'dir' }, data: { role: 'director' } },
  ]);
  return { creator: created.changes[0]?.entityId ?? '' };
}

test('lists show no art and ask for none: browse, home and a creator page', async () => {
  const { art, tmdbCalls } = fakeSources();
  const t = await renderApp('/', { seed: seedDirected, art });
  await screen.findByRole('link', { name: /Alpha/ });
  await t.router.navigate({ to: '/browse', search: { mediaType: 'film_tv' } });
  await screen.findByRole('link', { name: /Alpha/ });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.creator } });
  const list = await screen.findByRole('list', { name: 'Works' });

  expect(within(list).getByRole('link', { name: /Alpha/ })).toBeInTheDocument();
  expect(document.querySelector('img[src^="https://image.tmdb.org/"]')).toBeNull();
  expect(document.querySelector('[data-art-placeholder]')).toBeNull();
  expect(tmdbCalls('1')).toBe(0);
});

test('an unavailable answer is not reused: coming back to the page asks again', async () => {
  let first = true;
  const { art, tmdbCalls } = fakeSources((id) => {
    if (id === '1' && first) {
      first = false;
      return new Response(null, { status: 500 });
    }
    return json({ poster_path: `/p${id}.jpg` });
  });
  const t = await renderApp('/', { seed: seedWorks, art });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.a } });
  expect(await screen.findByRole('img', { name: 'No cover for Alpha' })).toBeInTheDocument();
  // The placeholder also stands in while the art loads, and a real Postgres round trip is slower than
  // PGlite was, so the lookup may not have reached TMDB yet; wait for it (still exactly one call).
  await vi.waitFor(() => expect(tmdbCalls('1')).toBe(1));

  await t.router.navigate({ to: '/submit' });
  await vi.waitFor(() => expect(t.router.state.location.pathname).toBe('/submit'));
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.a } });

  // Well inside the 5 s retry wait, so this is the revisit asking again, not the page's own retry.
  expect(await screen.findByRole('img', { name: 'Poster for Alpha' }, { timeout: 2000 })).toBeInTheDocument();
  expect(tmdbCalls('1')).toBe(2);
});

test('leaving the page cancels the pending second try', async () => {
  let first = true;
  const { art, tmdbCalls } = fakeSources((id) => {
    if (id === '1' && first) {
      first = false;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      return new Response(null, { status: 500 });
    }
    return json({ poster_path: `/p${id}.jpg` });
  });
  const t = await renderApp('/', { seed: seedWorks, art });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.a } });
  await vi.waitFor(() => expect(tmdbCalls('1')).toBe(1));
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));

  await t.router.navigate({ to: '/submit' });
  await vi.waitFor(() => expect(t.router.state.location.pathname).toBe('/submit'));
  await vi.advanceTimersByTimeAsync(20_000);

  expect(tmdbCalls('1')).toBe(1);
});
