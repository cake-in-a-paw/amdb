import { expect, it } from 'vitest';
import { createApiClient } from '../src/api/client';

function recorder() {
  const seen: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push(new Request(input, init));
    return Response.json({ ok: true });
  };
  return { seen, fetch };
}

it('calls headers() on every request and sends what it returns', async () => {
  const { seen, fetch } = recorder();
  let n = 0;
  const api = createApiClient({
    baseUrl: 'http://amdb.test',
    fetch,
    headers: () => ({ 'x-amdb-anon': `anon-${++n}` }),
  });

  await api.GET('/api/health');
  await api.GET('/api/health');

  expect(seen.map((r) => r.url)).toEqual(['http://amdb.test/api/health', 'http://amdb.test/api/health']);
  expect(seen.map((r) => r.headers.get('x-amdb-anon'))).toEqual(['anon-1', 'anon-2']);
});

it('adds exactly what headers() returns, and nothing when it returns none or is omitted', async () => {
  const send = async (headers?: () => Record<string, string>) => {
    const { seen, fetch } = recorder();
    await createApiClient({ baseUrl: 'http://amdb.test', fetch, ...(headers ? { headers } : {}) }).GET('/api/health');
    const [request] = seen;
    if (!request) throw new Error('no request was sent');
    return Object.fromEntries(request.headers);
  };

  const plain = await send();
  expect(await send(() => ({}))).toEqual(plain);
  expect(await send(() => ({ 'x-amdb-anon': 'anon-1' }))).toEqual({ ...plain, 'x-amdb-anon': 'anon-1' });
});

it('has no origin to default to outside a browser, so a relative request fails there', async () => {
  // Node has no `location`: the base URL is '' and a bare path isn't a URL a Request accepts.
  expect(globalThis.location).toBeUndefined();
  await expect(createApiClient({ fetch: recorder().fetch }).GET('/api/health')).rejects.toThrow();
});
