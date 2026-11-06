import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getAnonToken } from '@/lib/anon';
import { useDraft } from '@/lib/drafts';
import { renderApp, seed } from './harness';

const KEY = 'amdb.draft.submit';
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
    localStorage.setItem(`amdb.draft.edit.${t.seeded.works.spiritedAway}`, 'null');

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

test('a 400 from the API keeps the draft and the form', async () => {
  const t = await renderApp('/submit');
  await fillBook(t, 'Rocannon’s World');
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
  expect(screen.getByLabelText('Title')).toHaveValue('Rocannon’s World');
  await waitFor(() => expect(stored()?.fields.title).toBe('Rocannon’s World'));
});
