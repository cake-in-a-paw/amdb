import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getAnonToken } from '@/lib/anon';
import { moveDrafts, useDraft } from '@/lib/drafts';
import { emptyForm } from '@/lib/submission';
import { partOf, publishTree, renderApp, seed, tvWork } from './harness';

const KEY = 'amdb.draft.submit.anonymous';
const CC0 = 'I release this contribution into the public domain (CC0)';

/** The draft as stored, or null. */
const stored = () => {
  const raw = localStorage.getItem(KEY);
  return raw === null ? null : (JSON.parse(raw) as { fields: Record<string, string> });
};

const urlOf = (input: Request | string | URL) => (input instanceof Request ? input.url : String(input));

describe('useDraft', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('writes are debounced 500ms and flushed on unmount', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useDraft('t', { n: 0 }));

    act(() => result.current[1]({ n: 1 }));
    act(() => result.current[1]({ n: 2 }));
    expect(result.current[0]).toEqual({ n: 2 });
    expect(localStorage.getItem('amdb.draft.t')).toBeNull();
    act(() => vi.advanceTimersByTime(499));
    expect(localStorage.getItem('amdb.draft.t')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(localStorage.getItem('amdb.draft.t')).toBe('{"n":2}');

    act(() => result.current[1]({ n: 3 }));
    unmount();
    expect(localStorage.getItem('amdb.draft.t')).toBe('{"n":3}');
    expect(renderHook(() => useDraft('t', { n: 0 })).result.current[0]).toEqual({ n: 3 });
  });

  test('clear forgets the draft, and a pending write does not bring it back', () => {
    vi.useFakeTimers();
    localStorage.setItem('amdb.draft.t', '{"n":1}');
    const { result, unmount } = renderHook(() => useDraft('t', { n: 0 }));
    expect(result.current[0]).toEqual({ n: 1 });

    act(() => result.current[1]({ n: 2 }));
    act(() => result.current[2]());
    act(() => vi.advanceTimersByTime(1000));
    unmount();

    expect(result.current[0]).toEqual({ n: 0 });
    expect(localStorage.getItem('amdb.draft.t')).toBeNull();
  });

  test('when storage throws, the draft is kept in memory', () => {
    vi.useFakeTimers();
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
    }
    const first = renderHook(() => useDraft('t', { n: 0 }));

    act(() => first.result.current[1]({ n: 5 }));
    act(() => vi.advanceTimersByTime(500));
    first.unmount();

    const second = renderHook(() => useDraft('t', { n: 0 }));
    expect(second.result.current[0]).toEqual({ n: 5 });
    act(() => second.result.current[2]());
    expect(renderHook(() => useDraft('t', { n: 0 })).result.current[0]).toEqual({ n: 0 });
  });

  test('an unreadable draft falls back to the initial value', () => {
    localStorage.setItem('amdb.draft.t', '{not json');

    expect(renderHook(() => useDraft('t', { n: 0 })).result.current[0]).toEqual({ n: 0 });
  });

  test("moveDrafts carries every contributor's draft across, and never over one already there", () => {
    localStorage.setItem('amdb.draft.edit.a.u1', '"one"');
    localStorage.setItem('amdb.draft.edit.a.u2', '"two"');
    localStorage.setItem('amdb.draft.edit.ab.u1', '"other entry"');
    localStorage.setItem('amdb.draft.edit.b.u2', '"already"');

    moveDrafts('edit.a', 'edit.b');

    expect(localStorage.getItem('amdb.draft.edit.b.u1')).toBe('"one"');
    expect(localStorage.getItem('amdb.draft.edit.a.u1')).toBeNull();
    expect(localStorage.getItem('amdb.draft.edit.b.u2')).toBe('"already"');
    // Not dropped: left where it was.
    expect(localStorage.getItem('amdb.draft.edit.a.u2')).toBe('"two"');
    expect(localStorage.getItem('amdb.draft.edit.ab.u1')).toBe('"other entry"');
  });
});

