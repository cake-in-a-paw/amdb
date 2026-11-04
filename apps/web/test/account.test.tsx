import { screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './harness';

const meOf = async (t: Awaited<ReturnType<typeof renderApp>>) =>
  (await (await t.api.as({ kind: 'user', userId: t.session.userId! }).get('/api/me')).json()) as {
    handle: string | null;
  };

test('the account shows the email and saves a handle', async () => {
  const t = await renderApp('/account', { as: 'contributor' });
  const { user } = t;

  expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
  await user.type(await screen.findByLabelText('Handle'), 'ada_l');
  await user.click(screen.getByRole('button', { name: 'Save handle' }));

  expect(await screen.findByRole('status')).toHaveTextContent('Saved');
  expect((await meOf(t)).handle).toBe('ada_l');
  // The account menu shows the new handle.
  await user.click(screen.getByRole('button', { name: 'Account' }));
  expect(await screen.findByText('ada_l')).toBeInTheDocument();
});

test('a taken handle says so and keeps what was typed', async () => {
  const t = await renderApp('/account', {
    as: 'contributor',
    seed: async (api) => {
      const other = api.as({ kind: 'user', userId: await api.createUser() });
      expect((await other.patch('/api/me', { handle: 'ada_l' })).status).toBe(200);
    },
  });

  await t.user.type(await screen.findByLabelText('Handle'), 'Ada_L');
  await t.user.click(screen.getByRole('button', { name: 'Save handle' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('That handle is taken');
  expect(screen.getByLabelText('Handle')).toHaveValue('Ada_L');
  expect((await meOf(t)).handle).toBeNull();
});

test.each([
  ['admin', /isn't available/],
  ['a!', /isn't valid/],
])('the handle %s is refused with an explanation', async (typed, message) => {
  const { user } = await renderApp('/account', { as: 'contributor' });

  await user.type(await screen.findByLabelText('Handle'), typed);
  await user.click(screen.getByRole('button', { name: 'Save handle' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(message);
});

test('a handle can be cleared, going back to "contributor"', async () => {
  const t = await renderApp('/account', { as: 'contributor' });
  await t.user.type(await screen.findByLabelText('Handle'), 'mine_1');
  await t.user.click(screen.getByRole('button', { name: 'Save handle' }));
  await screen.findByRole('status');

  await t.user.click(screen.getByRole('button', { name: 'Clear handle' }));

  expect(await screen.findByText(/cleared/i)).toBeInTheDocument();
  expect((await meOf(t)).handle).toBeNull();
  expect(screen.getByLabelText('Handle')).toHaveValue('');
});

test('signed out, the account page asks for a sign-in', async () => {
  await renderApp('/account');

  expect(await screen.findByText('Sign in to see your account.')).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Sign in' }).length).toBeGreaterThan(0);
});

test('saving after the session ended says so, with a way to sign in again', async () => {
  const t = await renderApp('/account', { as: 'contributor' });
  await t.user.type(await screen.findByLabelText('Handle'), 'ada_l');
  // The session expires while the page is open.
  t.session.userId = null;

  await t.user.click(screen.getByRole('button', { name: 'Save handle' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Your session ended. Sign in again.');
  expect(within(alert).getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
    'href',
    '/sign-in?next=%2Faccount',
  );
});
