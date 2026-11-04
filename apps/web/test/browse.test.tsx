import { screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { actors, publish, renderApp, seed } from './harness';

test('browse has a tab for each kind and lists works first, by title', async () => {
  await renderApp('/browse', { seed });

  const tabs = screen.getByRole('navigation', { name: 'Browse by kind' });
  expect(
    within(tabs)
      .getAllByRole('link')
      .map((a) => a.textContent),
  ).toEqual(['Works', 'Creators', 'Series', 'Properties', 'Tags']);
  expect(within(tabs).getByRole('link', { name: 'Works' })).toHaveAttribute('aria-current', 'page');
  const list = await screen.findByRole('list', { name: 'Works' });
  expect(
    within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent?.split(/Film|Book/)[0]),
  ).toEqual([
    'Amélie',
    'Castle in the Air',
    "Howl's Moving Castle",
    "Howl's Moving Castle",
    'Princess Mononoke',
    'Spirited Away',
  ]);
});

test('each tab lists its kind', async () => {
  const { user, seeded, router } = await renderApp('/browse', { seed });
  await screen.findByRole('list', { name: 'Works' });

  await user.click(screen.getByRole('link', { name: 'Creators' }));
  const creators = await screen.findByRole('list', { name: 'Creators' });
  expect(within(creators).getByRole('link', { name: 'Hayao Miyazaki' })).toHaveAttribute(
    'href',
    `/entities/${seeded.creators.miyazaki}`,
  );
  expect(router.state.location.search).toEqual({ kind: 'creator' });

  await user.click(screen.getByRole('link', { name: 'Series' }));
  expect(await within(await screen.findByRole('list', { name: 'Series' })).findByText("Howl's Castle")).toBeVisible();
  await user.click(screen.getByRole('link', { name: 'Properties' }));
  expect(await screen.findByRole('list', { name: 'Properties' })).toBeVisible();
  await user.click(screen.getByRole('link', { name: 'Tags' }));
  expect(await within(await screen.findByRole('list', { name: 'Tags' })).findByText('Fantasy')).toBeVisible();
});

test('works can be filtered by media type', async () => {
  const { user } = await renderApp('/browse', { seed });
  await screen.findByRole('list', { name: 'Works' });

  await user.selectOptions(screen.getByRole('combobox', { name: 'Media type' }), 'Book');

  await screen.findByText('Castle in the Air');
  const list = screen.getByRole('list', { name: 'Works' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  expect(screen.queryByText('Spirited Away')).not.toBeInTheDocument();
});

test('the media type filter only appears for works', async () => {
  await renderApp('/browse?kind=creator', { seed });

  await screen.findByRole('list', { name: 'Creators' });
  expect(screen.queryByRole('combobox', { name: 'Media type' })).not.toBeInTheDocument();
});

/** 22 books, so the list takes two pages. */
async function volumes(api: Parameters<typeof seed>[0]) {
  const { contributor, moderator } = await actors(api);
  const work = (n: number) => ({
    op: 'create',
    kind: 'work',
    ref: `w${n}`,
    fields: { mediaType: 'book', subtype: null, title: `Volume ${String(n).padStart(2, '0')}` },
  });
  await publish(
    contributor,
    moderator,
    Array.from({ length: 22 }, (_, i) => work(i + 1)),
  );
}

test('a failed Load more keeps the loaded list and reports once; retrying loads the rest', async () => {
  const t = await renderApp('/browse', { seed: volumes });
  const list = await screen.findByRole('list', { name: 'Works' });
  const real = t.api.app.request.bind(t.api.app);
  // The only way to make the in-process API drop a request: reject at it, for the second page only.
  const spy = vi.spyOn(t.api.app, 'request').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes('cursor=') ? Promise.reject(new TypeError('Failed to fetch')) : real(input, init);
  });

  await t.user.click(screen.getByRole('button', { name: 'Load more' }));

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach AMDB");
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(within(list).getAllByRole('listitem')).toHaveLength(20);
  spy.mockRestore();
  await t.user.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Volume 22')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('Load more follows the cursor until the list ends', async () => {
  const { user } = await renderApp('/browse', { seed: volumes });

  const list = await screen.findByRole('list', { name: 'Works' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(20);
  expect(screen.queryByText('Volume 21')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Load more' }));

  expect(await screen.findByText('Volume 22')).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Works' })).getAllByRole('listitem')).toHaveLength(22);
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
});

test('an empty kind invites the first contribution', async () => {
  await renderApp('/browse?kind=series');

  const empty = await screen.findByText(/Nothing here yet/);
  expect(empty).toHaveTextContent('Nothing here yet — add the first one');
  expect(within(empty).getByRole('link', { name: 'add the first one' })).toHaveAttribute('href', '/submit');
});

test('a failed load says so and Try again loads it', async () => {
  const t = await renderApp('/', { seed });
  const real = t.api.app.request.bind(t.api.app);
  // The only way to make an in-process API fail the way a dropped network does: reject at its request.
  const spy = vi.spyOn(t.api.app, 'request').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes('/api/browse') ? Promise.reject(new TypeError('Failed to fetch')) : real(input, init);
  });
  await t.router.navigate({ to: '/browse' });

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the list");
  spy.mockRestore();
  await t.user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('list', { name: 'Works' })).toBeInTheDocument();
});

test('the shell links to browse', async () => {
  const { user, router } = await renderApp('/');

  await user.click(screen.getByRole('link', { name: 'Browse' }));

  expect(router.state.location.pathname).toBe('/browse');
});