/** Fills in the smallest valid entry: a book with a title. */
async function fillBook(t: Awaited<ReturnType<typeof renderApp>>, title: string) {
  await t.user.selectOptions(screen.getByLabelText('Media type'), 'Book');
  await t.user.type(screen.getByLabelText('Title'), title);
}

test('an anonymous draft survives leaving the page, and a reload', async () => {
  const t = await renderApp('/submit', { seed });
  await fillBook(t, 'The Dispossessed');

  await t.router.navigate({ to: '/' });
  await t.router.navigate({ to: '/submit' });
  expect(await screen.findByLabelText('Title')).toHaveValue('The Dispossessed');
  expect(screen.getByLabelText('Media type')).toHaveValue('book');

  // A reload: a fresh app on the same browser storage.
  t.view.unmount();
  await renderApp('/submit');
  expect(await screen.findByLabelText('Title')).toHaveValue('The Dispossessed');
});

test('a 429 says when to try again and keeps the draft and the form', async () => {
  const t = await renderApp('/submit');
  // Use up this browser's anonymous allowance (20 an hour) the way the form would.
  for (let i = 0; i < 20; i++) {
    const res = await t.api.app.request('/api/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amdb-anon': getAnonToken() },
      body: JSON.stringify({
        cc0: true,
        changes: [{ op: 'create', kind: 'series', ref: 's', fields: { title: `Series ${i}` } }],
      }),
    });
    expect(res.status).toBe(201);
  }
  await fillBook(t, 'The Lathe of Heaven');
  await t.user.click(screen.getByLabelText(CC0));

  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Too many submissions — try again in 60 minutes');
  expect(screen.getByLabelText('Title')).toHaveValue('The Lathe of Heaven');
  await waitFor(() => expect(stored()?.fields.title).toBe('The Lathe of Heaven'));
});

test('a submission that never reaches the API keeps the draft and the form', async () => {
  const t = await renderApp('/submit');
  await fillBook(t, 'Always Coming Home');
  await t.user.click(screen.getByLabelText(CC0));
  const real = t.api.app.request.bind(t.api.app);
  // The only way to make the in-process API drop a request: reject at it, for the submission only.
  vi.spyOn(t.api.app, 'request').mockImplementation((input, init) =>
    urlOf(input).endsWith('/api/submissions') ? Promise.reject(new TypeError('Failed to fetch')) : real(input, init),
  );

  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach AMDB");
  expect(screen.getByLabelText('Title')).toHaveValue('Always Coming Home');
  await waitFor(() => expect(stored()?.fields.title).toBe('Always Coming Home'));
});

/** Holds the submission POST (or the resubmit) until the returned function is called; other requests go through. */
function holdSubmission(t: Awaited<ReturnType<typeof renderApp>>, path: RegExp) {
  const real = t.api.app.request.bind(t.api.app);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(t.api.app, 'request').mockImplementation(async (input, init) => {
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    if (method === 'POST' && path.test(urlOf(input))) await held;
    return real(input, init);
  });
  return release;
}

test('while a submission is in flight the form is read-only, so nothing typed then is lost', async () => {
  const t = await renderApp('/submit', { as: 'contributor', seed });
  await fillBook(t, 'The Telling');
  await t.user.click(screen.getByLabelText(CC0));
  const release = holdSubmission(t, /\/api\/submissions$/);

  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(await screen.findByRole('button', { name: 'Submitting…' })).toBeDisabled();
  expect(screen.getByLabelText('Title')).toBeDisabled();
  expect(screen.getByLabelText('Find a creator')).toBeDisabled();
  release();
  expect(await screen.findByText('New work: The Telling')).toBeInTheDocument();
});

