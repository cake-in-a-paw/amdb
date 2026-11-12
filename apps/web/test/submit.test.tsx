import { screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { buildSubmission, emptyForm, type EntryForm } from '@/lib/submission';
import { partOf, publishTree, renderApp, seed, tvWork, watchSubmissionBodies, type TestApi } from './harness';

type App = Awaited<ReturnType<typeof renderApp<Awaited<ReturnType<typeof seed>>>>>;

const urlOf = (input: Request | string | URL) => (input instanceof Request ? input.url : String(input));

/** Watches the in-process API; the returned function lists the submission POSTs so far. */
function watchSubmissions(t: { api: TestApi }) {
  const spy = vi.spyOn(t.api.app, 'request');
  return () =>
    spy.mock.calls.filter(
      ([input, init]) =>
        urlOf(input).endsWith('/api/submissions') &&
        (input instanceof Request ? input.method : (init?.method ?? 'GET')) === 'POST',
    );
}

/** Picks the first search result named `name` from the picker labeled `label`. */
async function pick(t: App, label: string, query: string, name: string) {
  await t.user.type(screen.getByLabelText(label), query);
  await t.user.click(await screen.findByRole('button', { name: new RegExp(`^${name}`) }));
}

test('a contributor submits a book with a new author, a tag, a series position and an ISBN', async () => {
  const t = await renderApp('/submit', { as: 'contributor', seed });
  const posts = watchSubmissions(t);

  await t.user.selectOptions(screen.getByLabelText('Media type'), 'Book');
  await t.user.type(screen.getByLabelText('Title'), 'A Wizard of Earthsea');
  await t.user.type(screen.getByLabelText('Release year'), '1968');

  // A new author, made inline from the creator picker.
  await t.user.type(screen.getByLabelText('Find a creator'), 'Ursula K. Le Guin');
  await t.user.click(await screen.findByRole('button', { name: 'Add new creator “Ursula K. Le Guin”…' }));
  const newCreator = screen.getByRole('group', { name: 'New creator' });
  expect(within(newCreator).getByLabelText('Name')).toHaveValue('Ursula K. Le Guin');
  await t.user.click(within(newCreator).getByRole('button', { name: 'Add creator' }));
  expect(screen.getByLabelText('Role for Ursula K. Le Guin')).toHaveValue('author');

  await pick(t, 'Find a tag', 'fant', 'Fantasy');
  await pick(t, 'Find a series', 'howl', "Howl's Castle");
  await t.user.type(screen.getByLabelText("Position in Howl's Castle"), '2');

  await t.user.click(screen.getByRole('button', { name: 'Add an external ID' }));
  await t.user.selectOptions(screen.getByLabelText('Type of ID 1'), 'ISBN-13');
  await t.user.type(screen.getByLabelText('ID 1'), '9780547773742');

  const submit = screen.getByRole('button', { name: 'Submit for review' });
  expect(submit).toBeDisabled();
  await t.user.click(screen.getByLabelText('I release this contribution into the public domain (CC0)'));
  expect(submit).toBeEnabled();
  await t.user.click(submit);

  const result = await screen.findByRole('list', { name: 'Your changes' });
  const rows = within(result).getAllByRole('listitem');
  expect(rows.map((row) => row.textContent)).toEqual([
    'New work: A Wizard of EarthseaWaiting for review',
    'New creator: Ursula K. Le GuinWaiting for review',
    'Credit: Ursula K. Le Guin, AuthorWaiting for review',
    "In the series Howl's Castle, no. 2Waiting for review",
    'Tag: FantasyWaiting for review',
    'ISBN-13: 9780547773742Waiting for review',
  ]);
  expect(posts()).toHaveLength(1);

  // What the API stored: relates hold resolved ids, so the refs joined up.
  const me = t.api.as({ kind: 'user', userId: t.session.userId ?? '' });
  const mine = (await (await me.get('/api/me/submissions')).json()) as { items: { id: string }[] };
  expect(mine.items).toHaveLength(1);
  const stored = (await (await me.get(`/api/submissions/${mine.items[0]?.id}`)).json()) as {
    changes: { op: string; kind: string; entityId: string | null; status: string; payload: unknown }[];
  };
  const [book, author] = stored.changes;
  expect(stored.changes.map((c) => [c.op, c.kind, c.status])).toEqual([
    ['create', 'work', 'pending'],
    ['create', 'creator', 'pending'],
    ['relate', 'work', 'pending'],
    ['relate', 'series', 'pending'],
    ['relate', 'work', 'pending'],
    ['relate', 'work', 'pending'],
  ]);
  expect(book?.payload).toEqual({
    mediaType: 'book',
    subtype: null,
    title: 'A Wizard of Earthsea',
    releaseYear: 1968,
    lifecycle: 'unknown',
  });
  expect(author?.payload).toEqual({ name: 'Ursula K. Le Guin', kind: 'person' });
  expect(stored.changes.slice(2).map((c) => c.payload)).toEqual([
    { type: 'work_creator', from: book?.entityId, to: author?.entityId, data: { role: 'author' } },
    { type: 'series_work', from: t.seeded.series.howlsSeries, to: book?.entityId, data: { position: 2 } },
    { type: 'work_tag', from: book?.entityId, to: t.seeded.tags.fantasy, data: {} },
    { type: 'external_id', from: book?.entityId, to: null, data: { scheme: 'isbn13', value: '9780547773742' } },
  ]);
});

test('client validation uses the shared schema: a day without a month is a field error, and nothing is sent', async () => {
  const t = await renderApp('/submit', { as: 'contributor' });
  const posts = watchSubmissions(t);

  await t.user.selectOptions(screen.getByLabelText('Media type'), 'film_tv');
  await t.user.selectOptions(screen.getByLabelText('Type'), 'Movie');
  await t.user.type(screen.getByLabelText('Title'), 'Arrival');
  await t.user.type(screen.getByLabelText('Release year'), '2016');
  await t.user.type(screen.getByLabelText('Release day'), '11');
  await t.user.click(screen.getByLabelText('I release this contribution into the public domain (CC0)'));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  const day = screen.getByLabelText('Release day');
  expect(day).toHaveAttribute('aria-invalid', 'true');
  expect(day).toHaveAccessibleDescription('Add a month to go with the day.');
  expect(day).toHaveFocus();
  expect(posts()).toHaveLength(0);

  // Fixing it clears the error as you go.
  await t.user.selectOptions(screen.getByLabelText('Release month'), 'November');
  expect(day).not.toHaveAttribute('aria-invalid');
  expect(day).not.toHaveAccessibleDescription();
});

test('the fields follow the kind: a tag has a kind, a name and a slug', async () => {
  const t = await renderApp('/submit', { as: 'contributor' });

  await t.user.click(screen.getByRole('radio', { name: 'Tag' }));

  expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Media type')).not.toBeInTheDocument();
  await t.user.selectOptions(screen.getByLabelText('Tag kind'), 'Theme');
  await t.user.type(screen.getByLabelText('Name'), 'Found family');
  await t.user.type(screen.getByLabelText('Slug'), 'Found Family');
  await t.user.click(screen.getByLabelText('I release this contribution into the public domain (CC0)'));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(screen.getByLabelText('Slug')).toHaveAccessibleDescription('Use lowercase letters, digits and hyphens.');
  await t.user.clear(screen.getByLabelText('Slug'));
  await t.user.type(screen.getByLabelText('Slug'), 'found-family');
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));
  expect(await screen.findByText('New tag: Found family')).toBeInTheDocument();
});

