import { screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { renderApp, seed, type TestApi } from './harness';

const urlOf = (input: Request | string | URL) => (input instanceof Request ? input.url : String(input));

type Created = { id: string; changes: { id: string; entityId: string | null }[] };

/** A contributor's submission that a moderator rejected: the author's client, and the rejected change's id. */
async function rejected(
  api: TestApi,
  authorId: string,
  changes: unknown[],
  reason = 'Please add the year to the title.',
) {
  const author = api.as({ kind: 'user', userId: authorId });
  const moderator = api.as({ kind: 'user', userId: await api.createUser({ role: 'moderator' }) });
  const res = await author.post('/api/submissions', { cc0: true, changes });
  expect(res.status, await res.clone().text()).toBe(201);
  const created = (await res.json()) as Created;
  const first = created.changes[0];
  const rejection = await moderator.post(`/api/changes/${first?.id}/reject`, { reason });
  expect(rejection.status, await rejection.clone().text()).toBe(200);
  return { author, changeId: first?.id ?? '', submissionId: created.id };
}

const arrival = {
  op: 'create',
  kind: 'work',
  ref: 'w',
  fields: {
    mediaType: 'film_tv',
    subtype: 'movie',
    title: 'Arrival',
    releaseYear: 2016,
    description: 'Linguist meets aliens.',
    attributes: { runtimeMin: 116 },
  },
};

/** Records the JSON bodies of POSTs to the resubmit endpoint; a body can be read once, so each is copied first. */
function watchResubmits(t: { api: TestApi }) {
  const real = t.api.app.request.bind(t.api.app);
  const bodies: Promise<unknown>[] = [];
  vi.spyOn(t.api.app, 'request').mockImplementation((input, init) => {
    if (urlOf(input).endsWith('/resubmit') && input instanceof Request) {
      bodies.push(
        input
          .clone()
          .text()
          .then((raw) => JSON.parse(raw)),
      );
    }
    return real(input, init);
  });
  return () => Promise.all(bodies);
}

test('a rejected create opens with its reason and its fields filled in; submitting sends only what changed', async () => {
  const t = await renderApp('/', { as: 'contributor' });
  const r = await rejected(t.api, t.session.userId ?? '', [arrival]);
  const sent = watchResubmits(t);

  await t.router.navigate({ to: '/changes/$id/resubmit', params: { id: r.changeId } });

  expect(screen.getByRole('heading', { name: 'Fix and resubmit' })).toBeInTheDocument();
  expect(await screen.findByText('Reason: Please add the year to the title.')).toBeInTheDocument();
  const title = screen.getByLabelText('Title');
  expect(title).toHaveValue('Arrival');
  expect(screen.getByLabelText('Release year')).toHaveValue(2016);
  expect(screen.getByLabelText('Runtime (minutes)')).toHaveValue(116);
  expect(screen.getByLabelText('Media type')).toBeEnabled();
  expect(screen.queryByRole('group', { name: 'What are you adding?' })).not.toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Credits' })).not.toBeInTheDocument();

  await t.user.clear(title);
  await t.user.type(title, 'Arrival (2016)');
  const shown = t.router.options.context.queryClient.getQueryState(['change', r.changeId])?.dataUpdatedAt ?? 0;
  await t.user.click(screen.getByRole('button', { name: 'Resubmit for review' }));

  // Back in My submissions, the new change is waiting.
  const list = await screen.findByRole('list', { name: 'Your submissions' });
  expect(await within(list).findByText('Waiting for review')).toBeInTheDocument();
  expect(await sent()).toEqual([{ fields: { title: 'Arrival (2016)' } }]);
  // The change was read again after the resubmit, not left as the page first saw it.
  expect(t.router.options.context.queryClient.getQueryState(['change', r.changeId])?.dataUpdatedAt).toBeGreaterThan(
    shown,
  );

  // What the API stored: the rejected fields with the new title laid over them.
  const mine = (await (await r.author.get('/api/me/submissions')).json()) as { items: { id: string }[] };
  const newest = mine.items[0];
  expect(newest?.id).not.toBe(r.submissionId);
  const detail = (await (await r.author.get(`/api/submissions/${newest?.id}`)).json()) as {
    changes: { status: string; payload: Record<string, unknown> }[];
  };
  expect(detail.changes[0]?.status).toBe('pending');
  expect(detail.changes[0]?.payload).toMatchObject({
    title: 'Arrival (2016)',
    releaseYear: 2016,
    description: 'Linguist meets aliens.',
  });
});

test('"Fix and resubmit" in My submissions opens the resubmit page', async () => {
  const t = await renderApp('/', { as: 'contributor' });
  const r = await rejected(t.api, t.session.userId ?? '', [arrival]);

  await t.router.navigate({ to: '/me/submissions' });
  await t.user.click(await screen.findByRole('link', { name: 'Fix and resubmit' }));

  expect(t.router.state.location.pathname).toBe(`/changes/${r.changeId}/resubmit`);
  expect(await screen.findByLabelText('Title')).toHaveValue('Arrival');
});

test('a rejected edit opens over the entry as it is now, and its media type is fixed', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  const r = await rejected(
    t.api,
    t.session.userId ?? '',
    [{ op: 'update', kind: 'work', entityId: id, fields: { releaseYear: 2002 } }],
    'The release year is 2001.',
  );
  const sent = watchResubmits(t);

  await t.router.navigate({ to: '/changes/$id/resubmit', params: { id: r.changeId } });

  expect(await screen.findByText('Reason: The release year is 2001.')).toBeInTheDocument();
  expect(await screen.findByLabelText('Title')).toHaveValue('Spirited Away');
  expect(screen.getByLabelText('Release year')).toHaveValue(2002);
  expect(screen.getByLabelText('Media type')).toBeDisabled();

  await t.user.type(screen.getByLabelText(/^Original title/), 'Sen to Chihiro');
  await t.user.click(screen.getByRole('button', { name: 'Resubmit for review' }));

  const list = await screen.findByRole('list', { name: 'Your submissions' });
  expect(await within(list).findByText('Waiting for review')).toBeInTheDocument();
  // Only what differs from the rejected edit: the year stays as it was proposed.
  expect(await sent()).toEqual([{ fields: { originalTitle: 'Sen to Chihiro' } }]);
});