test('while an edit or a resubmit is in flight its form is read-only too', async () => {
  const t = await renderApp('/', { as: 'contributor', seed });
  await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });
  await t.user.type(await screen.findByLabelText(/^Original title/), 'Sen to Chihiro');
  await t.user.click(screen.getByLabelText(CC0));
  const release = holdSubmission(t, /\/api\/submissions$/);
  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));
  expect(await screen.findByRole('button', { name: 'Submitting…' })).toBeDisabled();
  expect(screen.getByLabelText(/^Original title/)).toBeDisabled();
  release();
  await waitFor(() => expect(t.router.state.location.pathname).toBe(`/entities/${t.seeded.works.spiritedAway}`));

  const author = t.api.as({ kind: 'user', userId: t.session.userId ?? '' });
  const moderator = t.api.as({ kind: 'user', userId: await t.api.createUser({ role: 'moderator' }) });
  const made = await author.post('/api/submissions', {
    cc0: true,
    changes: [{ op: 'create', kind: 'series', ref: 's', fields: { title: 'Hainish Cycle' } }],
  });
  const changeId = ((await made.json()) as { changes: { id: string }[] }).changes[0]?.id ?? '';
  expect((await moderator.post(`/api/changes/${changeId}/reject`, { reason: 'Spelling.' })).status).toBe(200);
  vi.restoreAllMocks();
  const releaseResubmit = holdSubmission(t, /\/resubmit$/);
  await t.router.navigate({ to: '/changes/$id/resubmit', params: { id: changeId } });
  await t.user.type(await screen.findByLabelText('Title'), ' (novels)');
  await t.user.click(screen.getByRole('button', { name: 'Resubmit for review' }));
  expect(await screen.findByRole('button', { name: 'Resubmitting…' })).toBeDisabled();
  expect(screen.getByLabelText('Title')).toBeDisabled();
  releaseResubmit();
  await waitFor(() => expect(t.router.state.location.pathname).toBe('/me/submissions'));
});

test('only a 201 clears the draft', async () => {
  const t = await renderApp('/submit');
  await fillBook(t, 'The Word for World Is Forest');
  await waitFor(() => expect(stored()?.fields.title).toBe('The Word for World Is Forest'));
  await t.user.click(screen.getByLabelText(CC0));

  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(await screen.findByText('New work: The Word for World Is Forest')).toBeInTheDocument();
  expect(stored()).toBeNull();
  await t.user.click(screen.getByRole('button', { name: 'Submit another' }));
  expect(screen.getByLabelText('Title')).toHaveValue('');
  expect(screen.getByLabelText(CC0)).not.toBeChecked();
});

describe('a saved draft is checked on load', () => {
  test('a draft of JSON null is ignored, and so is one whose nested shape drifted', async () => {
    for (const saved of ['null', '{"kind":"work","fields":{},"credits":[{"entity":"nope"}],"note":""}']) {
      localStorage.setItem(KEY, saved);
      const t = await renderApp('/submit');

      expect(await screen.findByLabelText('Media type')).toHaveValue('');
      expect(screen.getByLabelText('Title')).toHaveValue('');
      t.view.unmount();
    }
  });

  test('an edit draft that does not fit is ignored, and the form opens from the entry', async () => {
    const t = await renderApp('/', { as: 'contributor', seed });
    localStorage.setItem(`amdb.draft.edit.${t.seeded.works.spiritedAway}.${t.session.userId}`, 'null');

    await t.router.navigate({ to: '/entities/$id/edit', params: { id: t.seeded.works.spiritedAway } });

    expect(await screen.findByLabelText('Title')).toHaveValue('Spirited Away');
  });

  test('a draft missing a newer key still opens, with the key filled in', async () => {
    localStorage.setItem(KEY, '{"kind":"work","fields":{"title":"Old draft"},"note":""}');
    await renderApp('/submit');

    expect(await screen.findByLabelText('Title')).toHaveValue('Old draft');
    expect(screen.getByRole('list', { name: 'Tags' })).toBeInTheDocument();
  });
});

