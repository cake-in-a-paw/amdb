import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { renderApp, seed, type TestApi } from './harness';

/** The seeded catalog, plus a pending Amélie remake that another contributor submitted. */
async function withPendingAmelie(api: TestApi) {
  const seeded = await seed(api);
  const other = api.as({ kind: 'user', userId: await api.createUser() });
  const res = await other.post('/api/submissions', {
    cc0: true,
    changes: [
      {
        op: 'create',
        kind: 'work',
        ref: 'w',
        fields: {
          mediaType: 'film_tv',
          subtype: 'movie',
          title: 'Amélie',
          releaseYear: 2026,
          description: 'Only its submitter and moderators may read this.',
        },
      },
    ],
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return seeded;
}

const urlOf = (input: Request | string | URL) => (input instanceof Request ? input.url : String(input));

/** Counts the duplicate-check requests the app makes. */
function watchDuplicates(t: { api: TestApi }) {
  const spy = vi.spyOn(t.api.app, 'request');
  return () => spy.mock.calls.filter(([input]) => urlOf(input).includes('/api/duplicates'));
}

test('"  amelie " finds the existing Amélie and the pending one, which shows only title, type and year', async () => {
  const t = await renderApp('/submit', { as: 'contributor', seed: withPendingAmelie });

  await t.user.selectOptions(screen.getByLabelText('Media type'), 'film_tv');
  await t.user.type(screen.getByLabelText('Title'), '  amelie ');

  const region = await screen.findByRole('region', { name: 'Possible duplicates' });
  const existing = await within(region).findByRole('list', { name: 'Already in the catalog' });
  const match = within(existing).getByRole('listitem');
  expect(within(match).getByRole('link', { name: 'Amélie' })).toHaveAttribute(
    'href',
    `/entities/${t.seeded.works.amelie}`,
  );
  expect(within(match).getByRole('link', { name: 'Edit this instead' })).toHaveAttribute(
    'href',
    `/entities/${t.seeded.works.amelie}`,
  );

  const pending = within(within(region).getByRole('list', { name: 'Pending review' })).getByRole('listitem');
  expect(pending).toHaveTextContent(/^Amélie\s*Film & TV, 2026\s*Pending review$/);
  expect(within(pending).queryByRole('link')).not.toBeInTheDocument();
  expect(screen.queryByText(/Only its submitter/)).not.toBeInTheDocument();
});

test('typing five characters quickly makes one request', async () => {
  const t = await renderApp('/submit', { as: 'contributor', seed: withPendingAmelie });
  await t.user.selectOptions(screen.getByLabelText('Media type'), 'film_tv');
  const requests = watchDuplicates(t);
  // No delay between keystrokes, so all five land well inside the 300ms debounce.
  const fast = userEvent.setup({ delay: null });

  await fast.type(screen.getByLabelText('Title'), 'ameli');

  expect(await screen.findByRole('link', { name: 'Edit this instead' })).toBeInTheDocument();
  expect(requests()).toHaveLength(1);
  expect(urlOf(requests()[0]?.[0] ?? '')).toContain('title=ameli');
});

test('no matches says so, and a failed check says so without blocking the form', async () => {
  const t = await renderApp('/submit', { as: 'contributor', seed });
  await t.user.selectOptions(screen.getByLabelText('Media type'), 'Book');

  await t.user.type(screen.getByLabelText('Title'), 'Zzyzx');
  expect(await screen.findByText('No similar entries in the catalog.')).toBeInTheDocument();

  const real = t.api.app.request.bind(t.api.app);
  // The only way to make the in-process API drop a request: reject at it, for the duplicate check only.
  vi.spyOn(t.api.app, 'request').mockImplementation((input, init) =>
    urlOf(input).includes('/api/duplicates') ? Promise.reject(new TypeError('Failed to fetch')) : real(input, init),
  );
  await t.user.type(screen.getByLabelText('Title'), ' Road');

  expect(await screen.findByText(/Couldn't check for duplicates/)).toBeInTheDocument();
  expect(screen.getByLabelText('Title')).toBeEnabled();
});
