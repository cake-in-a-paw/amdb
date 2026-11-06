import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import { expect, onTestFinished, test, vi } from 'vitest';
import { getAnonToken, peekAnonToken } from '@/lib/anon';
import { createAppRouter } from '@/router';
import { renderApp } from './harness';

const film = (title: string) => ({
  op: 'create',
  kind: 'work',
  ref: 'w',
  fields: { mediaType: 'film_tv', subtype: 'movie', title },
});

/** Submits as the browser's anonymous visitor, with the token the app itself would send. */
async function submitAnonymously(t: Awaited<ReturnType<typeof renderApp>>, title = 'Arrival') {
  const res = await t.api.app.request('/api/submissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-amdb-anon': getAnonToken() },
    body: JSON.stringify({ cc0: true, note: 'from the couch', changes: [film(title)] }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { id: string; changes: { id: string }[] };
}

/** The client hands Hono a Request; a bare path or URL is also allowed by `app.request`. */
const urlOf = (input: Request | string | URL) => (input instanceof Request ? input.url : String(input));

/** Watches the in-process API; the returned function lists the claim calls so far. */
function watchClaims(t: Awaited<ReturnType<typeof renderApp>>) {
  const spy = vi.spyOn(t.api.app, 'request');
  return () => spy.mock.calls.filter(([input]) => urlOf(input).includes('/api/me/claim-anonymous'));
}

async function signInByEmail(t: Awaited<ReturnType<typeof renderApp>>) {
  t.auth.signInAs = await t.api.createUser();
  await t.router.navigate({ to: '/sign-in' });
  await t.user.type(await screen.findByLabelText('Email'), 'ada@example.test');
  await t.user.click(screen.getByRole('button', { name: 'Continue with email' }));
  await t.user.type(await screen.findByLabelText('Code'), '123456');
  await waitFor(() => expect(t.router.state.location.pathname).toBe('/'));
}

test('an anonymous visitor sees their submission by token, in words', async () => {
  const t = await renderApp('/');
  await submitAnonymously(t);

  await t.router.navigate({ to: '/me/submissions' });

  const list = await screen.findByRole('list', { name: 'Your submissions' });
  expect(within(list).getByText('Waiting for review')).toBeInTheDocument();
  expect(within(list).getByText('from the couch')).toBeInTheDocument();
});

test('signing in claims the anonymous submissions exactly once and rotates the token', async () => {
  const t = await renderApp('/');
  const claims = watchClaims(t);
  const submission = await submitAnonymously(t);
  const token = peekAnonToken();

  await signInByEmail(t);

  await waitFor(() => expect(peekAnonToken()).not.toBe(token));
  expect(claims()).toHaveLength(1);
  const [sent] = claims()[0] ?? [];
  expect(sent instanceof Request && sent.headers.get('x-amdb-anon')).toBe(token);
  await t.router.navigate({ to: '/me/submissions' });
  const list = await screen.findByRole('list', { name: 'Your submissions' });
  expect(await within(list).findByText('Waiting for review')).toBeInTheDocument();
  expect(within(list).getByText('from the couch')).toBeInTheDocument();
  // The new account owns it: the old token no longer sees it.
  const old = await t.api.as({ kind: 'anon', token: token! }).get(`/api/submissions/${submission.id}`);
  expect(old.status).toBe(404);
  // Later requests while signed in do not claim again.
  await t.router.invalidate();
  expect(claims()).toHaveLength(1);
});

test('a token already marked claimed (a reload mid-claim) is not claimed again', async () => {
  const t = await renderApp('/');
  const claims = watchClaims(t);
  await submitAnonymously(t);
  localStorage.setItem('amdb.anon.claimed', getAnonToken());

  await signInByEmail(t);
  await screen.findByRole('button', { name: 'Account' });

  expect(claims()).toHaveLength(0);
});

test('no claim when the browser never had a token', async () => {
  const t = await renderApp('/');
  const claims = watchClaims(t);
  localStorage.clear();

  await signInByEmail(t);
  await screen.findByRole('button', { name: 'Account' });

  expect(claims()).toHaveLength(0);
});

test('a storage failure does not break sign-in', async () => {
  const t = await renderApp('/');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });

  await signInByEmail(t);

  expect(await screen.findByRole('button', { name: 'Account' })).toBeInTheDocument();
  vi.restoreAllMocks();
});

