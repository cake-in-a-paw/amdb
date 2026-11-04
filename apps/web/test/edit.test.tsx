import { screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { actors, publish, renderApp, seed, type TestApi } from './harness';

const CC0 = 'I release this contribution into the public domain (CC0)';

const urlOf = (input: Request | string | URL) => (input instanceof Request ? input.url : String(input));

/**
 * Watches the in-process API; the returned function lists the bodies of the submission POSTs so
 * far. A request's body can be read once, so each is copied before the API takes it.
 */
function watchSubmissions(t: { api: TestApi }) {
  const real = t.api.app.request.bind(t.api.app);
  const bodies: Promise<{ cc0: boolean; changes: Record<string, unknown>[] }>[] = [];
  vi.spyOn(t.api.app, 'request').mockImplementation((input, init) => {
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    if (urlOf(input).endsWith('/api/submissions') && method === 'POST') {
      const text = input instanceof Request ? input.clone().text() : Promise.resolve(String(init?.body));
      bodies.push(text.then((raw) => JSON.parse(raw)));
    }
    return real(input, init);
  });
  return () => Promise.all(bodies);
}

const stored = (key: string) => localStorage.getItem(`amdb.draft.${key}`);

test('the form opens pre-filled from the entry, with its kind and media type fixed', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });

  expect(await screen.findByLabelText('Title')).toHaveValue('Spirited Away');
  expect(screen.getByLabelText('Release year')).toHaveValue(2001);
  expect(screen.getByLabelText('Release month')).toHaveValue('7');
  expect(screen.getByLabelText(/^Description/)).toHaveValue('A girl works in a bathhouse for spirits.');
  expect(screen.getByLabelText('Media type')).toBeDisabled();
  expect(screen.getByLabelText('Media type')).toHaveValue('film_tv');
  expect(screen.queryByRole('group', { name: 'What are you adding?' })).not.toBeInTheDocument();
  // Its relations come with it.
  expect(within(screen.getByRole('list', { name: 'Credits' })).getByText('Hayao Miyazaki')).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Tags' })).getByText('Fantasy')).toBeInTheDocument();
  // It doesn't flag itself as its own duplicate.
  await waitFor(() => expect(screen.queryByText('Checking for duplicates…')).not.toBeInTheDocument());
  expect(screen.queryByRole('link', { name: 'Edit this instead' })).not.toBeInTheDocument();
});

test('changing only the year sends an update with the year alone', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });
  const posts = watchSubmissions(t);

  const year = await screen.findByLabelText('Release year');
  await t.user.clear(year);
  await t.user.type(year, '2002');
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect(await posts()).toEqual([
    {
      cc0: true,
      changes: [{ op: 'update', kind: 'work', entityId: t.seeded.works.spiritedAway, fields: { releaseYear: 2002 } }],
    },
  ]);
});

test('clearing an optional field sends null for it', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });
  const posts = watchSubmissions(t);

  await t.user.clear(await screen.findByLabelText(/^Description/));
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([
    { op: 'update', kind: 'work', entityId: t.seeded.works.spiritedAway, fields: { description: null } },
  ]);
});

test('removing a tag sends an unrelate with its relation id', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });
  const posts = watchSubmissions(t);
  const entity = (await (await t.api.app.request(`/api/entities/${t.seeded.works.spiritedAway}`)).json()) as {
    relations: { tags: { relationId: string }[] };
  };

  await t.user.click(await screen.findByRole('button', { name: 'Remove Fantasy' }));
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([{ op: 'unrelate', relationId: entity.relations.tags[0]?.relationId }]);
});

test('adding a creator sends a relate for it', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });
  const posts = watchSubmissions(t);

  await t.user.type(await screen.findByLabelText('Find a creator'), 'Diana');
  await t.user.click(await screen.findByRole('button', { name: /^Diana Wynne Jones/ }));
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([
    {
      op: 'relate',
      type: 'work_creator',
      from: { id: t.seeded.works.spiritedAway },
      to: { id: t.seeded.creators.jones },
      data: { role: 'director' },
    },
  ]);
});

test("changing a credit's role replaces the credit: an unrelate, then a relate", async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });
  const posts = watchSubmissions(t);

  await t.user.selectOptions(await screen.findByLabelText('Role for Hayao Miyazaki'), 'writer');
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  const changes = (await posts())[0]?.changes ?? [];
  expect(changes.map((c) => c.op)).toEqual(['unrelate', 'relate']);
  expect(changes[1]).toMatchObject({
    type: 'work_creator',
    to: { id: t.seeded.creators.miyazaki },
    data: { role: 'writer' },
  });
});