describe('drafts are kept per contributor', () => {
  const draftOf = (title: string) => JSON.stringify({ ...emptyForm(), fields: { mediaType: 'book', title } });

  /** Signs the app in as `userId` (or out, with null), the way a sign-in or sign-out reaches the page. */
  async function becomes(t: Awaited<ReturnType<typeof renderApp>>, userId: string | null) {
    t.session.userId = userId;
    await t.router.options.context.queryClient.invalidateQueries({ queryKey: ['me'] });
  }

  test("on a shared browser, one person's submit draft is not shown to the next", async () => {
    const t = await renderApp('/submit', { as: 'contributor' });
    const first = t.session.userId ?? '';
    await fillBook(t, 'The Left Hand of Darkness');
    await waitFor(() => expect(localStorage.getItem(`amdb.draft.submit.${first}`)).toContain('Left Hand'));

    await becomes(t, await t.api.createUser());
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue(''));

    await becomes(t, first);
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('The Left Hand of Darkness'));
  });

  test('a draft written signed out is carried over on signing in', async () => {
    const t = await renderApp('/submit');
    await fillBook(t, 'Four Ways to Forgiveness');
    await waitFor(() => expect(stored()?.fields.title).toBe('Four Ways to Forgiveness'));

    const userId = await t.api.createUser();
    await becomes(t, userId);

    await waitFor(() => expect(localStorage.getItem(`amdb.draft.submit.${userId}`)).toContain('Four Ways'));
    expect(screen.getByLabelText('Title')).toHaveValue('Four Ways to Forgiveness');
    expect(stored()).toBeNull();
  });

  test('a draft saved before drafts were per contributor still opens, and moves to its new key', async () => {
    localStorage.setItem('amdb.draft.submit', draftOf('Planet of Exile'));
    const t = await renderApp('/submit', { as: 'contributor' });

    expect(await screen.findByLabelText('Title')).toHaveValue('Planet of Exile');
    expect(localStorage.getItem('amdb.draft.submit')).toBeNull();
    expect(localStorage.getItem(`amdb.draft.submit.${t.session.userId}`)).toContain('Planet of Exile');
  });

  test('so does an edit draft', async () => {
    const t = await renderApp('/', { as: 'contributor', seed });
    const id = t.seeded.works.spiritedAway;
    await t.router.navigate({ to: '/entities/$id/edit', params: { id } });
    const original = await screen.findByLabelText(/^Original title/);
    await t.user.type(original, 'Sen to Chihiro');
    const key = `amdb.draft.edit.${id}.${t.session.userId}`;
    await waitFor(() => expect(localStorage.getItem(key)).toContain('Sen to Chihiro'));
    await t.router.navigate({ to: '/' });
    // As an older version kept it: under the entry alone.
    localStorage.setItem(`amdb.draft.edit.${id}`, localStorage.getItem(key) ?? '');
    localStorage.removeItem(key);

    await t.router.navigate({ to: '/entities/$id/edit', params: { id } });

    expect(await screen.findByLabelText(/^Original title/)).toHaveValue('Sen to Chihiro');
    expect(localStorage.getItem(`amdb.draft.edit.${id}`)).toBeNull();
  });
});

describe('names and a saved draft', () => {
  test('old draft loads', async () => {
    // Saved before alternate names existed: its fields have no names key.
    localStorage.setItem(KEY, JSON.stringify({ ...emptyForm(), fields: { mediaType: 'book', title: 'Old draft' } }));
    await renderApp('/submit');

    expect(await screen.findByLabelText('Title')).toHaveValue('Old draft');
    expect(screen.getByLabelText('Also known as')).toHaveValue('');
  });
});

