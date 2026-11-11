import { screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { actors, publish, renderApp, seed } from './harness';

type Seeded = Awaited<ReturnType<typeof seed>>;

async function page(pick: (s: Seeded) => string) {
  const t = await renderApp('/', { seed });
  await t.router.navigate({ to: '/entities/$id', params: { id: pick(t.seeded) } });
  return t;
}

const titles = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');

test('a creator page lists their works with the role they had', async () => {
  const t = await page((s) => s.creators.miyazaki);

  expect(await screen.findByRole('heading', { level: 1, name: 'Hayao Miyazaki' })).toBeInTheDocument();
  expect(screen.getByText('Person')).toBeInTheDocument();
  const list = screen.getByRole('list', { name: 'Works' });
  expect(within(list).getByRole('link', { name: /Spirited Away/ })).toHaveAttribute(
    'href',
    `/entities/${t.seeded.works.spiritedAway}`,
  );
  expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  expect(titles(list)[0]).toContain('Director');
});

test('a series page lists its works in position order, not title order', async () => {
  await page((s) => s.series.howlsSeries);

  const list = await screen.findByRole('list', { name: 'Works' });
  // By title "Castle in the Air" would come first; by position the first book does.
  const items = titles(list);
  expect(items[0]).toContain("Howl's Moving Castle");
  expect(items[0]).toContain('No. 1');
  expect(items[1]).toContain('Castle in the Air');
  expect(items[1]).toContain('No. 2');
});

test('a property page lists its works', async () => {
  await page((s) => s.properties.howlsProperty);

  expect(await screen.findByRole('heading', { level: 1, name: "Howl's Moving Castle" })).toBeInTheDocument();
  const list = screen.getByRole('list', { name: 'Works' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
});

test('a tag page lists the works that carry it', async () => {
  await page((s) => s.tags.fantasy);

  expect(await screen.findByRole('heading', { level: 1, name: 'Fantasy' })).toBeInTheDocument();
  expect(screen.getByText('Genre')).toBeInTheDocument();
  const list = screen.getByRole('list', { name: 'Works' });
  expect(titles(list).join('|')).toMatch(/Princess Mononoke.*\|.*Spirited Away|Spirited Away.*\|.*Princess Mononoke/);
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
});

test('a list page with no works says so', async () => {
  const t = await renderApp('/', {
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const made = await publish(contributor, moderator, [
        { op: 'create', kind: 'series', ref: 's', fields: { title: 'Empty Shelf' } },
      ]);
      return made.changes[0]?.entityId ?? '';
    },
  });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded } });

  expect(await screen.findByRole('heading', { level: 1, name: 'Empty Shelf' })).toBeInTheDocument();
  expect(screen.getByText('No works yet.')).toBeInTheDocument();
});

test('creator page shows Also known as', async () => {
  const t = await renderApp('/', {
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const made = await publish(contributor, moderator, [
        {
          op: 'create',
          kind: 'creator',
          ref: 'c',
          fields: { name: 'Kafka', kind: 'person', alternateNames: ['Franz', 'F. K.'] },
        },
      ]);
      return made.changes[0]?.entityId ?? '';
    },
  });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded } });
  expect(await screen.findByText('Also known as: Franz · F. K.')).toBeInTheDocument();
});