test('a credit role that no longer fits the media type is changed, and the contributor is told', async () => {
  const t = await renderApp('/submit', { as: 'contributor', seed });
  await t.user.selectOptions(screen.getByLabelText('Media type'), 'film_tv');
  await pick(t, 'Find a creator', 'miyazaki', 'Hayao Miyazaki');
  expect(screen.getByLabelText('Role for Hayao Miyazaki')).toHaveValue('director');
  // The region is there before anything is said in it, so the message is announced.
  const status = within(screen.getByRole('group', { name: 'Credits' })).getByRole('status');
  expect(status).toBeEmptyDOMElement();

  await t.user.selectOptions(screen.getByLabelText('Media type'), 'Book');

  expect(screen.getByLabelText('Role for Hayao Miyazaki')).toHaveValue('author');
  expect(status).toHaveTextContent('Director isn’t a role for a book, so Hayao Miyazaki is now Author. Check it.');
});

test('switching between a creator and a tag does not carry the kind across', async () => {
  const t = await renderApp('/submit', { as: 'contributor' });

  await t.user.click(screen.getByRole('radio', { name: 'Creator' }));
  await t.user.selectOptions(screen.getByLabelText('Person or organization'), 'Person');
  await t.user.click(screen.getByRole('radio', { name: 'Tag' }));
  await t.user.type(screen.getByLabelText('Name'), 'Found family');
  await t.user.type(screen.getByLabelText('Slug'), 'found-family');
  await t.user.click(screen.getByLabelText('I release this contribution into the public domain (CC0)'));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  // The creator's "person" is no tag kind: "Choose…" shows, and the form asks for one before sending.
  expect(screen.getByLabelText('Tag kind')).toHaveValue('');
  expect(screen.getByLabelText('Tag kind')).toHaveAccessibleDescription('Choose a kind.');
  await t.user.selectOptions(screen.getByLabelText('Tag kind'), 'Theme');
  await t.user.click(screen.getByRole('radio', { name: 'Creator' }));
  expect(screen.getByLabelText('Person or organization')).toHaveValue('');
});