/** Makes the claim call fail with a 500 until the returned function is called. */
function failClaims(t: Awaited<ReturnType<typeof renderApp>>) {
  const request = t.api.app.request.bind(t.api.app);
  let failing = true;
  const spy = vi
    .spyOn(t.api.app, 'request')
    .mockImplementation(async (input, init) =>
      failing && urlOf(input).includes('claim-anonymous') ? new Response('{}', { status: 500 }) : request(input, init),
    );
  return {
    claims: () => spy.mock.calls.filter(([input]) => urlOf(input).includes('/api/me/claim-anonymous')),
    recover: () => (failing = false),
  };
}

/** Whether the signed-in account now owns `submissionId`, as the API sees it. */
async function owned(t: Awaited<ReturnType<typeof renderApp>>, submissionId: string) {
  const res = await t.api.as({ kind: 'user', userId: t.session.userId! }).get(`/api/submissions/${submissionId}`);
  return res.status === 200;
}

test('a failed claim says so, and Try again hands the submissions over', async () => {
  const t = await renderApp('/');
  const submission = await submitAnonymously(t);
  const token = peekAnonToken();
  const fault = failClaims(t);

  await signInByEmail(t);

  expect(await screen.findByRole('alert')).toHaveTextContent(
    "Couldn't check this browser for anything you submitted before signing in.",
  );
  expect(peekAnonToken()).toBe(token);
  expect(localStorage.getItem('amdb.anon.claimed')).toBeNull();
  expect(await owned(t, submission.id)).toBe(false);

  fault.recover();
  await t.user.click(screen.getByRole('button', { name: 'Try again' }));

  await waitFor(() => expect(peekAnonToken()).not.toBe(token));
  expect(fault.claims()).toHaveLength(2);
  expect(await owned(t, submission.id)).toBe(true);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('with storage blocked, a second Try again during a claim in flight sends nothing more', async () => {
  const t = await renderApp('/');
  // Storage can't hold the token or mark it claimed, so only the in-memory guard stops a second send.
  for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
  }
  // Before the setup file's cleanup touches localStorage.
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  await submitAnonymously(t);
  const request = t.api.app.request.bind(t.api.app);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let sent = 0;
  vi.spyOn(t.api.app, 'request').mockImplementation(async (input, init) => {
    if (!urlOf(input).includes('claim-anonymous')) return request(input, init);
    sent++;
    if (sent === 1) return new Response('{}', { status: 500 });
    await held;
    return request(input, init);
  });

  await signInByEmail(t);
  await screen.findByRole('alert');
  await t.user.click(screen.getByRole('button', { name: 'Try again' }));
  await t.user.click(screen.getByRole('button', { name: 'Try again' }));
  release();

  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(sent).toBe(2);
});

test('a failed claim is tried again on the next load', async () => {
  const t = await renderApp('/');
  const submission = await submitAnonymously(t);
  const token = peekAnonToken();
  const fault = failClaims(t);
  await signInByEmail(t);
  await screen.findByRole('alert');
  expect(localStorage.getItem('amdb.anon.claimed')).toBeNull();

  // Reload: a fresh app in the same browser (its storage) and the same session.
  fault.recover();
  t.view.unmount();
  const reloaded = createAppRouter({
    api: t.router.options.context.api,
    auth: t.auth,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    queryDefaults: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(<RouterProvider router={reloaded} />);

  await waitFor(() => expect(peekAnonToken()).not.toBe(token));
  expect(fault.claims()).toHaveLength(2);
  expect(await owned(t, submission.id)).toBe(true);
  // Unmounted here, before the harness closes the database under it.
  view.unmount();
  await reloaded.options.context.queryClient.cancelQueries();
});

test('a rejected change shows its reason and a Fix and resubmit link', async () => {
  const t = await renderApp('/', { as: 'contributor' });
  const created = await t.api
    .as({ kind: 'user', userId: t.session.userId! })
    .post('/api/submissions', { cc0: true, changes: [film('Arival')] });
  const submission = (await created.json()) as { changes: { id: string }[] };
  const changeId = submission.changes[0]!.id;
  const mod = t.api.as({ kind: 'user', userId: await t.api.createUser({ role: 'moderator' }) });
  expect((await mod.post(`/api/changes/${changeId}/reject`, { reason: 'Title is misspelled' })).status).toBe(200);

  await t.router.navigate({ to: '/me/submissions' });

  const list = await screen.findByRole('list', { name: 'Your submissions' });
  expect(await within(list).findByText(/Title is misspelled/)).toBeInTheDocument();
  expect(within(list).getByText('Rejected')).toBeInTheDocument();
  expect(within(list).getByRole('link', { name: 'Fix and resubmit' })).toHaveAttribute(
    'href',
    `/changes/${changeId}/resubmit`,
  );
});

test('an approved change reads plainly', async () => {
  const t = await renderApp('/', { as: 'contributor' });
  const me = t.api.as({ kind: 'user', userId: t.session.userId! });
  const created = await me.post('/api/submissions', { cc0: true, changes: [film('Arrival')] });
  const body = (await created.json()) as { changes: { id: string; status: string }[] };
  // The app's review policy holds every change for a moderator.
  expect(body.changes[0]?.status).toBe('pending');
  const mod = t.api.as({ kind: 'user', userId: await t.api.createUser({ role: 'moderator' }) });
  expect((await mod.post(`/api/changes/${body.changes[0]!.id}/approve`)).status).toBe(200);

  await t.router.navigate({ to: '/me/submissions' });

  const list = await screen.findByRole('list', { name: 'Your submissions' });
  expect(await within(list).findByText('Approved')).toBeInTheDocument();
  expect(within(list).queryByText('Waiting for review')).not.toBeInTheDocument();
});

test('with nothing submitted, the page invites a first contribution', async () => {
  await renderApp('/me/submissions', { as: 'contributor' });

  expect(await screen.findByText('You haven’t submitted anything yet.')).toBeInTheDocument();
});

test('a failed account lookup says so instead of showing the anonymous view', async () => {
  const t = await renderApp('/', { as: 'contributor' });
  const request = t.api.app.request.bind(t.api.app);
  let failing = true;
  vi.spyOn(t.api.app, 'request').mockImplementation(async (input, init) =>
    failing && new URL(urlOf(input), 'http://amdb.test').pathname === '/api/me'
      ? Promise.reject(new TypeError('offline'))
      : request(input, init),
  );
  // Forget the account the shell loaded, so the page has to ask again.
  t.router.options.context.queryClient.removeQueries({ queryKey: ['me'] });

  await t.router.navigate({ to: '/me/submissions' });

  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your account");
  expect(screen.queryByText(/kept in this browser/)).not.toBeInTheDocument();
  expect(screen.queryByText('You haven’t submitted anything yet.')).not.toBeInTheDocument();
  failing = false;
  await t.user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('You haven’t submitted anything yet.')).toBeInTheDocument();
  expect(screen.queryByText(/kept in this browser/)).not.toBeInTheDocument();
});

test('a failed load says so and can retry', async () => {
  const t = await renderApp('/', { as: 'contributor' });
  const request = t.api.app.request.bind(t.api.app);
  let failing = true;
  vi.spyOn(t.api.app, 'request').mockImplementation(async (input, init) =>
    failing && urlOf(input).includes('/api/me/submissions')
      ? new Response('{}', { status: 500 })
      : request(input, init),
  );

  await t.router.navigate({ to: '/me/submissions' });
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your submissions.");
  failing = false;
  await t.user.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByText('You haven’t submitted anything yet.')).toBeInTheDocument();
});
