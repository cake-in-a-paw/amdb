import { screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp, seed } from './harness';

test('the home page shows the site name, a search box and works from the catalog', async () => {
  const { seeded } = await renderApp('/', { seed });

  expect(screen.getByRole('link', { name: 'AMDB home' })).toBeInTheDocument();
  expect(screen.getByRole('searchbox', { name: 'Search the catalog' })).toBeInTheDocument();
  const list = await screen.findByRole('list', { name: 'In the catalog' });
  const row = await within(list).findByRole('link', { name: /Spirited Away/ });
  expect(row).toHaveAttribute('href', `/entities/${seeded.works.spiritedAway}`);
  expect(within(row).getByText('Film & TV, 2001')).toBeInTheDocument();
});

test('an empty catalog invites the first contribution', async () => {
  await renderApp('/');

  expect(await screen.findByText('The catalog is empty.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Add the first entry' })).toHaveAttribute('href', '/submit');
});

test('a signed-out visitor sees Sign in and no Moderation link', async () => {
  await renderApp('/');

  expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Moderation' })).not.toBeInTheDocument();
});

test('a contributor gets an account menu, and signing out ends the session in the app and the API', async () => {
  const { user } = await renderApp('/', { as: 'contributor' });

  await user.click(await screen.findByRole('button', { name: 'Account' }));
  expect(screen.queryByRole('link', { name: 'Moderation' })).not.toBeInTheDocument();
  await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

  expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
});

test('a failed sign-out says so and leaves the person signed in', async () => {
  const { user, auth } = await renderApp('/', { as: 'contributor' });
  auth.failing.add('signOut');

  await user.click(await screen.findByRole('button', { name: 'Account' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't sign out. Try again.");
  expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
});

test('the account menu links to the account and submissions pages', async () => {
  const { user } = await renderApp('/', { as: 'contributor' });

  await user.click(await screen.findByRole('button', { name: 'Account' }));

  expect(await screen.findByRole('menuitem', { name: 'My submissions' })).toHaveAttribute('href', '/me/submissions');
  expect(screen.getByRole('menuitem', { name: 'Account settings' })).toHaveAttribute('href', '/account');
});

test.each(['moderator', 'admin'] as const)('a %s sees the Moderation link', async (as) => {
  await renderApp('/', { as });

  expect(await screen.findByRole('link', { name: 'Moderation' })).toHaveAttribute('href', '/moderation');
});

test('the footer says the data is CC0', async () => {
  await renderApp('/');

  const footer = screen.getByRole('contentinfo');
  expect(within(footer).getByText(/All data CC0/)).toBeInTheDocument();
  expect(within(footer).getByText(/dumps coming soon/i)).toBeInTheDocument();
});