test('with nothing changed the submit button is disabled and says why', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });

  await t.user.click(await screen.findByLabelText(CC0));
  const submit = screen.getByRole('button', { name: 'Submit for review' });
  expect(submit).toBeDisabled();
  expect(screen.getByText('Nothing has changed yet.')).toBeInTheDocument();

  await t.user.type(screen.getByLabelText(/^Original title/), 'Sen to Chihiro');
  expect(submit).toBeEnabled();
  await t.user.clear(screen.getByLabelText(/^Original title/));
  expect(submit).toBeDisabled();
});

test('the draft is kept under edit.<entityId>, and survives leaving the page', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const edit = { to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } } as const;
  await t.router.navigate(edit);

  await t.user.type(await screen.findByLabelText(/^Original title/), 'Sen to Chihiro');
  await waitFor(() => expect(stored(`edit.${t.seeded.works.spiritedAway}`)).toContain('Sen to Chihiro'));
  expect(stored('submit')).toBeNull();

  await t.router.navigate({ to: '/' });
  await t.router.navigate(edit);
  expect(await screen.findByLabelText(/^Original title/)).toHaveValue('Sen to Chihiro');
});

test('after submitting, the entry says the edit is waiting for review, and the draft is gone', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  await t.router.navigate({ to: '/entities/$id/edit', params: { id } });

  await t.user.clear(await screen.findByLabelText('Release year'));
  await t.user.type(screen.getByLabelText('Release year'), '2002');
  await waitFor(() => expect(stored(`edit.${id}`)).not.toBeNull());
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(await screen.findByText(/Your edit is waiting for review/)).toBeInTheDocument();
  expect(t.router.state.location.pathname).toBe(`/entities/${id}`);
  expect(stored(`edit.${id}`)).toBeNull();
  // The change waits: the entry still shows the published year.
  expect(screen.getByText('Spirited Away', { selector: 'h1' })).toBeInTheDocument();
  expect(screen.getByText(/2001/)).toBeInTheDocument();
});

test("an entry nobody edited has no notice, and neither has one whose edit was someone else's", async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const other = t.api.as({ kind: 'user', userId: await t.api.createUser() });
  const made = await other.post('/api/submissions', {
    cc0: true,
    changes: [{ op: 'update', kind: 'work', entityId: t.seeded.works.spiritedAway, fields: { releaseYear: 2003 } }],
  });
  expect(made.status).toBe(201);

  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.works.spiritedAway } });

  expect(await screen.findByText('Spirited Away', { selector: 'h1' })).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText(/waiting for review/)).not.toBeInTheDocument());
});

test('a rejected-by-API edit keeps the draft and the form', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  await t.router.navigate({ to: '/entities/$id/edit', params: { id } });
  await t.user.type(await screen.findByLabelText(/^Original title/), 'Sen to Chihiro');
  await t.user.click(screen.getByLabelText(CC0));
  const real = t.api.app.request.bind(t.api.app);
  // A 400 from the API for the submission only: the way to make a valid form meet a refusal.
  vi.spyOn(t.api.app, 'request').mockImplementation(async (input, init) =>
    urlOf(input).endsWith('/api/submissions')
      ? Response.json({ error: { code: 'invalid_fields', message: 'no' } }, { status: 400 })
      : real(input, init),
  );

  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(await screen.findByRole('alert')).toHaveTextContent("Some of this isn't valid");
  expect(screen.getByLabelText(/^Original title/)).toHaveValue('Sen to Chihiro');
  await waitFor(() => expect(stored(`edit.${id}`)).toContain('Sen to Chihiro'));
});

test("a merged id opens the winner's edit form", async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const moderator = t.api.as({ kind: 'user', userId: await t.api.createUser({ role: 'moderator' }) });
  const author = t.api.as({ kind: 'user', userId: await t.api.createUser() });
  const dup = await author.post('/api/submissions', {
    cc0: true,
    changes: [{ op: 'create', kind: 'series', ref: 's', fields: { title: 'Howls Castle' } }],
  });
  const created = (await dup.json()) as { changes: { id: string; entityId: string }[] };
  const loser = created.changes[0]?.entityId ?? '';
  await moderator.post(`/api/changes/${created.changes[0]?.id}/approve`);
  const merged = await author.post('/api/submissions', {
    cc0: true,
    changes: [{ op: 'merge', kind: 'series', from: loser, into: t.seeded.series.howlsSeries }],
  });
  await moderator.post(
    `/api/changes/${((await merged.json()) as { changes: { id: string }[] }).changes[0]?.id}/approve`,
  );

  await t.router.navigate({ to: '/entities/$id/edit', params: { id: loser } });

  expect(await screen.findByLabelText('Title')).toHaveValue("Howl's Castle");
  await waitFor(() => expect(t.router.state.location.pathname).toBe(`/entities/${t.seeded.series.howlsSeries}/edit`));
});

