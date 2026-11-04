import { screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { actors, publish, renderApp, seed, type SignedInAs, type TestApi } from './harness';

type Created = { id: string; changes: { id: string; entityId: string | null }[] };

const work = (ref: string, title: string, extra: Record<string, unknown> = {}) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType: 'film_tv', subtype: 'movie', title, releaseYear: 2016, ...extra },
});

/** Submits as `author` and leaves the changes pending. */
async function submit(author: ReturnType<TestApi['as']>, changes: unknown[]): Promise<Created> {
  const res = await author.post('/api/submissions', { cc0: true, changes });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as Created;
}

/** Makes a submission look `days` old. The queue's order and ages come from these timestamps. */
async function backdate(api: TestApi, submissionId: string, days: number) {
  // The API's db is typed for both drivers; PGlite, which tests use, exposes its client as `$client`.
  const client = (api.db as unknown as { $client: { query: (sql: string, params: unknown[]) => Promise<unknown> } })
    .$client;
  for (const table of ['changes', 'submissions']) {
    const column = table === 'changes' ? 'submission_id' : 'id';
    await client.query(`update ${table} set created_at = now() - make_interval(days => $1) where ${column} = $2`, [
      days,
      submissionId,
    ]);
  }
}

async function open(as: SignedInAs, seedFn?: (api: TestApi) => Promise<unknown>) {
  const t = await renderApp('/moderation', { as, ...(seedFn ? { seed: seedFn } : {}) });
  return t;
}

const queueItems = async () => {
  const list = await screen.findByRole('list', { name: 'Review queue' });
  return Array.from(list.children) as HTMLElement[];
};

test.each(['anonymous', 'contributor'] as const)('%s users get Not found and no Moderation link', async (as) => {
  await open(as);
  expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Moderation' })).not.toBeInTheDocument();
});

test('moderators see a Moderation link that opens the queue', async () => {
  const { user } = await renderApp('/', { as: 'moderator' });
  await user.click(await screen.findByRole('link', { name: 'Moderation' }));
  expect(await screen.findByRole('heading', { name: 'Moderation queue' })).toBeInTheDocument();
});

test('an empty queue says so', async () => {
  await open('moderator');
  expect(await screen.findByText('Nothing is waiting for review.')).toBeInTheDocument();
});

test('the queue is oldest first with each age and author', async () => {
  await open('moderator', async (api) => {
    const anon = api.as({ kind: 'anon', token: 'a'.repeat(32) });
    const plain = api.as({ kind: 'user', userId: await api.createUser() });
    const handled = api.as({ kind: 'user', userId: await api.createUser() });
    expect((await handled.patch('/api/me', { handle: 'ghibli_fan' })).status).toBe(200);
    const newest = await submit(handled, [work('c', 'Third')]);
    const middle = await submit(plain, [work('b', 'Second')]);
    const oldest = await submit(anon, [work('a', 'First')]);
    await backdate(api, middle.id, 1);
    await backdate(api, oldest.id, 3);
    return newest;
  });
  const items = await queueItems();

  expect(items).toHaveLength(3);
  expect(items[0]).toHaveTextContent('First');
  expect(items[0]).toHaveTextContent('3 days');
  expect(items[0]).toHaveTextContent('anonymous');
  expect(items[1]).toHaveTextContent('Second');
  expect(items[1]).toHaveTextContent('1 day');
  expect(items[1]).toHaveTextContent('contributor');
  expect(items[2]).toHaveTextContent('Third');
  expect(items[2]).toHaveTextContent('ghibli_fan');
});

