import { screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { actors, publish, renderApp, type TestApi } from './harness';

const meOf = async (api: TestApi, userId: string) =>
  (await (await api.as({ kind: 'user', userId }).get('/api/me')).json()) as { email: string; role: string };

test('non-admins get Not found at the user admin page', async () => {
  await renderApp('/admin/users', { as: 'moderator' });
  expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
});

test('an admin finds a user by email and makes them a moderator', async () => {
  const { user, api, seeded } = await renderApp('/admin/users', {
    as: 'admin',
    seed: async (a) => {
      const id = await a.createUser({ email: 'sam@example.test' });
      return { id };
    },
  });

  await user.type(await screen.findByLabelText('Email'), 'sam@example.test');
  await user.click(screen.getByRole('button', { name: 'Find' }));
  const row = await screen.findByRole('listitem', { name: /sam@example.test/ });
  await user.selectOptions(within(row).getByLabelText('Role'), 'moderator');
  await user.click(within(row).getByRole('button', { name: 'Save role' }));

  expect(await within(row).findByText('Saved: moderator')).toBeInTheDocument();
  expect(await meOf(api, seeded.id)).toMatchObject({ role: 'moderator' });
});

test('an email nobody has says so', async () => {
  const { user } = await renderApp('/admin/users', { as: 'admin' });
  await user.type(await screen.findByLabelText('Email'), 'nobody@example.test');
  await user.click(screen.getByRole('button', { name: 'Find' }));
  expect(await screen.findByText('No account has that email.')).toBeInTheDocument();
});

test("the last admin can't demote themselves", async () => {
  const { user, api, session } = await renderApp('/admin/users', { as: 'admin' });
  const me = await meOf(api, session.userId ?? '');

  await user.type(await screen.findByLabelText('Email'), me.email);
  await user.click(screen.getByRole('button', { name: 'Find' }));
  const row = await screen.findByRole('listitem', { name: new RegExp(me.email) });
  await user.selectOptions(within(row).getByLabelText('Role'), 'contributor');
  await user.click(within(row).getByRole('button', { name: 'Save role' }));

  expect(await within(row).findByRole('alert')).toHaveTextContent("You're the last admin");
  expect(await meOf(api, session.userId ?? '')).toMatchObject({ role: 'admin' });
});

async function liveWork(api: TestApi) {
  const { contributor, moderator } = await actors(api);
  const created = await publish(contributor, moderator, [
    {
      op: 'create',
      kind: 'work',
      ref: 'w',
      fields: { mediaType: 'film_tv', subtype: 'movie', title: 'Arrival', releaseYear: 2016 },
    },
  ]);
  return { id: created.changes[0]?.entityId ?? '' };
}

test('an admin redacts a live change: the dialog explains it takes the content down, then does', async () => {
  const { user, api, seeded, router } = await renderApp('/', { as: 'admin', seed: liveWork });
  await router.navigate({ to: '/entities/$id/history', params: { id: seeded.id } });
  const item = (await screen.findByRole('list', { name: 'History' })).children[0] as HTMLElement;

  await user.click(within(item).getByRole('button', { name: /Redact/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Redact this change' });
  await user.type(within(dialog).getByLabelText('Reason'), 'Contains personal data');
  await user.click(within(dialog).getByRole('button', { name: 'Redact' }));

  expect(await within(dialog).findByText(/also takes the content down/)).toBeInTheDocument();
  expect((await api.as({ kind: 'none' }).get(`/api/entities/${seeded.id}`)).status).toBe(200);
  await user.click(within(dialog).getByRole('button', { name: 'Redact and take down' }));

  // The entry is down, so its page says so instead of the history.
  expect(await screen.findByRole('heading', { name: 'This entry was removed' })).toBeInTheDocument();
  expect((await api.as({ kind: 'none' }).get(`/api/entities/${seeded.id}`)).status).toBe(410);
});

test('redacting a change that is no longer current needs no takedown and leaves a stub in the history', async () => {
  const { user, api, seeded, router } = await renderApp('/', {
    as: 'admin',
    seed: async (a) => {
      const { id } = await liveWork(a);
      const { contributor, moderator } = await actors(a);
      const edit = (releaseYear: number) => ({ op: 'update', kind: 'work', entityId: id, fields: { releaseYear } });
      await publish(contributor, moderator, [edit(2017)]);
      await publish(contributor, moderator, [edit(2018)]);
      return { id };
    },
  });
  await router.navigate({ to: '/entities/$id/history', params: { id: seeded.id } });
  const list = await screen.findByRole('list', { name: 'History' });
  // Newest first: the 2018 edit, the 2017 edit it overwrote, then the create.
  const overwritten = list.children[1] as HTMLElement;
  expect(overwritten).toHaveTextContent('2017');

  await user.click(within(overwritten).getByRole('button', { name: /Redact/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Redact this change' });
  await user.type(within(dialog).getByLabelText('Reason'), 'Contains personal data');
  await user.click(within(dialog).getByRole('button', { name: 'Redact' }));

  expect(await screen.findByText('Removed: Contains personal data')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect((await api.as({ kind: 'none' }).get(`/api/entities/${seeded.id}`)).status).toBe(200);
});

test('redacting needs a reason', async () => {
  const { user, router, seeded } = await renderApp('/', { as: 'admin', seed: liveWork });
  await router.navigate({ to: '/entities/$id/history', params: { id: seeded.id } });
  const item = (await screen.findByRole('list', { name: 'History' })).children[0] as HTMLElement;

  await user.click(within(item).getByRole('button', { name: /Redact/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Redact this change' });
  await user.click(within(dialog).getByRole('button', { name: 'Redact' }));

  expect(within(dialog).getByRole('alert')).toHaveTextContent('Give a reason');
});

test('moderators can revert but not redact', async () => {
  const { router, seeded } = await renderApp('/', { as: 'moderator', seed: liveWork });
  await router.navigate({ to: '/entities/$id/history', params: { id: seeded.id } });
  const item = (await screen.findByRole('list', { name: 'History' })).children[0] as HTMLElement;

  expect(within(item).getByRole('button', { name: /Revert/ })).toBeInTheDocument();
  expect(within(item).queryByRole('button', { name: /Redact/ })).not.toBeInTheDocument();
});

test('a failed takedown retry says so instead of staying silent', async () => {
  const { user, api, seeded, router } = await renderApp('/', { as: 'admin', seed: liveWork });
  await router.navigate({ to: '/entities/$id/history', params: { id: seeded.id } });
  const item = (await screen.findByRole('list', { name: 'History' })).children[0] as HTMLElement;
  await user.click(within(item).getByRole('button', { name: /Redact/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Redact this change' });
  await user.type(within(dialog).getByLabelText('Reason'), 'Contains personal data');
  await user.click(within(dialog).getByRole('button', { name: 'Redact' }));
  await within(dialog).findByRole('button', { name: 'Redact and take down' });

  // Network fault: the retry with removeEntity never gets an answer.
  const spy = vi.spyOn(api.app, 'request').mockRejectedValueOnce(new TypeError('offline'));
  await user.click(within(dialog).getByRole('button', { name: 'Redact and take down' }));

  expect(await within(dialog).findByText(/Couldn't reach AMDB/)).toBeInTheDocument();
  spy.mockRestore();
  expect((await api.as({ kind: 'none' }).get(`/api/entities/${seeded.id}`)).status).toBe(200);
});

test('a failed account lookup shows an error with retry, not Not found', async () => {
  const { api, router, user } = await renderApp('/', { as: 'admin' });
  const real = api.app.request.bind(api.app);
  // Network fault: /api/me never gets an answer while the page loads.
  const spy = vi.spyOn(api.app, 'request').mockImplementation(async (...args: Parameters<typeof real>) => {
    const [input] = args;
    if (String(input instanceof Request ? input.url : input).includes('/api/me')) throw new TypeError('offline');
    return real(...args);
  });
  // Forget the account the shell loaded, so the page has to ask again.
  router.options.context.queryClient.removeQueries({ queryKey: ['me'] });
  await router.navigate({ to: '/admin/users' });
  expect(await screen.findByText(/Couldn't load your account/)).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Not found' })).not.toBeInTheDocument();
  spy.mockRestore();

  await user.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
});

test('redacting a change another admin already redacted says so', async () => {
  const { user, api, seeded, router } = await renderApp('/', {
    as: 'admin',
    seed: async (a) => {
      const { id } = await liveWork(a);
      const { contributor, moderator } = await actors(a);
      const edit = (releaseYear: number) => ({ op: 'update', kind: 'work', entityId: id, fields: { releaseYear } });
      const overwritten = await publish(contributor, moderator, [edit(2017)]);
      await publish(contributor, moderator, [edit(2018)]);
      return { id, overwritten: overwritten.changes[0]?.id ?? '' };
    },
  });
  await router.navigate({ to: '/entities/$id/history', params: { id: seeded.id } });
  const list = await screen.findByRole('list', { name: 'History' });
  const overwritten = list.children[1] as HTMLElement;
  await user.click(within(overwritten).getByRole('button', { name: /Redact/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Redact this change' });
  await user.type(within(dialog).getByLabelText('Reason'), 'Contains personal data');
  // Another admin redacts the same change first.
  const other = api.as({ kind: 'user', userId: await api.createUser({ role: 'admin' }) });
  const first = await other.post(`/api/admin/changes/${seeded.overwritten}/redact`, { reason: 'Legal request' });
  expect(first.status, await first.clone().text()).toBe(200);

  await user.click(within(dialog).getByRole('button', { name: 'Redact' }));

  expect(await within(dialog).findByText('Someone already removed this change.')).toBeInTheDocument();
});

test('finding again shows a role changed elsewhere since the last lookup', async () => {
  const { user, api, seeded } = await renderApp('/admin/users', {
    as: 'admin',
    seed: async (a) => ({ id: await a.createUser({ email: 'sam@example.test' }) }),
  });
  await user.type(await screen.findByLabelText('Email'), 'sam@example.test');
  await user.click(screen.getByRole('button', { name: 'Find' }));
  const before = await screen.findByRole('listitem', { name: /sam@example.test/ });
  expect(within(before).getByLabelText('Role')).toHaveValue('contributor');

  // Another admin promotes Sam meanwhile.
  const other = api.as({ kind: 'user', userId: await api.createUser({ role: 'admin' }) });
  const promoted = await other.post(`/api/admin/users/${seeded.id}/role`, { role: 'moderator' });
  expect(promoted.status, await promoted.clone().text()).toBe(200);
  await user.click(screen.getByRole('button', { name: 'Find' }));

  await waitFor(() =>
    expect(within(screen.getByRole('listitem', { name: /sam@example.test/ })).getByLabelText('Role')).toHaveValue(
      'moderator',
    ),
  );
});

test('an admin who steps down to moderator is told the page is now closed to them', async () => {
  const { user, api, session } = await renderApp('/admin/users', { as: 'admin' });
  // Another admin exists, so stepping down is allowed.
  await api.createUser({ role: 'admin' });
  const me = await meOf(api, session.userId ?? '');

  await user.type(await screen.findByLabelText('Email'), me.email);
  await user.click(screen.getByRole('button', { name: 'Find' }));
  const row = await screen.findByRole('listitem', { name: new RegExp(me.email) });
  await user.selectOptions(within(row).getByLabelText('Role'), 'moderator');
  await user.click(within(row).getByRole('button', { name: 'Save role' }));

  expect(await screen.findByRole('status')).toHaveTextContent("Your role is now moderator, so you can't manage users");
  expect(screen.queryByRole('heading', { name: 'Not found' })).not.toBeInTheDocument();
  expect(await meOf(api, session.userId ?? '')).toMatchObject({ role: 'moderator' });
});

test('Find with no email asks the API nothing', async () => {
  const { user, api } = await renderApp('/admin/users', { as: 'admin' });
  const spy = vi.spyOn(api.app, 'request');

  await user.type(await screen.findByLabelText('Email'), '   ');
  await user.click(screen.getByRole('button', { name: 'Find' }));

  expect(
    spy.mock.calls.filter(([input]) =>
      String(input instanceof Request ? input.url : input).includes('/api/admin/users'),
    ),
  ).toEqual([]);
  expect(screen.queryByRole('list', { name: 'Accounts' })).not.toBeInTheDocument();
});
