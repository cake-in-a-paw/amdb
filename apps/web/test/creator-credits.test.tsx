import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { actors, publish, publishShowCredits, renderApp } from './harness';

const texts = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');

test("a creator's credits in one show list depth-first", async () => {
  const t = await renderApp('/', { seed: (api) => publishShowCredits(api, { directedShow: true }) });
  await t.router.navigate({
    to: '/entities/$id/credits/$workId',
    params: { id: t.seeded.creator, workId: t.seeded.show },
  });

  const heading = await screen.findByRole('heading', { level: 2, name: 'In Show' });
  expect(within(heading).getByRole('link', { name: 'Show' })).toHaveAttribute('href', `/entities/${t.seeded.show}`);
  const items = texts(await screen.findByRole('list', { name: 'In Show' }));
  expect(items).toHaveLength(3);
  expect(items[0]).toContain('Show');
  expect(items[0]).toContain('Director');
  expect(items[1]).toContain('S1E1 · Pilot');
  expect(items[1]).toContain('Writer');
  expect(items[2]).toContain('S1E2 · Two');
  expect(items[2]).toContain('Director');
});

test('the episode count opens the focused page', async () => {
  const t = await renderApp('/', { seed: (api) => publishShowCredits(api) });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.creator } });

  await t.user.click(await screen.findByRole('link', { name: '2 episodes in Show' }));

  expect(await screen.findByRole('heading', { level: 2, name: 'In Show' })).toBeInTheDocument();
  expect(t.router.state.location.pathname).toBe(`/entities/${t.seeded.creator}/credits/${t.seeded.show}`);
});

test('a removed show reads as a removed work, and its episodes stay reachable', async () => {
  const t = await renderApp('/', {
    seed: async (api) => {
      const ids = await publishShowCredits(api);
      const admin = api.as({ kind: 'user', userId: await api.createUser({ role: 'admin' }) });
      const res = await admin.post(`/api/admin/changes/${ids.showCreate}/redact`, {
        reason: 'Legal request',
        removeEntity: true,
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return ids;
    },
  });
  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.creator } });

  const list = await screen.findByRole('list', { name: 'Works' });
  expect(texts(list)[0]).toContain('a removed work');
  // The row's title isn't a link: the only link is the count's.
  expect(within(list).getAllByRole('link')).toHaveLength(1);
  await t.user.click(within(list).getByRole('link', { name: '2 episodes in a removed work' }));

  const heading = await screen.findByRole('heading', { level: 2, name: 'In a removed work' });
  expect(within(heading).queryByRole('link')).not.toBeInTheDocument();
  const items = texts(screen.getByRole('list', { name: 'In a removed work' }));
  expect(items).toHaveLength(2);
  expect(items[0]).toContain('S1E1 · Pilot');
  expect(items[1]).toContain('S1E2 · Two');
});

test("a merged creator's credits page lands on the winner's", async () => {
  const t = await renderApp('/', {
    seed: async (api) => {
      const ids = await publishShowCredits(api);
      const { contributor, moderator } = await actors(api);
      const made = await publish(contributor, moderator, [
        { op: 'create', kind: 'creator', ref: 'dupe', fields: { name: 'Dupe', kind: 'person' } },
      ]);
      const loser = made.changes[0]?.entityId ?? '';
      await publish(contributor, moderator, [{ op: 'merge', kind: 'creator', from: loser, into: ids.creator }]);
      return { ...ids, loser };
    },
  });

  await t.router.navigate({
    to: '/entities/$id/credits/$workId',
    params: { id: t.seeded.loser, workId: t.seeded.show },
  });

  await waitFor(() =>
    expect(t.router.state.location.pathname).toBe(`/entities/${t.seeded.creator}/credits/${t.seeded.show}`),
  );
  expect(await screen.findByRole('heading', { level: 2, name: 'In Show' })).toBeInTheDocument();
});