/** Starts an edit of Spirited Away (so a draft is saved), leaves, lets `meanwhile` change the entry through the API, and reopens the form. */
async function reopenAfter(
  t: Awaited<ReturnType<typeof renderApp<Awaited<ReturnType<typeof seed>>>>>,
  edit: () => Promise<void>,
  meanwhile: (other: Awaited<ReturnType<typeof actors>>) => Promise<void>,
) {
  const id = t.seeded.works.spiritedAway;
  const route = { to: '/entities/$id/edit', params: { id } } as const;
  await t.router.navigate(route);
  await edit();
  await waitFor(() => expect(stored(`edit.${id}`)).not.toBeNull());
  await t.router.navigate({ to: '/' });
  await meanwhile(await actors(t.api));
  // A fresh load of the entry, as after a reload.
  t.router.options.context.queryClient.removeQueries({ queryKey: ['entity'] });
  await t.router.navigate(route);
}

const familyTag = [
  { op: 'create', kind: 'tag', ref: 'family', fields: { kind: 'genre', name: 'Family', slug: 'family' } },
  { op: 'relate', type: 'work_tag', from: { id: '' }, to: { ref: 'family' }, data: {} },
];

test('a draft saved before someone else changed the entry sends only what the contributor changed', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  await reopenAfter(
    t,
    async () => {
      await t.user.type(await screen.findByLabelText(/^Original title/), 'Sen to Chihiro');
    },
    async ({ contributor, moderator }) => {
      await publish(contributor, moderator, [
        { op: 'update', kind: 'work', entityId: id, fields: { releaseYear: 2003 } },
      ]);
      await publish(
        contributor,
        moderator,
        familyTag.map((c) => ('from' in c ? { ...c, from: { id } } : c)),
      );
    },
  );
  const posts = watchSubmissions(t);

  // The form follows the entry for what the contributor never touched, and keeps their edit.
  expect(await screen.findByLabelText(/^Original title/)).toHaveValue('Sen to Chihiro');
  expect(screen.getByLabelText('Release year')).toHaveValue(2003);
  expect(within(screen.getByRole('list', { name: 'Tags' })).getByText('Family')).toBeInTheDocument();
  expect(screen.queryByText(/changed since you started editing/)).not.toBeInTheDocument();

  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));
  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([
    { op: 'update', kind: 'work', entityId: id, fields: { originalTitle: 'Sen to Chihiro' } },
  ]);
});

test('when both changed the same field the contributor is told, and their value is the one sent', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  await reopenAfter(
    t,
    async () => {
      const year = await screen.findByLabelText('Release year');
      await t.user.clear(year);
      await t.user.type(year, '2002');
    },
    async ({ contributor, moderator }) => {
      await publish(contributor, moderator, [
        { op: 'update', kind: 'work', entityId: id, fields: { releaseYear: 2003 } },
      ]);
    },
  );
  const posts = watchSubmissions(t);

  expect(await screen.findByText(/changed since you started editing.*release year/)).toBeInTheDocument();
  expect(screen.getByLabelText('Release year')).toHaveValue(2002);

  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));
  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([
    { op: 'update', kind: 'work', entityId: id, fields: { releaseYear: 2002 } },
  ]);
});

test('a relation the contributor removed and someone else removed too sends no unrelate', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  await reopenAfter(
    t,
    async () => {
      await t.user.click(await screen.findByRole('button', { name: 'Remove Fantasy' }));
    },
    async ({ contributor, moderator }) => {
      const view = (await (await t.api.app.request(`/api/entities/${id}`)).json()) as {
        relations: { tags: { relationId: string }[] };
      };
      await publish(contributor, moderator, [{ op: 'unrelate', relationId: view.relations.tags[0]?.relationId }]);
    },
  );
  const posts = watchSubmissions(t);

  await screen.findByLabelText('Title');
  expect(within(screen.getByRole('list', { name: 'Tags' })).queryByText('Fantasy')).not.toBeInTheDocument();
  await t.user.click(screen.getByLabelText(CC0));
  expect(screen.getByRole('button', { name: 'Submit for review' })).toBeDisabled();
  await t.user.type(screen.getByLabelText(/^Original title/), 'Sen to Chihiro');
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));
  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([
    { op: 'update', kind: 'work', entityId: id, fields: { originalTitle: 'Sen to Chihiro' } },
  ]);
});
