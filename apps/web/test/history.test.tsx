import { screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { entityQueryKey, type EntityView } from '@/lib/entity';
import { actors, publish, renderApp, type SignedInAs, type TestApi } from './harness';

const update = (entityId: string, fields: Record<string, unknown>) => ({
  op: 'update',
  kind: 'work',
  entityId,
  fields,
});

/**
 * One work with four changes, by three kinds of author, oldest first: a create by someone with a
 * handle, a year edit by someone without, then a description by an anonymous visitor that was
 * overwritten before an admin erased it, and finally another description by the anonymous visitor.
 */
async function history(api: TestApi) {
  const { moderator } = await actors(api);
  const handleId = await api.createUser();
  const handled = api.as({ kind: 'user', userId: handleId });
  const patched = await handled.patch('/api/me', { handle: 'ghibli_fan' });
  expect(patched.status, await patched.clone().text()).toBe(200);
  const plainId = await api.createUser();
  const plain = api.as({ kind: 'user', userId: plainId });
  const anon = api.as({ kind: 'anon', token: 'a'.repeat(32) });

  const created = await publish(handled, moderator, [
    {
      op: 'create',
      kind: 'work',
      ref: 'w',
      fields: { mediaType: 'film_tv', subtype: 'movie', title: 'Arrival', releaseYear: 2016 },
    },
  ]);
  const id = created.changes[0]?.entityId ?? '';
  await publish(plain, moderator, [update(id, { releaseYear: 2017 })]);
  const secret = await publish(plain, moderator, [update(id, { description: 'secret text' })]);
  await publish(anon, moderator, [update(id, { description: 'A linguist meets aliens.' })]);
  const admin = api.as({ kind: 'user', userId: await api.createUser({ role: 'admin' }) });
  const redacted = await admin.post(`/api/admin/changes/${secret.changes[0]?.id}/redact`, {
    reason: 'Contains personal data',
  });
  expect(redacted.status, await redacted.clone().text()).toBe(200);
  return { id, userIds: [handleId, plainId] };
}

async function open(as?: SignedInAs) {
  const t = await renderApp('/', { as, seed: history });
  await t.router.navigate({ to: '/entities/$id/history', params: { id: t.seeded.id } });
  const list = await screen.findByRole('list', { name: 'History' });
  // Direct children only: a change's fields are a nested list.
  return { ...t, list, items: Array.from(list.children) as HTMLElement[] };
}

test('changes are listed newest first with who, when and what changed', async () => {
  const { items, seeded, api } = await open();

  expect(items).toHaveLength(4);
  expect(items[0]).toHaveTextContent('anonymous');
  expect(items[0]).toHaveTextContent('Changed');
  expect(items[0]).toHaveTextContent('Description');
  expect(items[0]).toHaveTextContent('A linguist meets aliens.');
  expect(items[2]).toHaveTextContent('contributor');
  expect(items[2]).toHaveTextContent('Release year');
  expect(items[2]).toHaveTextContent('2017');
  expect(items[3]).toHaveTextContent('ghibli_fan');
  expect(items[3]).toHaveTextContent('Created');
  expect(items[3]).toHaveTextContent('Arrival');

  // "When" is the API's appliedAt, as a machine-readable time.
  const res = await api.as({ kind: 'none' }).get(`/api/entities/${seeded.id}/history`);
  const body = (await res.json()) as { items: { appliedAt: string }[] };
  expect(within(items[0]!).getByText((_, el) => el?.tagName === 'TIME')).toHaveAttribute(
    'datetime',
    body.items[0]?.appliedAt,
  );
});

test('no account id appears anywhere on the page', async () => {
  const { seeded } = await open();

  for (const userId of seeded.userIds) expect(document.body.textContent).not.toContain(userId);
});

test('a redacted change shows its reason and none of its content', async () => {
  const { items } = await open();

  expect(items[1]).toHaveTextContent('Removed: Contains personal data');
  expect(items[1]).not.toHaveTextContent('secret text');
  expect(within(items[1]!).queryByRole('button')).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain('secret text');
});

test('moderators see a Revert button on each live change', async () => {
  const { list } = await open('moderator');

  // Not on the redacted one.
  expect(within(list).getAllByRole('button', { name: /^Revert/ })).toHaveLength(3);
});

test.each(['anonymous', 'contributor'] as const)('%s visitors do not see Revert', async (as) => {
  const { list } = await open(as);

  expect(within(list).queryByRole('button', { name: /^Revert/ })).not.toBeInTheDocument();
});

test('reverting adds a revert to the history and updates the entry', async () => {
  const { user, list, items, router, seeded } = await open('moderator');
  const queryClient = router.options.context.queryClient;
  const yearOf = () =>
    (queryClient.getQueryData(entityQueryKey(seeded.id)) as EntityView | undefined)?.fields.releaseYear;
  await waitFor(() => expect(yearOf()).toBe(2017));

  // The year edit, third from the top.
  await user.click(within(items[2]!).getByRole('button', { name: /^Revert/ }));

  expect(await within(list).findByText('Reverted an earlier change')).toBeInTheDocument();
  expect(list.children).toHaveLength(5);
  // The entry's cached copy was invalidated and refetched while still on the history page.
  await waitFor(() => expect(yearOf()).toBe(2016));
  await router.navigate({ to: '/entities/$id', params: { id: seeded.id } });
  expect(await screen.findByRole('heading', { level: 1, name: 'Arrival' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('2016')).toBeInTheDocument());
  expect(screen.queryByText('2017')).not.toBeInTheDocument();
});

test('a change already reverted offers no Revert, since the API would refuse it', async () => {
  const { user, list, items } = await open('moderator');
  expect(within(list).getAllByRole('button', { name: /^Revert/ })).toHaveLength(3);

  // The year edit, third from the top.
  await user.click(within(items[2]!).getByRole('button', { name: /^Revert/ }));
  expect(await within(list).findByText('Reverted an earlier change')).toBeInTheDocument();

  // Now: the revert (which can't be reverted), the anonymous edit, the redacted one, the reverted
  // year edit and the create; only the anonymous edit and the create still offer it.
  await waitFor(() => expect(within(list).getAllByRole('button', { name: /^Revert/ })).toHaveLength(2));
  const yearEdit = Array.from(list.children).find((li) => li.textContent?.includes('2017')) as HTMLElement;
  expect(within(yearEdit).queryByRole('button', { name: /^Revert/ })).not.toBeInTheDocument();
});

test('a revert the API refuses is explained in words', async () => {
  const { user, list } = await open('moderator');

  // The create has later changes built on it.
  await user.click(
    within(list)
      .getAllByRole('button', { name: /^Revert/ })
      .at(-1)!,
  );

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent("Other entries or later changes build on this, so it can't be undone yet.");
  expect(alert).not.toHaveTextContent('has_dependents');
});

test('a failed Load more keeps the first page, says so, and loads on a second try', async () => {
  const t = await renderApp('/', {
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const created = await publish(contributor, moderator, [
        { op: 'create', kind: 'work', ref: 'w', fields: { mediaType: 'book', subtype: null, title: 'Long Tale' } },
      ]);
      const id = created.changes[0]?.entityId;
      if (!id) throw new Error('the create made no entity');
      // Twenty edits, one at a time (each is made against the last): with the create, a page and one more.
      for (let i = 0; i < 20; i++) await publish(contributor, moderator, [update(id, { releaseYear: 1900 + i })]);
      return id;
    },
  });
  const real = t.api.app.request.bind(t.api.app);
  let failing = true;
  vi.spyOn(t.api.app, 'request').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return failing && url.includes('/history') && url.includes('cursor=')
      ? Promise.reject(new TypeError('Failed to fetch'))
      : real(input, init);
  });
  await t.router.navigate({ to: '/entities/$id/history', params: { id: t.seeded } });
  const list = await screen.findByRole('list', { name: 'History' });
  expect(list.children).toHaveLength(20);

  await t.user.click(screen.getByRole('button', { name: 'Load more' }));

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach AMDB");
  expect(screen.getByRole('list', { name: 'History' }).children).toHaveLength(20);
  failing = false;
  await t.user.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(screen.getByRole('list', { name: 'History' }).children).toHaveLength(21));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a failed history load says so and Try again loads it', async () => {
  const t = await renderApp('/', { seed: history });
  const real = t.api.app.request.bind(t.api.app);
  // The only way to make an in-process API fail the way a dropped network does: reject at its request.
  const spy = vi.spyOn(t.api.app, 'request').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes('/history') ? Promise.reject(new TypeError('Failed to fetch')) : real(input, init);
  });
  await t.router.navigate({ to: '/entities/$id/history', params: { id: t.seeded.id } });

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the history");
  spy.mockRestore();
  await t.user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('list', { name: 'History' })).toBeInTheDocument();
});