test('an update shows a before and after against the entry as it is now', async () => {
  await open('moderator', async (api) => {
    const { contributor, moderator } = await actors(api);
    const live = await publish(contributor, moderator, [work('w', 'Arrival')]);
    await submit(contributor, [
      { op: 'update', kind: 'work', entityId: live.changes[0]?.entityId, fields: { releaseYear: 2017 } },
    ]);
  });
  const [item] = await queueItems();

  // The title of the entry being edited loads after the queue does.
  await waitFor(() => expect(item).toHaveTextContent('Edit to Arrival'));
  const row = within(item as HTMLElement)
    .getByText('Release year')
    .closest('tr') as HTMLElement;
  expect(within(row).getByText('2016')).toBeInTheDocument();
  expect(within(row).getByText('2017')).toBeInTheDocument();
});

test('a create shows its fields', async () => {
  await open('moderator', async (api) => {
    const { contributor } = await actors(api);
    await submit(contributor, [work('w', 'Arrival', { description: 'A linguist meets aliens.' })]);
  });
  const [item] = await queueItems();

  expect(item).toHaveTextContent('New work');
  expect(item).toHaveTextContent('Title');
  expect(item).toHaveTextContent('Arrival');
  expect(item).toHaveTextContent('A linguist meets aliens.');
});

test('a link shows both ends by title, for live entries and for ones still pending', async () => {
  await open('moderator', async (api) => {
    const { contributor, moderator } = await actors(api);
    const live = await publish(contributor, moderator, [
      work('w', 'Arrival'),
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Denis Villeneuve', kind: 'person' } },
    ]);
    const [w, c] = live.changes;
    await submit(contributor, [
      {
        op: 'relate',
        type: 'work_creator',
        from: { id: w?.entityId },
        to: { id: c?.entityId },
        data: { role: 'director' },
      },
      { op: 'create', kind: 'creator', ref: 'n', fields: { name: 'Jóhann Jóhannsson', kind: 'person' } },
      { op: 'relate', type: 'work_creator', from: { id: w?.entityId }, to: { ref: 'n' }, data: { role: 'composer' } },
    ]);
  });
  const items = await queueItems();

  expect(items).toHaveLength(3);
  // Titles of entries not in the queue are fetched, so they arrive after the list does.
  await waitFor(() => expect(items[0]).toHaveTextContent('Arrival → Denis Villeneuve'));
  expect(items[0]).toHaveTextContent('Director');
  await waitFor(() => expect(items[2]).toHaveTextContent('Arrival → Jóhann Jóhannsson'));
  expect(items[2]).toHaveTextContent('Composer');
});

test('approving removes the item and publishes the change', async () => {
  const { user, api, seeded } = await renderApp('/moderation', {
    as: 'moderator',
    seed: async (a) => submit((await actors(a)).contributor, [work('w', 'Arrival')]),
  });
  const [item] = await queueItems();

  await user.click(within(item as HTMLElement).getByRole('button', { name: 'Approve' }));

  expect(await screen.findByText('Nothing is waiting for review.')).toBeInTheDocument();
  const res = await api.as({ kind: 'none' }).get(`/api/entities/${seeded.changes[0]?.entityId}`);
  expect(res.status).toBe(200);
});

test('rejecting needs a reason, and returns the work to its author with that reason', async () => {
  const { user, api, seeded } = await renderApp('/moderation', {
    as: 'moderator',
    seed: async (a) => {
      const authorId = await a.createUser();
      return { authorId, created: await submit(a.as({ kind: 'user', userId: authorId }), [work('w', 'Arrival')]) };
    },
  });
  const [item] = await queueItems();

  await user.click(within(item as HTMLElement).getByRole('button', { name: 'Reject' }));
  const dialog = await screen.findByRole('dialog', { name: 'Reject this change' });
  await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
  expect(within(dialog).getByRole('alert')).toHaveTextContent('Give a reason');
  const before = await api.as({ kind: 'user', userId: seeded.authorId }).get(`/api/submissions/${seeded.created.id}`);
  expect(await before.json()).toMatchObject({ changes: [{ status: 'pending' }] });

  await user.type(within(dialog).getByLabelText('Reason'), 'Not notable yet');
  await user.click(within(dialog).getByRole('button', { name: 'Reject' }));

  expect(await screen.findByText('Nothing is waiting for review.')).toBeInTheDocument();
  const detail = await api.as({ kind: 'user', userId: seeded.authorId }).get(`/api/submissions/${seeded.created.id}`);
  expect(await detail.json()).toMatchObject({ changes: [{ status: 'rejected', reason: 'Not notable yet' }] });
});