test('a duplicate ISBN is explained, with a link to the entry that has it', async () => {
  const t = await renderApp('/submit', { as: 'contributor', seed });
  const contributor = t.api.as({ kind: 'user', userId: t.session.userId ?? '' });
  const moderator = t.api.as({ kind: 'user', userId: await t.api.createUser({ role: 'moderator' }) });
  const tagged = await contributor.post('/api/submissions', {
    cc0: true,
    changes: [
      {
        op: 'relate',
        type: 'external_id',
        from: { id: t.seeded.works.howlsNovel },
        data: { scheme: 'isbn13', value: '9780061478789' },
      },
    ],
  });
  const created = (await tagged.json()) as { changes: { id: string }[] };
  expect((await moderator.post(`/api/changes/${created.changes[0]?.id}/approve`)).status).toBe(200);

  await t.user.selectOptions(screen.getByLabelText('Media type'), 'Book');
  await t.user.type(screen.getByLabelText('Title'), "Howl's Moving Castle (reissue)");
  await t.user.click(screen.getByRole('button', { name: 'Add an external ID' }));
  await t.user.selectOptions(screen.getByLabelText('Type of ID 1'), 'ISBN-13');
  await t.user.type(screen.getByLabelText('ID 1'), '9780061478789');
  await t.user.click(screen.getByLabelText('I release this contribution into the public domain (CC0)'));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('That ID is already recorded on another entry.');
  expect(within(alert).getByRole('link', { name: 'See that entry' })).toHaveAttribute(
    'href',
    `/entities/${t.seeded.works.howlsNovel}`,
  );
  expect(screen.getByLabelText('Title')).toHaveValue("Howl's Moving Castle (reissue)");
});

test('search\'s "Add it" starts a new entry with that title', async () => {
  const t = await renderApp('/search?q=Zzyzx', { as: 'contributor' });

  await t.user.click(await screen.findByRole('link', { name: 'Add it' }));

  await waitFor(() => expect(t.router.state.location.pathname).toBe('/submit'));
  expect(await screen.findByLabelText('Title')).toHaveValue('Zzyzx');
});