describe("search's title and a saved draft", () => {
  test('a saved draft opens, and the title from the address is offered instead of lost', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ...emptyForm(), fields: { mediaType: 'book', title: 'Old draft' } }));
    const t = await renderApp('/submit?title=Zzyzx');

    expect(await screen.findByLabelText('Title')).toHaveValue('Old draft');
    expect(screen.getByText('Your saved draft is open, so “Zzyzx” wasn’t filled in.')).toBeInTheDocument();

    await t.user.click(screen.getByRole('button', { name: 'Start “Zzyzx” instead' }));

    expect(screen.getByLabelText('Title')).toHaveValue('Zzyzx');
    expect(screen.queryByRole('button', { name: /instead/ })).not.toBeInTheDocument();
    expect(t.router.state.location.search).toEqual({});
  });

  test('with no draft the title fills the form, and with a draft of that title nothing is said', async () => {
    const t = await renderApp('/submit?title=Zzyzx');
    expect(await screen.findByLabelText('Title')).toHaveValue('Zzyzx');
    await waitFor(() => expect(stored()?.fields.title).toBe('Zzyzx'));
    t.view.unmount();

    await renderApp('/submit?title=Zzyzx');
    expect(await screen.findByLabelText('Title')).toHaveValue('Zzyzx');
    expect(screen.queryByRole('button', { name: /instead/ })).not.toBeInTheDocument();
  });
});

test('a 400 from the API keeps the draft and the form', async () => {
  // A draft naming a tag the catalog doesn't have: the form accepts it, the API refuses it.
  const ghost = { id: crypto.randomUUID(), title: 'No such tag' };
  localStorage.setItem(
    KEY,
    JSON.stringify({
      ...emptyForm(),
      fields: { mediaType: 'book', title: 'Rocannon’s World' },
      tags: [{ entity: ghost }],
    }),
  );
  const t = await renderApp('/submit');
  await t.user.click(screen.getByLabelText(CC0));

  await t.user.click(screen.getByRole('button', { name: 'Submit for review' }));

  expect(await screen.findByRole('alert')).toHaveTextContent("An entry named here doesn't exist (any more).");
  expect(screen.getByLabelText('Title')).toHaveValue('Rocannon’s World');
  expect(within(screen.getByRole('list', { name: 'Tags' })).getByText('No such tag')).toBeInTheDocument();
  await waitFor(() => expect(stored()?.fields.title).toBe('Rocannon’s World'));
});

/** An episode form as saved before forms had a parent: no `parent` key. */
const oldEpisodeForm = (title: string) => ({
  kind: 'work',
  fields: { mediaType: 'film_tv', subtype: 'episode', title },
  credits: [],
  series: [],
  properties: [],
  tags: [],
  links: [],
  externalIds: [],
  note: '',
});

test('old draft without parent loads', async () => {
  localStorage.setItem(KEY, JSON.stringify(oldEpisodeForm('Saved Before Parts')));
  await renderApp('/submit');

  expect(await screen.findByLabelText('Title')).toHaveValue('Saved Before Parts');
  expect(screen.getByLabelText('Type')).toHaveValue('episode');
  const part = screen.getByRole('group', { name: 'Part of' });
  expect(within(part).queryAllByRole('listitem')).toHaveLength(0);
  expect(within(part).getByLabelText('Find the show or season')).toBeInTheDocument();
});

test('an old edit draft without parent loads, keeping the edit and the live parent', async () => {
  const t = await renderApp('/', {
    as: 'contributor',
    seed: (api) =>
      publishTree(api, [
        tvWork('show', 'series', 'Breaking Bad'),
        tvWork('pilot', 'episode', 'Pilot'),
        partOf('show', 'pilot', 1),
      ]),
  });
  const id = t.seeded.pilot ?? '';
  // Nested forms aren't laid over a fresh one when a draft loads, so each needs upgrading.
  localStorage.setItem(
    `amdb.draft.edit.${id}`,
    JSON.stringify({ base: oldEpisodeForm('Pilot'), form: oldEpisodeForm('Pilot (edited)') }),
  );
  await t.router.navigate({ to: '/entities/$id/edit', params: { id } });

  expect(await screen.findByLabelText('Title')).toHaveValue('Pilot (edited)');
  const part = screen.getByRole('group', { name: 'Part of' });
  expect(within(part).getByText('Breaking Bad')).toBeInTheDocument();
  expect(within(part).getByLabelText(/^Number/)).toHaveValue('1');
});
