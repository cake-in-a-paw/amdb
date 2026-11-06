import { screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { actors, publish, renderApp, seed } from './harness';

async function page(pick: (s: Awaited<ReturnType<typeof seed>>) => string) {
  // The path needs ids that only exist after seeding, so start on the home page and navigate.
  const t = await renderApp('/', { seed });
  await t.router.navigate({ to: '/entities/$id', params: { id: pick(t.seeded) } });
  return t;
}

test('a work shows its title and its creators with their roles', async () => {
  await page((s) => s.works.spiritedAway);

  expect(await screen.findByRole('heading', { level: 1, name: 'Spirited Away' })).toBeInTheDocument();
  const credits = screen.getByRole('list', { name: 'Credits' });
  const credit = within(credits).getByRole('listitem');
  expect(within(credit).getByRole('link', { name: 'Hayao Miyazaki' })).toBeInTheDocument();
  expect(credit).toHaveTextContent('Director');
});

test('the release date shows at the precision given', async () => {
  const t = await page((s) => s.works.spiritedAway);
  expect(await screen.findByText('July 2001')).toBeInTheDocument();

  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.works.howlsMovingCastle } });
  expect(await screen.findByRole('heading', { level: 1, name: "Howl's Moving Castle" })).toBeInTheDocument();
  expect(screen.getByText('2004')).toBeInTheDocument();
  expect(screen.queryByText('July 2001')).not.toBeInTheDocument();
});

test('a full release date shows the day too', async () => {
  const t = await renderApp('/', {
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const made = await publish(contributor, moderator, [
        {
          op: 'create',
          kind: 'work',
          ref: 'w',
          fields: {
            mediaType: 'book',
            subtype: null,
            title: 'Dated',
            releaseYear: 1986,
            releaseMonth: 4,
            releaseDay: 5,
          },
        },
      ]);
      const id = made.changes[0]?.entityId;
      if (!id) throw new Error('the create made no entity');
      return id;
    },
  });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded } });

  expect(await screen.findByText('April 5, 1986')).toBeInTheDocument();
});

test('the description, tags and lifecycle show', async () => {
  await page((s) => s.works.spiritedAway);

  expect(await screen.findByText('A girl works in a bathhouse for spirits.')).toBeInTheDocument();
  expect(screen.getByText('Released')).toBeInTheDocument();
  const tags = screen.getByRole('list', { name: 'Tags' });
  expect(within(tags).getByRole('link', { name: 'Fantasy' })).toBeInTheDocument();
});

test('a work lists more by its creator and others in its property', async () => {
  const t = await page((s) => s.works.howlsMovingCastle);

  const more = await screen.findByRole('region', { name: 'More by Hayao Miyazaki' });
  expect(within(more).getByRole('link', { name: /Spirited Away/ })).toHaveAttribute(
    'href',
    `/entities/${t.seeded.works.spiritedAway}`,
  );
  expect(within(more).getByRole('link', { name: /Princess Mononoke/ })).toBeInTheDocument();
  const property = screen.getByRole('region', { name: "Also in Howl's Moving Castle" });
  expect(
    within(within(property).getByRole('list')).getByRole('link', { name: /Howl's Moving Castle/ }),
  ).toHaveAttribute('href', `/entities/${t.seeded.works.howlsNovel}`);
});

test('the only work in a property says it is in it, not "also" in it', async () => {
  const t = await renderApp('/', {
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const made = await publish(contributor, moderator, [
        { op: 'create', kind: 'work', ref: 'w', fields: { mediaType: 'book', subtype: null, title: 'Alone' } },
        { op: 'create', kind: 'property', ref: 'p', fields: { title: 'Solo Saga' } },
        { op: 'relate', type: 'property_work', from: { ref: 'p' }, to: { ref: 'w' }, data: {} },
      ]);
      const id = made.changes[0]?.entityId;
      if (!id) throw new Error('the create made no entity');
      return id;
    },
  });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded } });

  const property = await screen.findByRole('region', { name: 'In Solo Saga' });
  expect(property).toHaveTextContent('No other works in the property yet.');
  expect(screen.queryByRole('region', { name: /^Also in/ })).not.toBeInTheDocument();
});

test('a work in a series says where it stands and lists the rest of the series', async () => {
  const t = await page((s) => s.works.howlsNovel);

  const series = await screen.findByRole('region', { name: "In Howl's Castle" });
  expect(series).toHaveTextContent('No. 1');
  expect(within(series).getByRole('link', { name: /Castle in the Air/ })).toHaveAttribute(
    'href',
    `/entities/${t.seeded.works.castleInTheAir}`,
  );
});

test('direct links read in words, from either end', async () => {
  const t = await page((s) => s.works.howlsMovingCastle);

  const adapted = await screen.findByRole('region', { name: 'Adapted from' });
  expect(within(adapted).getByRole('link', { name: /Howl's Moving Castle/ })).toHaveAttribute(
    'href',
    `/entities/${t.seeded.works.howlsNovel}`,
  );

  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.works.castleInTheAir } });
  const sequel = await screen.findByRole('region', { name: 'Sequel to' });
  expect(within(sequel).getByRole('link', { name: /Howl's Moving Castle/ })).toBeInTheDocument();

  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.works.howlsNovel } });
  expect(await screen.findByRole('region', { name: 'Adapted as' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Followed by' })).toBeInTheDocument();
});

test('with no cover, a typographic placeholder shows the title', async () => {
  await page((s) => s.works.spiritedAway);

  const cover = await screen.findByRole('img', { name: 'No cover yet for Spirited Away' });
  expect(cover).toHaveTextContent('Spirited Away');
});

test('the page offers Edit and History', async () => {
  const t = await page((s) => s.works.spiritedAway);
  const id = t.seeded.works.spiritedAway;

  expect(await screen.findByRole('link', { name: 'Edit' })).toHaveAttribute('href', `/entities/${id}/edit`);
  await t.user.click(screen.getByRole('link', { name: 'History' }));
  expect(t.router.state.location.pathname).toBe(`/entities/${id}/history`);
});
