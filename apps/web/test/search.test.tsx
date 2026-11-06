import { screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { actors, publish, renderApp, seed } from './harness';

test('the header search box goes to /search?q= on Enter', async () => {
  const { user, router } = await renderApp('/', { seed });

  await user.type(screen.getByRole('searchbox', { name: 'Search the catalog' }), 'howl{Enter}');

  expect(router.state.location.pathname).toBe('/search');
  expect(router.state.location.search).toEqual({ q: 'howl' });
  expect(await screen.findByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument();
});

test('the search box has a visible submit button for touch', async () => {
  const { user, router } = await renderApp('/', { seed });

  await user.type(screen.getByRole('searchbox', { name: 'Search the catalog' }), '  miyazaki ');
  await user.click(screen.getByRole('button', { name: 'Search' }));

  expect(router.state.location.search).toEqual({ q: 'miyazaki' });
});

test('an empty search box goes nowhere', async () => {
  const { user, router } = await renderApp('/', { seed });

  await user.click(screen.getByRole('button', { name: 'Search' }));

  expect(router.state.location.pathname).toBe('/');
});

test('the box keeps the query of the search page', async () => {
  await renderApp('/search?q=howl', { seed });

  expect(screen.getByRole('searchbox', { name: 'Search the catalog' })).toHaveValue('howl');
});

test('results are grouped by kind', async () => {
  const { seeded } = await renderApp('/search?q=howl', { seed });

  const works = await screen.findByRole('region', { name: 'Works' });
  expect(within(works).getAllByRole('listitem')).toHaveLength(2);
  expect(within(works).getAllByRole('link', { name: /Howl's Moving Castle/ })[0]).toHaveAttribute(
    'href',
    expect.stringMatching(`/entities/(${seeded.works.howlsMovingCastle}|${seeded.works.howlsNovel})`),
  );
  expect(screen.getByRole('region', { name: 'Series' })).toHaveTextContent("Howl's Castle");
  expect(screen.getByRole('region', { name: 'Properties' })).toHaveTextContent("Howl's Moving Castle");
  expect(screen.queryByRole('region', { name: 'Creators' })).not.toBeInTheDocument();
});

test('a creator is found under Creators', async () => {
  await renderApp('/search?q=miyazaki', { seed });

  const creators = await screen.findByRole('region', { name: 'Creators' });
  expect(within(creators).getByRole('link', { name: 'Hayao Miyazaki' })).toBeInTheDocument();
});

test('"amelie" finds Amélie', async () => {
  await renderApp('/search?q=amelie', { seed });

  expect(await screen.findByRole('link', { name: /Amélie/ })).toBeInTheDocument();
});

test('a query with no results offers to add it', async () => {
  await renderApp('/search?q=zzyzx', { seed });

  expect(await screen.findByText(/No results for/)).toHaveTextContent('No results for “zzyzx”');
  expect(screen.getByRole('link', { name: 'Add it' })).toHaveAttribute('href', '/submit?title=zzyzx');
});

test('with no query it asks for one', async () => {
  await renderApp('/search');

  expect(screen.getByText('Type a title or a name to search.')).toBeInTheDocument();
});

test('a failed Load more keeps the results shown, says so, and loads on a second try', async () => {
  const t = await renderApp('/', {
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      await publish(
        contributor,
        moderator,
        Array.from({ length: 21 }, (_, i) => ({
          op: 'create',
          kind: 'work',
          ref: `w${i}`,
          fields: { mediaType: 'book', subtype: null, title: `Lantern ${String(i).padStart(2, '0')}` },
        })),
      );
    },
  });
  const real = t.api.app.request.bind(t.api.app);
  let failing = true;
  vi.spyOn(t.api.app, 'request').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return failing && url.includes('/api/search') && url.includes('cursor=')
      ? Promise.reject(new TypeError('Failed to fetch'))
      : real(input, init);
  });
  await t.router.navigate({ to: '/search', search: { q: 'lantern' } });
  const shown = async () => within(await screen.findByRole('region', { name: 'Works' })).getAllByRole('listitem');
  expect(await shown()).toHaveLength(20);

  await t.user.click(screen.getByRole('button', { name: 'Load more' }));

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach AMDB");
  expect(await shown()).toHaveLength(20);
  failing = false;
  await t.user.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(async () => expect(await shown()).toHaveLength(21));
});
