import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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

  await t.user.click(await screen.findByRole('button', { name: 'Remove Fantasy from tags' }));
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([{ op: 'unrelate', relationId: entity.relations.tags[0]?.relationId }]);
});

test('each Remove button names its row and its section', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  // The film is part of the property "Howl's Moving Castle" and adapted from the book of that name.
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.howlsMovingCastle } });

  await screen.findByLabelText('Title');
  expect(screen.getByRole('button', { name: 'Remove Hayao Miyazaki, Director, from credits' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: "Remove Howl's Moving Castle from properties" })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: "Remove Howl's Moving Castle from related works" })).toBeInTheDocument();
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

test('the draft is kept under edit.<entityId>.<userId>, and survives leaving the page', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const edit = { to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } } as const;
  await t.router.navigate(edit);

  await t.user.type(await screen.findByLabelText(/^Original title/), 'Sen to Chihiro');
  await waitFor(() =>
    expect(stored(`edit.${t.seeded.works.spiritedAway}.${t.session.userId}`)).toContain('Sen to Chihiro'),
  );
  expect(stored(`submit.${t.session.userId}`)).toBeNull();

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
  await waitFor(() => expect(stored(`edit.${id}.${t.session.userId}`)).not.toBeNull());
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(await screen.findByText(/Your edit is waiting for review/)).toBeInTheDocument();
  expect(t.router.state.location.pathname).toBe(`/entities/${id}`);
  expect(stored(`edit.${id}.${t.session.userId}`)).toBeNull();
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
  const route = { to: '/entities/$id/edit', params: { id } } as const;
  const key = `edit.${id}.${t.session.userId}`;
  await t.router.navigate(route);
  await t.user.type(await screen.findByLabelText(/^Original title/), 'Sen to Chihiro');
  await waitFor(() => expect(stored(key)).toContain('Sen to Chihiro'));
  await t.router.navigate({ to: '/' });
  // The draft gains a tag the catalog doesn't have: the form accepts it, the API refuses it.
  const draft = JSON.parse(stored(key) ?? '') as { form: { tags: unknown[] } };
  draft.form.tags.push({ entity: { id: crypto.randomUUID(), title: 'No such tag' } });
  localStorage.setItem(`amdb.draft.${key}`, JSON.stringify(draft));
  await t.router.navigate(route);
  await t.user.click(await screen.findByLabelText(CC0));

  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(await screen.findByRole('alert')).toHaveTextContent("An entry named here doesn't exist (any more).");
  expect(screen.getByLabelText(/^Original title/)).toHaveValue('Sen to Chihiro');
  await waitFor(() => expect(stored(key)).toContain('Sen to Chihiro'));
  expect(stored(key)).toContain('No such tag');
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

test('a draft of an entry merged while it was being edited follows it to the winner', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const winner = t.seeded.series.howlsSeries;
  const { contributor, moderator } = await actors(t.api);
  const made = await publish(contributor, moderator, [
    { op: 'create', kind: 'series', ref: 's', fields: { title: 'Howls Castle' } },
  ]);
  const loser = made.changes[0]?.entityId ?? '';
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: loser } });
  await t.user.type(await screen.findByLabelText(/^Description/), 'Two novels by Diana Wynne Jones.');
  await waitFor(() => expect(stored(`edit.${loser}.${t.session.userId}`)).toContain('Two novels'));

  // A moderator merges the entry while the form is open, and the entry is read again.
  await publish(contributor, moderator, [{ op: 'merge', kind: 'series', from: loser, into: winner }]);
  await t.router.options.context.queryClient.refetchQueries({ queryKey: ['entity', loser] });

  await waitFor(() => expect(t.router.state.location.pathname).toBe(`/entities/${winner}/edit`));
  expect(await screen.findByLabelText(/^Description/)).toHaveValue('Two novels by Diana Wynne Jones.');
  // What the contributor never touched is the winner's.
  expect(screen.getByLabelText('Title')).toHaveValue("Howl's Castle");
  expect(stored(`edit.${loser}.${t.session.userId}`)).toBeNull();
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
  await waitFor(() => expect(stored(`edit.${id}.${t.session.userId}`)).not.toBeNull());
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
      await t.user.click(await screen.findByRole('button', { name: 'Remove Fantasy from tags' }));
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

