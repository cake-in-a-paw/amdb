import { screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { actors, publish, renderApp, seed } from './harness';

const book = (ref: string, title: string) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType: 'book', subtype: null, title },
});

/** Two duplicate works, published; returns the loser's and the winner's ids after merging. */
async function merged(api: Parameters<typeof seed>[0]) {
  const { contributor, moderator } = await actors(api);
  const made = await publish(contributor, moderator, [book('a', 'Dupe'), book('b', 'Winner')]);
  const [loser, winner] = [made.changes[0]?.entityId ?? '', made.changes[1]?.entityId ?? ''];
  await publish(contributor, moderator, [{ op: 'merge', kind: 'work', from: loser, into: winner }]);
  return { loser, winner };
}

test('a merged id replaces the URL with the winner and shows its page', async () => {
  const t = await renderApp('/', { seed: merged });

  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.loser } });

  expect(await screen.findByRole('heading', { level: 1, name: 'Winner' })).toBeInTheDocument();
  await waitFor(() => expect(t.router.state.location.pathname).toBe(`/entities/${t.seeded.winner}`));
  // Replaced, not pushed: Back doesn't return to the dead id.
  expect(t.router.history.length).toBe(2);
});

test("a merged id's history lands on the winner's history", async () => {
  const t = await renderApp('/', { seed: merged });

  await t.router.navigate({ to: '/entities/$id/history', params: { id: t.seeded.loser } });

  await waitFor(() => expect(t.router.state.location.pathname).toBe(`/entities/${t.seeded.winner}/history`));
  expect(await screen.findByRole('heading', { level: 1, name: 'Winner' })).toBeInTheDocument();
});

test('a removed id says the entry was removed and shows no fields', async () => {
  const t = await renderApp('/', {
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const made = await publish(contributor, moderator, [book('x', 'Doomed Title')]);
      const admin = api.as({ kind: 'user', userId: await api.createUser({ role: 'admin' }) });
      const res = await admin.post(`/api/admin/changes/${made.changes[0]?.id}/redact`, {
        reason: 'Legal request',
        removeEntity: true,
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return made.changes[0]?.entityId ?? '';
    },
  });

  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded } });

  expect(await screen.findByText('This entry was removed')).toBeInTheDocument();
  expect(screen.queryByText('Doomed Title')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 1, name: 'Doomed Title' })).not.toBeInTheDocument();
});

test('an unknown id says Not found', async () => {
  await renderApp(`/entities/${crypto.randomUUID()}`);

  expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
});

test('an id that is not an id says Not found too', async () => {
  await renderApp('/entities/not-an-id');

  expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
});

test('while the entry loads, the page says so', async () => {
  const t = await renderApp('/', { seed });
  const real = t.api.app.request.bind(t.api.app);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const spy = vi.spyOn(t.api.app, 'request').mockImplementation(async (input, init) => {
    await gate;
    return real(input, init);
  });

  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.works.spiritedAway } });

  expect(screen.getByRole('status')).toHaveTextContent('Loading');
  release();
  expect(await screen.findByRole('heading', { level: 1, name: 'Spirited Away' })).toBeInTheDocument();
  spy.mockRestore();
});

test('a network error shows a retry button that works', async () => {
  const t = await renderApp('/', { seed });
  const real = t.api.app.request.bind(t.api.app);
  const spy = vi.spyOn(t.api.app, 'request').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes('/api/entities/') ? Promise.reject(new TypeError('Failed to fetch')) : real(input, init);
  });

  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.works.spiritedAway } });

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent("Couldn't reach AMDB");
  spy.mockRestore();
  await t.user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Spirited Away' })).toBeInTheDocument();
});