test('edit and approve changes one field and publishes the corrected entry', async () => {
  const { user, api, seeded } = await renderApp('/moderation', {
    as: 'moderator',
    seed: async (a) => submit((await actors(a)).contributor, [work('w', 'Arival', { description: 'Aliens.' })]),
  });
  const [item] = await queueItems();

  await user.click(within(item as HTMLElement).getByRole('button', { name: 'Edit and approve' }));
  const dialog = await screen.findByRole('dialog', { name: 'Edit and approve' });
  const title = within(dialog).getByLabelText('Title');
  await user.clear(title);
  await user.type(title, 'Arrival');
  await user.click(within(dialog).getByRole('button', { name: 'Approve with changes' }));

  expect(await screen.findByText('Nothing is waiting for review.')).toBeInTheDocument();
  const res = await api.as({ kind: 'none' }).get(`/api/entities/${seeded.changes[0]?.entityId}`);
  expect(await res.json()).toMatchObject({ fields: { title: 'Arrival', description: 'Aliens.' } });
});

test('approving a link before the entry it needs says which to approve first, and links to it', async () => {
  const { user } = await renderApp('/moderation', {
    as: 'moderator',
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const live = await publish(contributor, moderator, [
        { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Denis Villeneuve', kind: 'person' } },
      ]);
      await submit(contributor, [
        work('w', 'Arrival'),
        {
          op: 'relate',
          type: 'work_creator',
          from: { ref: 'w' },
          to: { id: live.changes[0]?.entityId },
          data: { role: 'director' },
        },
      ]);
    },
  });
  const [create, link] = await queueItems();

  await user.click(within(link as HTMLElement).getByRole('button', { name: 'Approve' }));

  const alert = await within(link as HTMLElement).findByRole('alert');
  expect(alert).toHaveTextContent('Approve Arrival first');
  const target = within(alert).getByRole('link', { name: 'Arrival' });
  expect(target).toHaveAttribute('href', `#${(create as HTMLElement).id}`);
  expect(create?.id).toMatch(/^change-/);
});

test('approving an edit made stale by another says what changed and shows the current value', async () => {
  const { user } = await renderApp('/moderation', {
    as: 'moderator',
    seed: async (api) => {
      const { contributor, moderator } = await actors(api);
      const live = await publish(contributor, moderator, [work('w', 'Arrival')]);
      const entityId = live.changes[0]?.entityId;
      await submit(contributor, [{ op: 'update', kind: 'work', entityId, fields: { releaseYear: 2017 } }]);
      await publish(contributor, moderator, [{ op: 'update', kind: 'work', entityId, fields: { releaseYear: 2018 } }]);
    },
  });
  const [item] = await queueItems();

  await user.click(within(item as HTMLElement).getByRole('button', { name: 'Approve' }));

  const alert = await within(item as HTMLElement).findByRole('alert');
  expect(alert).toHaveTextContent('This field changed since the edit was made');
  expect(alert).toHaveTextContent('Release year');
  expect(alert).toHaveTextContent('Now: 2018');
  expect(await queueItems()).toHaveLength(1);
});

test('the queue pages with Load more', async () => {
  const { user } = await renderApp('/moderation', {
    as: 'moderator',
    seed: async (api) => {
      const { contributor } = await actors(api);
      await submit(
        contributor,
        Array.from({ length: 21 }, (_, i) => work(`w${i}`, `Work ${String(i).padStart(2, '0')}`)),
      );
    },
  });
  expect(await queueItems()).toHaveLength(20);

  await user.click(screen.getByRole('button', { name: 'Load more' }));

  await waitFor(async () => expect(await queueItems()).toHaveLength(21));
});