test("a background refetch while the form is open sends only the contributor's edit", async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  await t.router.navigate({ to: '/entities/$id/edit', params: { id } });
  await t.user.type(await screen.findByLabelText(/^Original title/), 'Sen to Chihiro');

  // Someone else's changes are published while the form is open...
  const { contributor, moderator } = await actors(t.api);
  await publish(contributor, moderator, [{ op: 'update', kind: 'work', entityId: id, fields: { releaseYear: 2003 } }]);
  await publish(
    contributor,
    moderator,
    familyTag.map((c) => ('from' in c ? { ...c, from: { id } } : c)),
  );
  // ...and the entry is read again, as on returning to the tab.
  await t.router.options.context.queryClient.refetchQueries({ queryKey: ['entity', id] });
  const posts = watchSubmissions(t);

  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));
  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([
    { op: 'update', kind: 'work', entityId: id, fields: { originalTitle: 'Sen to Chihiro' } },
  ]);
  // The 201 clears the draft for good: nothing is written back after it.
  expect(await screen.findByText(/Your edit is waiting for review/)).toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(stored(`edit.${id}.${t.session.userId}`)).toBeNull();
});

test('a credit the contributor changed and someone else removed meanwhile is kept as new, and they are told', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  await t.router.navigate({ to: '/entities/$id/edit', params: { id } });
  await t.user.selectOptions(await screen.findByLabelText('Role for Hayao Miyazaki'), 'writer');

  const view = (await (await t.api.app.request(`/api/entities/${id}`)).json()) as {
    relations: { creators: { relationId: string }[] };
  };
  const { contributor, moderator } = await actors(t.api);
  await publish(contributor, moderator, [{ op: 'unrelate', relationId: view.relations.creators[0]?.relationId }]);
  await t.router.options.context.queryClient.refetchQueries({ queryKey: ['entity', id] });
  const posts = watchSubmissions(t);

  expect(await screen.findByText(/changed since you started editing.*check credits\./)).toBeInTheDocument();
  expect(screen.getByLabelText('Role for Hayao Miyazaki')).toHaveValue('writer');
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));
  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes.map((c) => c.op)).toEqual(['relate']);
});

test("a tag's kind is named as the form names it in the conflict notice", async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.tags.fantasy;
  await t.router.navigate({ to: '/entities/$id/edit', params: { id } });
  await t.user.selectOptions(await screen.findByLabelText('Tag kind'), 'Theme');

  const { contributor, moderator } = await actors(t.api);
  await publish(contributor, moderator, [
    { op: 'update', kind: 'tag', entityId: id, fields: { kind: 'content_warning' } },
  ]);
  await t.router.options.context.queryClient.refetchQueries({ queryKey: ['entity', id] });

  expect(await screen.findByText(/changed since you started editing.*check tag kind\./)).toBeInTheDocument();
});

test('a background refetch that changes a field the contributor edited says so', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  await t.router.navigate({ to: '/entities/$id/edit', params: { id } });
  const year = await screen.findByLabelText('Release year');
  await t.user.clear(year);
  await t.user.type(year, '2002');

  const { contributor, moderator } = await actors(t.api);
  await publish(contributor, moderator, [{ op: 'update', kind: 'work', entityId: id, fields: { releaseYear: 2003 } }]);
  await t.router.options.context.queryClient.refetchQueries({ queryKey: ['entity', id] });

  expect(await screen.findByText(/changed since you started editing.*release year/)).toBeInTheDocument();
  expect(screen.getByLabelText('Release year')).toHaveValue(2002);
});

test('removing a link someone else already removed says so, instead of "Try again"', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const id = t.seeded.works.spiritedAway;
  await t.router.navigate({ to: '/entities/$id/edit', params: { id } });
  await t.user.click(await screen.findByRole('button', { name: 'Remove Fantasy from tags' }));
  // Someone else removes the same tag; the form hasn't read the entry again.
  const view = (await (await t.api.app.request(`/api/entities/${id}`)).json()) as {
    relations: { tags: { relationId: string }[] };
  };
  const { contributor, moderator } = await actors(t.api);
  await publish(contributor, moderator, [{ op: 'unrelate', relationId: view.relations.tags[0]?.relationId }]);

  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('A link you removed is already gone. Reload the form.');
});