test('a change that is not rejected, or not yours, cannot be resubmitted', async () => {
  const t = await renderApp('/', { as: 'contributor' });
  const mine = t.api.as({ kind: 'user', userId: t.session.userId ?? '' });
  const res = await mine.post('/api/submissions', { cc0: true, changes: [arrival] });
  const pending = ((await res.json()) as Created).changes[0]?.id ?? '';

  await t.router.navigate({ to: '/changes/$id/resubmit', params: { id: pending } });
  expect(await screen.findByText('Only a rejected change can be resubmitted.')).toBeInTheDocument();

  await t.router.navigate({ to: '/changes/$id/resubmit', params: { id: crypto.randomUUID() } });
  expect(await screen.findByText(/no change like this among your submissions/)).toBeInTheDocument();
});

test('resubmitting twice says it was already resubmitted and keeps the form', async () => {
  const t = await renderApp('/', { as: 'contributor' });
  const r = await rejected(t.api, t.session.userId ?? '', [arrival]);
  expect((await r.author.post(`/api/changes/${r.changeId}/resubmit`, {})).status).toBe(201);

  await t.router.navigate({ to: '/changes/$id/resubmit', params: { id: r.changeId } });
  await t.user.click(await screen.findByRole('button', { name: 'Resubmit for review' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('You already resubmitted this change.');
  expect(screen.getByLabelText('Title')).toHaveValue('Arrival');
});

test('a rejected link has no fields to edit and can be sent again as it was', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const r = await rejected(
    t.api,
    t.session.userId ?? '',
    [
      {
        op: 'relate',
        type: 'work_tag',
        from: { id: t.seeded.works.amelie },
        to: { id: t.seeded.tags.fantasy },
        data: {},
      },
    ],
    'Not fantasy.',
  );

  await t.router.navigate({ to: '/changes/$id/resubmit', params: { id: r.changeId } });

  expect(await screen.findByText(/no fields to edit here/)).toBeInTheDocument();
  await t.user.click(screen.getByRole('button', { name: 'Resubmit for review' }));
  const list = await screen.findByRole('list', { name: 'Your submissions' });
  await waitFor(() => expect(within(list).getAllByText('Waiting for review')).toHaveLength(1));
});

test("a resubmit draft saved before the entry changed keeps only the contributor's edit", async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  const r = await rejected(t.api, t.session.userId ?? '', [
    { op: 'update', kind: 'work', entityId: id, fields: { releaseYear: 2002 } },
  ]);
  const route = { to: '/changes/$id/resubmit', params: { id: r.changeId } } as const;
  await t.router.navigate(route);
  await t.user.type(await screen.findByLabelText(/^Original title/), 'Sen to Chihiro');
  await waitFor(() => expect(localStorage.getItem(`amdb.draft.resubmit.${r.changeId}`)).not.toBeNull());
  await t.router.navigate({ to: '/' });
  // Someone else sets the description meanwhile.
  const moderator = t.api.as({ kind: 'user', userId: await t.api.createUser({ role: 'moderator' }) });
  const other = t.api.as({ kind: 'user', userId: await t.api.createUser() });
  const made = await other.post('/api/submissions', {
    cc0: true,
    changes: [{ op: 'update', kind: 'work', entityId: id, fields: { description: 'Changed by someone else.' } }],
  });
  const changeId = ((await made.json()) as Created).changes[0]?.id;
  expect((await moderator.post(`/api/changes/${changeId}/approve`)).status).toBe(200);
  t.router.options.context.queryClient.removeQueries({ queryKey: ['entity'] });
  const sent = watchResubmits(t);

  await t.router.navigate(route);

  expect(await screen.findByLabelText(/^Original title/)).toHaveValue('Sen to Chihiro');
  expect(screen.getByLabelText(/^Description/)).toHaveValue('Changed by someone else.');
  await t.user.click(screen.getByRole('button', { name: 'Resubmit for review' }));
  await screen.findByRole('list', { name: 'Your submissions' });
  expect(await sent()).toEqual([{ fields: { originalTitle: 'Sen to Chihiro' } }]);
});

test("a background refetch while a rejected edit is open sends only the contributor's edit", async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  const r = await rejected(t.api, t.session.userId ?? '', [
    { op: 'update', kind: 'work', entityId: id, fields: { releaseYear: 2002 } },
  ]);
  await t.router.navigate({ to: '/changes/$id/resubmit', params: { id: r.changeId } });
  await t.user.type(await screen.findByLabelText(/^Original title/), 'Sen to Chihiro');

  // Someone else sets the description while the form is open, and the entry is read again.
  const moderator = t.api.as({ kind: 'user', userId: await t.api.createUser({ role: 'moderator' }) });
  const other = t.api.as({ kind: 'user', userId: await t.api.createUser() });
  const made = await other.post('/api/submissions', {
    cc0: true,
    changes: [{ op: 'update', kind: 'work', entityId: id, fields: { description: 'Changed by someone else.' } }],
  });
  const changeId = ((await made.json()) as Created).changes[0]?.id;
  expect((await moderator.post(`/api/changes/${changeId}/approve`)).status).toBe(200);
  await t.router.options.context.queryClient.refetchQueries({ queryKey: ['entity', id] });
  const sent = watchResubmits(t);

  await t.user.click(screen.getByRole('button', { name: 'Resubmit for review' }));
  await screen.findByRole('list', { name: 'Your submissions' });
  expect(await sent()).toEqual([{ fields: { originalTitle: 'Sen to Chihiro' } }]);
  // The 201 clears the draft for good: nothing is written back after it.
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(localStorage.getItem(`amdb.draft.resubmit.${r.changeId}`)).toBeNull();
});

