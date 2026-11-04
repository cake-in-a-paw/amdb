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
