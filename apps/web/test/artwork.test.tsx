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
  const art = { fetch: fetch as typeof globalThis.fetch, tmdbApiKey: 'test' };
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

test('browse asks for art once for its page and shows a thumbnail or placeholder per row', async () => {
  const { art } = fakeSources();
  const requests: string[] = [];
  const t = await renderApp('/browse', { seed: seedWorks, art });
  const original = t.api.app.request.bind(t.api.app);
  vi.spyOn(t.api.app, 'request').mockImplementation(async (input, init) => {
    requests.push(String(input instanceof Request ? input.url : input));
    return original(input, init);
  });
  await t.router.navigate({ to: '/browse', search: { mediaType: 'film_tv' } });

  const list = await screen.findByRole('list', { name: 'Works' });
  await vi.waitFor(() => expect(list.querySelectorAll('img[src^="https://image.tmdb.org/"]')).toHaveLength(2));
  const rows = within(list).getAllByRole('listitem');
  expect(rows).toHaveLength(3);
  const charlie = rows.find((row) => row.textContent?.includes('Charlie'));
  expect(charlie?.querySelector('img')).toBeNull();
  expect(charlie?.querySelector('[data-art-placeholder]')).not.toBeNull();
  expect(list.querySelectorAll('img[alt=""][loading="lazy"]')).toHaveLength(2);
  expect(requests.filter((url) => url.includes('/api/art'))).toHaveLength(1);
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
