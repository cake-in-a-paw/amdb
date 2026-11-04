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

it('sends no extra header when headers() returns none or is omitted', async () => {
  const a = recorder();
  await createApiClient({ baseUrl: 'http://amdb.test', fetch: a.fetch, headers: () => ({}) }).GET('/api/health');
  const b = recorder();
  await createApiClient({ baseUrl: 'http://amdb.test', fetch: b.fetch }).GET('/api/health');
  expect(a.seen[0]?.headers.has('x-amdb-anon')).toBe(false);
  expect(b.seen[0]?.headers.has('x-amdb-anon')).toBe(false);
});
