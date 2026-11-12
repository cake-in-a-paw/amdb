import { screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { actors, publish, renderApp, seed, type TestApi } from './harness';

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

  const cover = await screen.findByRole('img', { name: 'No cover for Spirited Away' });
  expect(cover).toHaveTextContent('Spirited Away');
});

test('the page offers Edit and History', async () => {
  const t = await page((s) => s.works.spiritedAway);
  const id = t.seeded.works.spiritedAway;

  expect(await screen.findByRole('link', { name: 'Edit' })).toHaveAttribute('href', `/entities/${id}/edit`);
  await t.user.click(screen.getByRole('link', { name: 'History' }));
  expect(t.router.state.location.pathname).toBe(`/entities/${id}/history`);
});

test('work page shows Also known as', async () => {
  const t = await renderApp('/', {
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const made = await publish(contributor, moderator, [
        {
          op: 'create',
          kind: 'work',
          ref: 'w',
          fields: { mediaType: 'book', subtype: null, title: 'Named', alternateTitles: ['Alias A', 'Alias B'] },
        },
        { op: 'create', kind: 'work', ref: 'p', fields: { mediaType: 'book', subtype: null, title: 'Plain' } },
      ]);
      return { named: made.changes[0]?.entityId ?? '', plain: made.changes[1]?.entityId ?? '' };
    },
  });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.named } });
  expect(await screen.findByText('Also known as: Alias A · Alias B')).toBeInTheDocument();

  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.plain } });
  expect(await screen.findByRole('heading', { level: 1, name: 'Plain' })).toBeInTheDocument();
  expect(screen.queryByText(/Also known as/)).not.toBeInTheDocument();
});

const tvWork = (ref: string, subtype: string, title: string) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType: 'film_tv', subtype, title },
});
const partOf = (parent: string, child: string, position?: number) => ({
  op: 'relate',
  type: 'work_part',
  from: { ref: parent },
  to: { ref: child },
  data: position === undefined ? {} : { position },
});

/** Publishes `changes` the real way and returns each create's entity id by its ref. */
async function publishTree(api: TestApi, changes: ReturnType<typeof tvWork | typeof partOf>[]) {
  const { contributor, moderator } = await actors(api);
  const made = await publish(contributor, moderator, changes);
  return idsByRef(changes, made.changes);
}

function idsByRef(changes: { op: string; ref?: string }[], made: { entityId: string | null }[]) {
  const ids: Record<string, string> = {};
  changes.forEach((change, i) => {
    const id = made[i]?.entityId;
    if (change.op === 'create' && change.ref && id) ids[change.ref] = id;
  });
  return ids;
}

/** Breaking Bad with Season 2, Specials and Season 1 (added out of order), an episode in each numbered season, and an orphan season. */
const breakingBad = (api: TestApi) =>
  publishTree(api, [
    tvWork('show', 'series', 'Breaking Bad'),
    tvWork('s2', 'season', 'Breaking Bad Season 2'),
    tvWork('s0', 'season', 'Breaking Bad Specials'),
    tvWork('s1', 'season', 'Breaking Bad Season 1'),
    tvWork('pilot', 'episode', 'Pilot'),
    tvWork('s2e1', 'episode', 'Seven Thirty-Seven'),
    tvWork('orphan', 'season', 'Lost Season'),
    partOf('show', 's2', 2),
    partOf('show', 's0', 0),
    partOf('show', 's1', 1),
    partOf('s1', 'pilot', 1),
    partOf('s2', 's2e1', 1),
  ]);

async function treePage(pick: string) {
  const t = await renderApp('/', { seed: breakingBad });
  const id = t.seeded[pick];
  if (!id) throw new Error(`no ${pick} in the tree`);
  await t.router.navigate({ to: '/entities/$id', params: { id } });
  return t;
}

test('episode page shows breadcrumbs', async () => {
  const t = await treePage('pilot');

  const crumbs = await screen.findByRole('navigation', { name: 'Part of' });
  expect(within(crumbs).getByRole('link', { name: 'Breaking Bad' })).toHaveAttribute(
    'href',
    `/entities/${t.seeded.show}`,
  );
  expect(within(crumbs).getByRole('link', { name: 'Breaking Bad Season 1' })).toHaveAttribute(
    'href',
    `/entities/${t.seeded.s1}`,
  );
  expect(crumbs).toHaveTextContent(/Pilot$/);
  expect(within(crumbs).queryByRole('link', { name: 'Pilot' })).not.toBeInTheDocument();
});

