import { screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp, seed } from './harness';

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
  expect(screen.getByRole('link', { name: 'Add it' })).toHaveAttribute('href', '/submit');
});

test('with no query it asks for one', async () => {
  await renderApp('/search');

  expect(screen.getByText('Type a title or a name to search.')).toBeInTheDocument();
});