test('a failed first load says so and can be retried', async () => {
  const { api, user } = await renderApp('/', { as: 'moderator' });
  // Network fault: the queue request never gets an answer.
  const real = api.app.request.bind(api.app);
  const spy = vi.spyOn(api.app, 'request').mockImplementation(async (...args: Parameters<typeof real>) => {
    const [input] = args;
    if (String(input instanceof Request ? input.url : input).includes('/api/moderation/queue')) {
      throw new TypeError('offline');
    }
    return real(...args);
  });
  await user.click(await screen.findByRole('link', { name: 'Moderation' }));
  expect(await screen.findByText(/Couldn't load the review queue/)).toBeInTheDocument();
  spy.mockRestore();

  await user.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByText('Nothing is waiting for review.')).toBeInTheDocument();
});

test('an unrelate then a relate of the same pair (a changed role) approve in queue order', async () => {
  const { api, session } = await renderApp('/', {
    as: 'moderator',
    seed: async (a) => {
      const { contributor } = await actors(a);
      const catalog = await seed(a);
      const entity = await a.as({ kind: 'none' }).get(`/api/entities/${catalog.works.spiritedAway}`);
      const body = (await entity.json()) as { relations: { creators: { relationId: string; role: string }[] } };
      const credit = body.relations.creators.find((c) => c.role === 'director');
      await submit(contributor, [
        { op: 'unrelate', relationId: credit?.relationId },
        {
          op: 'relate',
          type: 'work_creator',
          from: { id: catalog.works.spiritedAway },
          to: { id: catalog.creators.miyazaki },
          data: { role: 'producer' },
        },
      ]);
      return catalog;
    },
  });
  const mod = api.as({ kind: 'user', userId: session.userId ?? '' });
  const queue = (await (await mod.get('/api/moderation/queue')).json()) as {
    items: { change: { id: string; op: string } }[];
  };
  expect(queue.items.map((i) => i.change.op)).toEqual(['unrelate', 'relate']);

  for (const { change } of queue.items) {
    const res = await mod.post(`/api/changes/${change.id}/approve`);
    expect(res.status, await res.clone().text()).toBe(200);
  }
});

test('a review dialog traps focus in itself and gives it back to its button when closed', async () => {
  const { user } = await renderApp('/moderation', {
    as: 'moderator',
    seed: async (a) => submit((await actors(a)).contributor, [work('w', 'Arrival')]),
  });
  const [item] = await queueItems();
  const opener = within(item as HTMLElement).getByRole('button', { name: 'Reject' });

  await user.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'Reject this change' });
  await user.tab();
  await user.tab();
  await user.tab();
  await user.tab();
  expect(dialog).toContainElement(document.activeElement as HTMLElement);

  await user.keyboard('{Escape}');

  await waitFor(() => expect(opener).toHaveFocus());
});

test('an unrelate shows which credit goes, so a changed role reads as old then new', async () => {
  await open('moderator', async (a) => {
    const { contributor } = await actors(a);
    const catalog = await seed(a);
    const entity = await a.as({ kind: 'none' }).get(`/api/entities/${catalog.works.spiritedAway}`);
    const body = (await entity.json()) as { relations: { creators: { relationId: string; role: string }[] } };
    const credit = body.relations.creators.find((c) => c.role === 'director');
    await submit(contributor, [
      { op: 'unrelate', relationId: credit?.relationId },
      {
        op: 'relate',
        type: 'work_creator',
        from: { id: catalog.works.spiritedAway },
        to: { id: catalog.creators.miyazaki },
        data: { role: 'producer' },
      },
    ]);
  });
  const [removed, added] = await queueItems();

  await waitFor(() => expect(removed).toHaveTextContent('Credit: Hayao Miyazaki (Director)'));
  await waitFor(() => expect(added).toHaveTextContent('Spirited Away → Hayao Miyazaki'));
  expect(added).toHaveTextContent('Producer');
});