test('a removed ancestor shows as "a removed work", with no link', async () => {
  const t = await renderApp('/', {
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const changes = [
        tvWork('show', 'series', 'Gone Show'),
        tvWork('season', 'season', 'Gone Season'),
        tvWork('episode', 'episode', 'Gone Episode'),
        partOf('show', 'season', 1),
        partOf('season', 'episode', 1),
      ];
      const made = await publish(contributor, moderator, changes);
      const admin = api.as({ kind: 'user', userId: await api.createUser({ role: 'admin' }) });
      const removed = await admin.post(`/api/admin/changes/${made.changes[0]?.id}/redact`, {
        reason: 'Abuse',
        removeEntity: true,
      });
      expect(removed.status, await removed.clone().text()).toBe(200);
      return idsByRef(changes, made.changes);
    },
  });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.episode ?? '' } });

  const crumbs = await screen.findByRole('navigation', { name: 'Part of' });
  expect(crumbs).toHaveTextContent('a removed work');
  expect(crumbs).not.toHaveTextContent('Gone Show');
  expect(
    within(crumbs)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toEqual(['Gone Season']);
});

test('show page lists its seasons in order', async () => {
  await treePage('show');

  const seasons = await screen.findByRole('region', { name: 'Seasons' });
  const rows = within(seasons).getAllByRole('listitem');
  expect(rows.map((row) => within(row).getByRole('link').textContent)).toEqual([
    expect.stringMatching(/^Season 1/),
    expect.stringMatching(/^Season 2/),
    expect.stringMatching(/^Specials/),
  ]);
  expect(screen.queryByRole('navigation', { name: 'Part of' })).not.toBeInTheDocument();
});

test('season page lists its episodes by season number', async () => {
  const t = await treePage('s2');

  const episodes = await screen.findByRole('region', { name: 'Episodes' });
  expect(within(episodes).getByRole('link', { name: /^S2E1 · Seven Thirty-Seven/ })).toHaveAttribute(
    'href',
    `/entities/${t.seeded.s2e1}`,
  );
});

test('mixed parts get the combined heading', async () => {
  const t = await renderApp('/', {
    seed: (api) =>
      publishTree(api, [
        tvWork('show', 'series', 'Mixed Show'),
        tvWork('season', 'season', 'Mixed Season'),
        tvWork('episode', 'episode', 'Mixed Episode'),
        partOf('show', 'season', 1),
        partOf('show', 'episode', 3),
      ]),
  });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.show ?? '' } });

  const parts = await screen.findByRole('region', { name: 'Seasons and episodes' });
  expect(within(parts).getByRole('link', { name: /^Season 1/ })).toBeInTheDocument();
  expect(within(parts).getByRole('link', { name: /^Episode 3 · Mixed Episode/ })).toBeInTheDocument();
});

test('a long season loads more', async () => {
  const t = await renderApp('/', {
    seed: async (api) => {
      const changes = [
        tvWork('show', 'series', 'Long Show'),
        tvWork('season', 'season', 'Long Season'),
        partOf('show', 'season', 1),
        ...Array.from({ length: 60 }, (_, i) => [
          tvWork(`e${i + 1}`, 'episode', `Long Episode ${i + 1}`),
          partOf('season', `e${i + 1}`, i + 1),
        ]).flat(),
      ];
      const made = await api.importSubmission(changes);
      return idsByRef(changes, made.changes);
    },
  });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.season ?? '' } });

  const rows = async () => within(await screen.findByRole('region', { name: 'Episodes' })).getAllByRole('listitem');
  expect(await rows()).toHaveLength(50);
  await t.user.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(async () => expect(await rows()).toHaveLength(60));
  expect(screen.getByRole('link', { name: /^S1E60 · Long Episode 60/ })).toBeInTheDocument();
});

test('parts list error state', async () => {
  const t = await renderApp('/', { seed: breakingBad });
  const real = t.api.app.request.bind(t.api.app);
  // The only way to make an in-process API fail the way a dropped network does: reject at its request.
  const spy = vi.spyOn(t.api.app, 'request').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes('/parts') ? Promise.reject(new TypeError('Failed to fetch')) : real(input, init);
  });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.show ?? '' } });

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load seasons and episodes");
  spy.mockRestore();
  await t.user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('region', { name: 'Seasons' })).toBeInTheDocument();
});

test('orphaned season says so', async () => {
  await treePage('orphan');

  expect(await screen.findByText('Not attached to a show')).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: 'Part of' })).not.toBeInTheDocument();
});

test('a work with no parts lists none and is not called unattached', async () => {
  await page((s) => s.works.spiritedAway);

  expect(await screen.findByRole('heading', { level: 1, name: 'Spirited Away' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: /Seasons|Episodes/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Not attached to a show')).not.toBeInTheDocument();
});