test('a pending series link counts as a waiting edit on the work, though it is recorded on the series', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  const me = t.api.as({ kind: 'user', userId: t.session.userId! });
  const made = await me.post('/api/submissions', {
    cc0: true,
    changes: [
      {
        op: 'relate',
        type: 'series_work',
        from: { id: t.seeded.series.howlsSeries },
        to: { id: t.seeded.works.spiritedAway },
        data: { position: 3 },
      },
    ],
  });
  expect(made.status).toBe(201);

  await t.router.navigate({ to: '/entities/$id', params: { id: t.seeded.works.spiritedAway } });

  expect(await screen.findByText(/Your edit is waiting for review/)).toBeInTheDocument();
});

const NAMES = 'Also known as';

test('edit adds a name and submits the array', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });
  const posts = watchSubmissions(t);

  const names = await screen.findByLabelText(NAMES);
  expect(names).toHaveAccessibleDescription('One name per line');
  await t.user.type(names, 'Sen to Chihiro no Kamikakushi');
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([
    {
      op: 'update',
      kind: 'work',
      entityId: t.seeded.works.spiritedAway,
      fields: { alternateTitles: ['Sen to Chihiro no Kamikakushi'] },
    },
  ]);
});

test('duplicate lines and the title are dropped before submit', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });
  const posts = watchSubmissions(t);

  const names = await screen.findByLabelText(NAMES);
  fireEvent.change(names, { target: { value: 'spirited away\n  Sen  \n\nsen\nChihiro\n' } });
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([
    {
      op: 'update',
      kind: 'work',
      entityId: t.seeded.works.spiritedAway,
      fields: { alternateTitles: ['Sen', 'Chihiro'] },
    },
  ]);
});

test('51 lines blocks submit', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });
  const posts = watchSubmissions(t);

  const names = await screen.findByLabelText(NAMES);
  fireEvent.change(names, { target: { value: Array.from({ length: 51 }, (_, i) => `Name ${i}`).join('\n') } });
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(names).toHaveAttribute('aria-invalid', 'true');
  expect(names).toHaveAccessibleDescription('One name per line At most 50 names');
  expect(await posts()).toHaveLength(0);

  fireEvent.change(names, { target: { value: Array.from({ length: 50 }, (_, i) => `Name ${i}`).join('\n') } });
  expect(names).not.toHaveAttribute('aria-invalid');
});

test('emptying the list sends an empty array, and leaving it alone sends nothing', async () => {
  const t = await renderApp('/', {
    as: 'contributor',
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const made = await publish(contributor, moderator, [
        {
          op: 'create',
          kind: 'creator',
          ref: 'c',
          fields: { name: 'Kafka', kind: 'person', alternateNames: ['Franz'] },
        },
      ]);
      return made.changes[0]?.entityId ?? '';
    },
  });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded } });
  const posts = watchSubmissions(t);

  const names = await screen.findByLabelText(NAMES);
  expect(names).toHaveValue('Franz');
  expect(screen.getByRole('button', { name: 'Submit for review' })).toBeDisabled();
  await t.user.clear(names);
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([
    { op: 'update', kind: 'creator', entityId: t.seeded, fields: { alternateNames: [] } },
  ]);
});

test('a live note lists the lines that will not be saved, and only then', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });

  const names = await screen.findByLabelText(NAMES);
  fireEvent.change(names, { target: { value: 'Sen\nChihiro' } });
  expect(screen.queryByText(/Not saved/)).not.toBeInTheDocument();
  expect(names).toHaveAccessibleDescription('One name per line');

  fireEvent.change(names, { target: { value: 'Sen\n  spirited away \nSEN\nChihiro' } });
  const note = 'Not saved, already listed: spirited away, SEN';
  expect(screen.getByText(note)).toBeInTheDocument();
  expect(names).toHaveAccessibleDescription(`One name per line ${note}`);
  // The textarea itself is left as typed.
  expect(names).toHaveValue('Sen\n  spirited away \nSEN\nChihiro');
});