test('buildSubmission puts every create before the relates that name it by ref', () => {
  const form: EntryForm = {
    ...emptyForm(),
    fields: { mediaType: 'film_tv', subtype: 'movie', title: ' Arrival ', releaseYear: '2016', runtimeMin: '116' },
    credits: [
      {
        entity: {
          ref: 'new-1',
          title: 'Denis Villeneuve',
          kind: 'creator',
          fields: { name: 'Denis Villeneuve', kind: 'person' },
        },
        role: 'director',
      },
      {
        entity: {
          ref: 'new-1',
          title: 'Denis Villeneuve',
          kind: 'creator',
          fields: { name: 'Denis Villeneuve', kind: 'person' },
        },
        role: 'writer',
      },
    ],
    properties: [
      {
        entity: {
          ref: 'new-2',
          title: 'Story of Your Life',
          kind: 'property',
          fields: { title: 'Story of Your Life' },
        },
      },
    ],
    links: [
      { entity: { id: '00000000-0000-4000-8000-000000000001', title: 'Story of Your Life' }, linkType: 'adapted_from' },
    ],
    note: '  From the credits. ',
  };

  expect(buildSubmission(form)).toEqual({
    cc0: true,
    note: 'From the credits.',
    changes: [
      {
        op: 'create',
        kind: 'work',
        ref: 'entry',
        fields: {
          mediaType: 'film_tv',
          subtype: 'movie',
          title: 'Arrival',
          releaseYear: 2016,
          attributes: { runtimeMin: 116 },
        },
      },
      { op: 'create', kind: 'creator', ref: 'new-1', fields: { name: 'Denis Villeneuve', kind: 'person' } },
      { op: 'create', kind: 'property', ref: 'new-2', fields: { title: 'Story of Your Life' } },
      { op: 'relate', type: 'work_creator', from: { ref: 'entry' }, to: { ref: 'new-1' }, data: { role: 'director' } },
      { op: 'relate', type: 'work_creator', from: { ref: 'entry' }, to: { ref: 'new-1' }, data: { role: 'writer' } },
      { op: 'relate', type: 'property_work', from: { ref: 'new-2' }, to: { ref: 'entry' }, data: {} },
      {
        op: 'relate',
        type: 'work_link',
        from: { ref: 'entry' },
        to: { id: '00000000-0000-4000-8000-000000000001' },
        data: { linkType: 'adapted_from' },
      },
    ],
  });
});

test("a failed account lookup doesn't open the signed-out draft; Try again opens the account's own", async () => {
  const t = await renderApp('/', { as: 'contributor' });
  const someoneElses: EntryForm = { ...emptyForm(), fields: { ...emptyForm().fields, title: 'Someone else’s draft' } };
  localStorage.setItem('amdb.draft.submit.anonymous', JSON.stringify(someoneElses));
  const request = t.api.app.request.bind(t.api.app);
  let failing = true;
  vi.spyOn(t.api.app, 'request').mockImplementation(async (input, init) =>
    failing && new URL(urlOf(input), 'http://amdb.test').pathname === '/api/me'
      ? Promise.reject(new TypeError('offline'))
      : request(input, init),
  );
  t.router.options.context.queryClient.removeQueries({ queryKey: ['me'] });

  await t.router.navigate({ to: '/submit' });

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your account");
  expect(screen.queryByDisplayValue('Someone else’s draft')).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('amdb.draft.submit.anonymous')!)).toEqual(someoneElses);
  failing = false;
  await t.user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});

/** Breaking Bad, its Season 1, and the season's first episode, "Pilot". */
const tree = (api: TestApi) =>
  publishTree(api, [
    tvWork('show', 'series', 'Breaking Bad'),
    tvWork('s1', 'season', 'Breaking Bad Season 1'),
    tvWork('pilot', 'episode', 'Pilot'),
    partOf('show', 's1', 1),
    partOf('s1', 'pilot', 1),
  ]);