test('the resubmit conflict notice names fields in words', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  const r = await rejected(t.api, t.session.userId ?? '', [
    { op: 'update', kind: 'work', entityId: id, fields: { releaseYear: 2002 } },
  ]);
  await t.router.navigate({ to: '/changes/$id/resubmit', params: { id: r.changeId } });
  await t.user.type(await screen.findByLabelText(/^Original title/), 'Sen to Chihiro');

  const moderator = t.api.as({ kind: 'user', userId: await t.api.createUser({ role: 'moderator' }) });
  const other = t.api.as({ kind: 'user', userId: await t.api.createUser() });
  const made = await other.post('/api/submissions', {
    cc0: true,
    changes: [{ op: 'update', kind: 'work', entityId: id, fields: { originalTitle: '千と千尋の神隠し' } }],
  });
  const changeId = ((await made.json()) as Created).changes[0]?.id;
  expect((await moderator.post(`/api/changes/${changeId}/approve`)).status).toBe(200);
  await t.router.options.context.queryClient.refetchQueries({ queryKey: ['entity', id] });

  expect(await screen.findByText(/changed since you started editing.*check original title\./)).toBeInTheDocument();
  expect(screen.getByLabelText(/^Original title/)).toHaveValue('Sen to Chihiro');
});

test('a rejected edit whose entry was removed says so, with no retry', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.amelie;
  const r = await rejected(t.api, t.session.userId ?? '', [
    { op: 'update', kind: 'work', entityId: id, fields: { releaseYear: 2002 } },
  ]);
  // An admin takes the entry down for legal reasons after the edit was rejected.
  const admin = t.api.as({ kind: 'user', userId: await t.api.createUser({ role: 'admin' }) });
  const redacted = await admin.post(`/api/admin/changes/${t.seeded.createdBy.amelie}/redact`, {
    reason: 'Legal request',
    removeEntity: true,
  });
  expect(redacted.status, await redacted.clone().text()).toBe(200);

  await t.router.navigate({ to: '/changes/$id/resubmit', params: { id: r.changeId } });

  expect(await screen.findByText(/This entry was removed/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Resubmit for review' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'My submissions' })).toBeInTheDocument();
});