test('the 50 limit counts the names that would be saved', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });
  const posts = watchSubmissions(t);

  const names = await screen.findByLabelText(NAMES);
  const lines = Array.from({ length: 49 }, (_, i) => `Name ${i}`);
  fireEvent.change(names, { target: { value: [...lines, 'name 0', 'Spirited Away'].join('\n') } });
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  const sent = (await posts())[0]?.changes[0] as { fields: { alternateTitles: string[] } };
  expect(sent.fields.alternateTitles).toEqual(lines);
});

test('editing only the description leaves a stored list alone, even one repeating the title', async () => {
  const t = await renderApp('/', {
    as: 'contributor',
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const made = await publish(contributor, moderator, [
        {
          op: 'create',
          kind: 'work',
          ref: 'w',
          fields: { mediaType: 'book', subtype: null, title: 'Alpha', alternateTitles: ['Beta', 'Gamma'] },
        },
      ]);
      const id = made.changes[0]?.entityId ?? '';
      // A title-only update doesn't set the list, so it can come to repeat the title.
      await publish(contributor, moderator, [{ op: 'update', kind: 'work', entityId: id, fields: { title: 'beta' } }]);
      return id;
    },
  });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded } });
  const posts = watchSubmissions(t);

  const description = await screen.findByLabelText(/^Description/);
  // The stored "Beta" now repeats the title, but nobody typed it, so it isn't reported as dropped.
  expect(screen.queryByText(/Not saved/)).not.toBeInTheDocument();
  await t.user.type(description, 'New words');
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([
    { op: 'update', kind: 'work', entityId: t.seeded, fields: { description: 'New words' } },
  ]);
});

test('an entry a merge left with over 50 names can still be edited, until its names are changed', async () => {
  const t = await renderApp('/', {
    as: 'contributor',
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const book = (title: string, alternateTitles: string[]) => ({
        op: 'create',
        kind: 'work',
        ref: title,
        fields: { mediaType: 'book', subtype: null, title, alternateTitles },
      });
      const made = await publish(contributor, moderator, [
        book(
          'Alpha',
          Array.from({ length: 50 }, (_, i) => `Alpha ${i}`),
        ),
        book(
          'Beta',
          Array.from({ length: 9 }, (_, i) => `Beta ${i}`),
        ),
      ]);
      const [alpha, beta] = made.changes.map((c) => c.entityId ?? '');
      // A merge keeps every name: Alpha ends with 60.
      await publish(contributor, moderator, [{ op: 'merge', kind: 'work', from: beta, into: alpha }]);
      return alpha ?? '';
    },
  });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded } });
  const posts = watchSubmissions(t);

  const names = await screen.findByLabelText(NAMES);
  expect(String((names as HTMLTextAreaElement).value).split('\n')).toHaveLength(60);
  await t.user.type(screen.getByLabelText(/^Description/), 'New words');
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([
    { op: 'update', kind: 'work', entityId: t.seeded, fields: { description: 'New words' } },
  ]);
});

test('changing a list a merge left over 50 names asks for 50 at most', async () => {
  const t = await renderApp('/', {
    as: 'contributor',
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const book = (title: string, alternateTitles: string[]) => ({
        op: 'create',
        kind: 'work',
        ref: title,
        fields: { mediaType: 'book', subtype: null, title, alternateTitles },
      });
      const made = await publish(contributor, moderator, [
        book(
          'Alpha',
          Array.from({ length: 50 }, (_, i) => `Alpha ${i}`),
        ),
        book(
          'Beta',
          Array.from({ length: 9 }, (_, i) => `Beta ${i}`),
        ),
      ]);
      const [alpha, beta] = made.changes.map((c) => c.entityId ?? '');
      await publish(contributor, moderator, [{ op: 'merge', kind: 'work', from: beta, into: alpha }]);
      return alpha ?? '';
    },
  });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded } });
  const posts = watchSubmissions(t);

  const names = await screen.findByLabelText(NAMES);
  fireEvent.change(names, { target: { value: `${(names as HTMLTextAreaElement).value}\nOne more` } });
  await t.user.click(screen.getByLabelText(CC0));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(names).toHaveAttribute('aria-invalid', 'true');
  expect(names).toHaveAccessibleDescription('One name per line At most 50 names');
  expect(await posts()).toHaveLength(0);
});