/** Starts a new episode titled `title` and picks Season 1 as what it is a part of. */
async function episodeUnderSeason(t: Awaited<ReturnType<typeof renderApp>>, title: string) {
  await t.user.selectOptions(screen.getByLabelText('Media type'), 'film_tv');
  await t.user.selectOptions(screen.getByLabelText('Type'), 'Movie');
  // A movie is never a part of anything.
  expect(screen.queryByRole('group', { name: 'Part of' })).not.toBeInTheDocument();
  await t.user.selectOptions(screen.getByLabelText('Type'), 'Episode');
  await t.user.type(screen.getByLabelText('Title'), title);
  // Seasons are left out of search unless the picker asks for parts, and are named by their place.
  await t.user.type(screen.getByLabelText('Find the show or season'), 'Breaking Bad Season');
  await t.user.click(await screen.findByRole('button', { name: /^Breaking Bad · Season 1/ }));
  expect(screen.queryByLabelText('Find the show or season')).not.toBeInTheDocument();
}

test('submit an episode under a season', async () => {
  const t = await renderApp('/submit', { as: 'contributor', seed: tree });
  const posts = watchSubmissionBodies(t);

  await episodeUnderSeason(t, "Cat's in the Bag...");
  await t.user.type(screen.getByLabelText(/^Number/), '3');
  await t.user.click(screen.getByLabelText('I release this contribution into the public domain (CC0)'));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes).toEqual([
    {
      op: 'create',
      kind: 'work',
      ref: 'entry',
      fields: { mediaType: 'film_tv', subtype: 'episode', title: "Cat's in the Bag..." },
    },
    { op: 'relate', type: 'work_part', from: { id: t.seeded.s1 }, to: { ref: 'entry' }, data: { position: 3 } },
  ]);
});

test('blank number sends no position', async () => {
  const t = await renderApp('/submit', { as: 'contributor', seed: tree });
  const posts = watchSubmissionBodies(t);

  await episodeUnderSeason(t, 'Unnumbered');
  await t.user.type(screen.getByLabelText(/^Number/), '  ');
  await t.user.click(screen.getByLabelText('I release this contribution into the public domain (CC0)'));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  await waitFor(async () => expect(await posts()).toHaveLength(1));
  expect((await posts())[0]?.changes.at(-1)).toEqual({
    op: 'relate',
    type: 'work_part',
    from: { id: t.seeded.s1 },
    to: { ref: 'entry' },
    data: {},
  });
});

test('out-of-range number blocks submit', async () => {
  const t = await renderApp('/submit', { as: 'contributor', seed: tree });
  const posts = watchSubmissionBodies(t);

  await episodeUnderSeason(t, 'Out of Range');
  const number = screen.getByLabelText(/^Number/);
  await t.user.type(number, '-1');
  await t.user.click(screen.getByLabelText('I release this contribution into the public domain (CC0)'));
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(number).toHaveAttribute('aria-invalid', 'true');
  expect(number).toHaveAccessibleDescription('Use a whole number from 0 to 2147483647.');
  expect(number).toHaveFocus();

  await t.user.clear(number);
  await t.user.type(number, '2147483648');
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));
  expect(number).toHaveAccessibleDescription('Use a whole number from 0 to 2147483647.');
  expect(await posts()).toHaveLength(0);
});

test('the duplicate check looks among the parts of the picked parent', async () => {
  const t = await renderApp('/submit', { as: 'contributor', seed: tree });

  await episodeUnderSeason(t, 'Pilot');
  const found = await screen.findByRole('list', { name: 'Already in the catalog' });
  expect(within(found).getByRole('link', { name: 'Pilot' })).toBeInTheDocument();
});