test('an edit with a number field cleared is invalid, not zero', async () => {
  const { user } = await renderApp('/moderation', {
    as: 'moderator',
    seed: async (a) => submit((await actors(a)).contributor, [work('w', 'Arrival')]),
  });
  const [item] = await queueItems();

  await user.click(within(item as HTMLElement).getByRole('button', { name: 'Edit and approve' }));
  const dialog = await screen.findByRole('dialog', { name: 'Edit and approve' });
  await user.clear(within(dialog).getByLabelText('Release year'));

  expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a number for Release year');
  expect(within(dialog).getByRole('button', { name: 'Approve with changes' })).toBeDisabled();
});

test('after a review, focus moves to the next item, or the heading when none is left', async () => {
  const { user } = await renderApp('/moderation', {
    as: 'moderator',
    seed: async (a) => submit((await actors(a)).contributor, [work('a', 'First'), work('b', 'Second')]),
  });
  const [first] = await queueItems();

  await user.click(within(first as HTMLElement).getByRole('button', { name: 'Approve' }));
  const [second] = await waitFor(async () => {
    const items = await queueItems();
    expect(items).toHaveLength(1);
    return items;
  });
  await waitFor(() => expect(second).toHaveFocus());

  await user.click(within(second as HTMLElement).getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Moderation queue' })).toHaveFocus());
});

test('a failed account lookup shows an error with retry, not Not found', async () => {
  const { api, router, user } = await renderApp('/', { as: 'moderator' });
  const real = api.app.request.bind(api.app);
  // Network fault: /api/me never gets an answer while the page loads.
  const spy = vi.spyOn(api.app, 'request').mockImplementation(async (...args: Parameters<typeof real>) => {
    const [input] = args;
    if (String(input instanceof Request ? input.url : input).includes('/api/me')) throw new TypeError('offline');
    return real(...args);
  });
  // Forget the account the shell loaded, so the page has to ask again.
  router.options.context.queryClient.removeQueries({ queryKey: ['me'] });
  await router.navigate({ to: '/moderation' });
  expect(await screen.findByText(/Couldn't load your account/)).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Not found' })).not.toBeInTheDocument();
  spy.mockRestore();

  await user.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByRole('heading', { name: 'Moderation queue' })).toBeInTheDocument();
});

test('an unrelate whose entry cannot be loaded says so and can retry', async () => {
  const { api, router, user } = await renderApp('/', {
    as: 'moderator',
    seed: async (a) => {
      const { contributor } = await actors(a);
      const catalog = await seed(a);
      const entity = await a.as({ kind: 'none' }).get(`/api/entities/${catalog.works.spiritedAway}`);
      const body = (await entity.json()) as { relations: { creators: { relationId: string; role: string }[] } };
      const credit = body.relations.creators.find((c) => c.role === 'director');
      await submit(contributor, [{ op: 'unrelate', relationId: credit?.relationId }]);
    },
  });
  const real = api.app.request.bind(api.app);
  // Network fault: entry requests never get an answer.
  const spy = vi.spyOn(api.app, 'request').mockImplementation(async (...args: Parameters<typeof real>) => {
    const [input] = args;
    if (String(input instanceof Request ? input.url : input).includes('/api/entities/')) {
      throw new TypeError('offline');
    }
    return real(...args);
  });
  await router.navigate({ to: '/moderation' });
  const [item] = await queueItems();

  expect(await within(item as HTMLElement).findByText(/Couldn't load which link this removes/)).toBeInTheDocument();
  spy.mockRestore();
  await user.click(within(item as HTMLElement).getByRole('button', { name: 'Try again' }));

  await waitFor(() => expect(item).toHaveTextContent('Credit: Hayao Miyazaki (Director)'));
});
