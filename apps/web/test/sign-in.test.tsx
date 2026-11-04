import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderApp } from './harness';

afterEach(() => vi.unstubAllGlobals());

async function enterEmail(user: Awaited<ReturnType<typeof renderApp>>['user'], email = 'ada@example.test') {
  await user.type(await screen.findByLabelText('Email'), email);
  await user.click(screen.getByRole('button', { name: 'Continue with email' }));
}

test('an email code signs the person in and returns them to where they came from', async () => {
  const { user, auth, api, router } = await renderApp('/sign-in?next=/account');
  auth.signInAs = await api.createUser({ email: 'ada@example.test' });

  await enterEmail(user);
  expect(auth.calls).toContainEqual({
    method: 'sendVerificationOtp',
    args: { email: 'ada@example.test', type: 'sign-in' },
  });
  await user.type(await screen.findByLabelText('Code'), '123456');

  await waitFor(() => expect(router.state.location.pathname).toBe('/account'));
  expect(await screen.findByRole('button', { name: 'Account' })).toBeInTheDocument();
});

test('a wrong code says so and stays on the code step', async () => {
  const { user, router } = await renderApp('/sign-in');

  await enterEmail(user);
  await user.type(await screen.findByLabelText('Code'), '000000');

  expect(await screen.findByRole('alert')).toHaveTextContent("That code didn't work.");
  expect(router.state.location.pathname).toBe('/sign-in');
});

test('a failed send says so and keeps the address', async () => {
  const { user, auth } = await renderApp('/sign-in');
  auth.failing.add('sendVerificationOtp');

  await enterEmail(user);

  expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't send the email");
  expect(screen.getByLabelText('Email')).toHaveValue('ada@example.test');
});

test.each([
  ['Continue with Google', 'google'],
  ['Continue with GitHub', 'github'],
])('%s calls the social sign-in with a callback to the page the person came from', async (name, provider) => {
  const { user, auth } = await renderApp('/sign-in?next=/me/submissions');

  await user.click(await screen.findByRole('button', { name }));

  await waitFor(() =>
    expect(auth.calls).toContainEqual({
      method: 'social',
      args: {
        provider,
        callbackURL: `${window.location.origin}/me/submissions`,
        errorCallbackURL: `${window.location.origin}/sign-in?next=%2Fme%2Fsubmissions`,
      },
    }),
  );
});

test('a next that leaves the site is ignored', async () => {
  const { user, auth } = await renderApp('/sign-in?next=https://evil.example/x');

  await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));

  await waitFor(() => expect(auth.calls.some((c) => c.method === 'social')).toBe(true));
  expect(auth.calls.find((c) => c.method === 'social')?.args).toMatchObject({
    callbackURL: `${window.location.origin}/`,
  });
});

test('a passkey button signs in with a saved passkey', async () => {
  const { user, auth, api, router } = await renderApp('/sign-in?next=/account');
  auth.signInAs = await api.createUser();

  await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

  await waitFor(() => expect(router.state.location.pathname).toBe('/account'));
});

test('a refused passkey says so', async () => {
  const { user } = await renderApp('/sign-in');

  await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't sign in with a passkey");
});

test('after a first email sign-in a passkey is offered; saving it continues to the page', async () => {
  vi.stubGlobal('PublicKeyCredential', class {});
  const { user, auth, api, router } = await renderApp('/sign-in?next=/account');
  auth.signInAs = await api.createUser();

  await enterEmail(user);
  await user.type(await screen.findByLabelText('Code'), '123456');
  expect(await screen.findByRole('heading', { name: 'Skip the email next time?' })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/sign-in');
  await user.click(screen.getByRole('button', { name: 'Set it up' }));

  await waitFor(() => expect(router.state.location.pathname).toBe('/account'));
  expect(auth.calls.some((c) => c.method === 'addPasskey')).toBe(true);
});

test('"Not now" skips the offer without saving a passkey', async () => {
  vi.stubGlobal('PublicKeyCredential', class {});
  const { user, auth, api, router } = await renderApp('/sign-in?next=/account');
  auth.signInAs = await api.createUser();

  await enterEmail(user);
  await user.type(await screen.findByLabelText('Code'), '123456');
  await user.click(await screen.findByRole('button', { name: 'Not now' }));

  await waitFor(() => expect(router.state.location.pathname).toBe('/account'));
  expect(auth.calls.some((c) => c.method === 'addPasskey')).toBe(false);
});

test('a failed passkey save says so and offers to continue anyway', async () => {
  vi.stubGlobal('PublicKeyCredential', class {});
  const { user, auth, api } = await renderApp('/sign-in');
  auth.signInAs = await api.createUser();
  auth.failing.add('addPasskey');

  await enterEmail(user);
  await user.type(await screen.findByLabelText('Code'), '123456');
  await user.click(await screen.findByRole('button', { name: 'Set it up' }));

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save a passkey");
});

test('no offer when the person already has a passkey', async () => {
  vi.stubGlobal('PublicKeyCredential', class {});
  const { user, auth, api, router } = await renderApp('/sign-in?next=/account');
  auth.signInAs = await api.createUser();
  auth.passkeys = [{ id: 'p1' }];

  await enterEmail(user);
  await user.type(await screen.findByLabelText('Code'), '123456');

  await waitFor(() => expect(router.state.location.pathname).toBe('/account'));
  expect(screen.queryByRole('heading', { name: 'Skip the email next time?' })).not.toBeInTheDocument();
});

test('no offer in a browser without passkeys', async () => {
  const { user, auth, api, router } = await renderApp('/sign-in?next=/account');
  auth.signInAs = await api.createUser();

  await enterEmail(user);
  await user.type(await screen.findByLabelText('Code'), '123456');

  await waitFor(() => expect(router.state.location.pathname).toBe('/account'));
});

test('the header Sign in link carries the current page as next', async () => {
  const { user, router } = await renderApp('/account');

  await screen.findByText('Sign in to see your account.');
  await user.click(within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' }));

  await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
  expect(router.state.location.search).toEqual({ next: '/account' });
});
