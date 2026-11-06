import { describe, expect, it } from 'vitest';
import { createWikidataClient, WikidataUnavailable } from '../src/features/imports/wikidata/client.js';

const UA = 'AMDB-importer/0.1 (https://github.com/cake-in-a-paw/amdb)';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

/** A fake clock whose sleep advances time, plus a fake fetch fed from a queue of responses. */
const harness = (responses: Array<Response | (() => Response)>) => {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const calls: Array<{ url: string; init: RequestInit | undefined; at: number }> = [];
  const timeouts: number[] = [];
  const queue = [...responses];
  const client = createWikidataClient({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init, at: t });
      const next = queue.shift();
      if (!next) throw new Error('fake fetch: no response queued');
      return typeof next === 'function' ? next() : next;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
    timeoutSignal: (ms) => {
      timeouts.push(ms);
      return AbortSignal.timeout(ms);
    },
  });
  return { client, sleeps, calls, timeouts };
};

const sparqlBody = { results: { bindings: [{ item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q1' } }] } };

describe('wikidata client', () => {
  it('sends the AMDB User-Agent and a 65 s timeout for queries and 30 s for entities', async () => {
    const { client, calls, timeouts } = harness([json(sparqlBody), json({ entities: {} })]);
    const rows = await client.sparql('SELECT ?item WHERE {}');
    await client.entities(['Q1']);
    expect(rows).toEqual([{ item: 'http://www.wikidata.org/entity/Q1' }]);
    expect(calls).toHaveLength(2);
    expect(timeouts).toEqual([65_000, 30_000]);
    for (const c of calls) {
      const headers = new Headers(c.init?.headers);
      expect(headers.get('user-agent')).toBe(UA);
      expect(c.init?.signal).toBeInstanceOf(AbortSignal);
    }
    const sparqlCall = calls[0]!;
    expect(sparqlCall.url).toContain('https://query.wikidata.org/sparql?');
    expect(sparqlCall.url).toContain('format=json');
    expect(new Headers(sparqlCall.init?.headers).get('accept')).toBe('application/sparql-results+json');
    const entUrl = new URL(calls[1]!.url);
    expect(entUrl.origin + entUrl.pathname).toBe('https://www.wikidata.org/w/api.php');
    expect(entUrl.searchParams.get('action')).toBe('wbgetentities');
    expect(entUrl.searchParams.get('maxlag')).toBe('5');
    expect(entUrl.searchParams.get('ids')).toBe('Q1');
    expect(entUrl.searchParams.get('props')).toBe('labels|descriptions|claims');
    expect(entUrl.searchParams.get('languages')).toBe('en');
  });

  it('waits Retry-After seconds on a 429, then succeeds', async () => {
    const { client, sleeps } = harness([
      new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
      json(sparqlBody),
    ]);
    await expect(client.sparql('q')).resolves.toHaveLength(1);
    expect(sleeps).toEqual([7000]);
  });

  it('backs off 5, 10, 20, 40 s on 503s without Retry-After and gives up after 5 tries with WikidataUnavailable', async () => {
    const { client, sleeps, calls } = harness(Array.from({ length: 5 }, () => new Response('', { status: 503 })));
    const err = await client.sparql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WikidataUnavailable);
    expect((err as WikidataUnavailable).status).toBe(503);
    expect((err as WikidataUnavailable).url).toContain('query.wikidata.org');
    expect(calls).toHaveLength(5);
    expect(sleeps).toEqual([5000, 10_000, 20_000, 40_000]);
  });

  it('retries a 502 and a 504 like a 503, then succeeds', async () => {
    const { client, sleeps, calls } = harness([
      new Response('', { status: 502 }),
      new Response('', { status: 504, headers: { 'retry-after': '2' } }),
      json(sparqlBody),
    ]);
    await expect(client.sparql('q')).resolves.toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([5000, 2000]);
  });

  it('throws WikidataUnavailable immediately on other non-2xx', async () => {
    const { client, calls } = harness([new Response('nope', { status: 400 })]);
    const err = await client.sparql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WikidataUnavailable);
    expect((err as WikidataUnavailable).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('treats a maxlag error body as retryable', async () => {
    const { client, sleeps } = harness([
      json({ error: { code: 'maxlag', info: 'Waiting for a database server: 6 seconds lagged.' } }),
      json({ entities: { Q1: { id: 'Q1' } } }),
    ]);
    await expect(client.entities(['Q1'])).resolves.toEqual({ Q1: { id: 'Q1' } });
    expect(sleeps).toEqual([5000]);
  });

  it('spaces consecutive requests at least 500 ms apart', async () => {
    const { client, calls, sleeps } = harness([json(sparqlBody), json(sparqlBody), json(sparqlBody)]);
    await client.sparql('a');
    await client.sparql('b');
    await client.sparql('c');
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(500);
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(500);
    expect(sleeps).toEqual([500, 500]);
  });

  it('a missing entity is absent from the result; a redirected one is returned under the requested id', async () => {
    const { client } = harness([
      json({
        entities: {
          Q1: { id: 'Q1', labels: { en: { language: 'en', value: 'One' } } },
          Q2: { id: 'Q2', missing: '' },
          Q99: { id: 'Q99', redirects: { from: 'Q3', to: 'Q99' }, labels: { en: { language: 'en', value: 'Target' } } },
        },
      }),
    ]);
    const out = await client.entities(['Q1', 'Q2', 'Q3']);
    expect(Object.keys(out).sort()).toEqual(['Q1', 'Q3']);
    expect(out.Q3?.id).toBe('Q99');
    expect(out.Q3?.labels?.en?.value).toBe('Target');
  });

  it('entities() refuses more than 50 ids', async () => {
    const { client, calls } = harness([]);
    const ids = Array.from({ length: 51 }, (_, i) => `Q${i + 1}`);
    await expect(client.entities(ids)).rejects.toThrow(/50/);
    expect(calls).toHaveLength(0);
  });

  it('retries a network failure, a timeout and a non-JSON 200 body on the backoff schedule', async () => {
    const { client, sleeps } = harness([
      () => {
        throw new TypeError('fetch failed');
      },
      () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
      () => new Response('<html>oops</html>', { status: 200 }),
      json(sparqlBody),
    ]);
    await expect(client.sparql('q')).resolves.toHaveLength(1);
    expect(sleeps).toEqual([5000, 10_000, 20_000]);
  });

  it.each([
    [
      'a network failure',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    [
      'a timeout',
      () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    ],
    ['a non-JSON body', () => new Response('<html>', { status: 200 })],
  ] as Array<[string, () => Response]>)(
    'throws WikidataUnavailable with status 0 after %s on every try',
    async (_n, f) => {
      const { client, calls } = harness(Array.from({ length: 5 }, () => f));
      const err = await client.sparql('q').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WikidataUnavailable);
      expect((err as WikidataUnavailable).status).toBe(0);
      expect((err as WikidataUnavailable).url).toContain('query.wikidata.org');
      expect(calls).toHaveLength(5);
    },
  );

  it('throws WikidataUnavailable without retrying on a non-maxlag error body', async () => {
    const { client, calls } = harness([json({ error: { code: 'badvalue', info: 'bad' } })]);
    await expect(client.entities(['Q1'])).rejects.toBeInstanceOf(WikidataUnavailable);
    expect(calls).toHaveLength(1);
  });

  it('throws WikidataUnavailable when the expected body shape is missing', async () => {
    const { client } = harness([json({}), json({ results: {} })]);
    await expect(client.entities(['Q1'])).rejects.toBeInstanceOf(WikidataUnavailable);
    await expect(client.sparql('q')).rejects.toBeInstanceOf(WikidataUnavailable);
  });

  it('honors an HTTP-date Retry-After, ignores an empty one, and caps waits at 120 s', async () => {
    const date = new Date(1_000_000 + 9000).toUTCString();
    const { client, sleeps } = harness([
      new Response('', { status: 503, headers: { 'retry-after': date } }),
      new Response('', { status: 503, headers: { 'retry-after': '' } }),
      new Response('', { status: 429, headers: { 'retry-after': '99999' } }),
      json(sparqlBody),
    ]);
    await client.sparql('q');
    // Date has second resolution: 9000 ms ahead of t=1_000_000 rounds down to a whole second.
    expect(sleeps[0]).toBeGreaterThanOrEqual(8000);
    expect(sleeps[0]).toBeLessThanOrEqual(9000);
    expect(sleeps[1]).toBe(10_000);
    expect(sleeps[2]).toBe(120_000);
  });

  it('waits Retry-After on a 503 and gives up on repeated maxlag', async () => {
    const a = harness([new Response('', { status: 503, headers: { 'retry-after': '3' } }), json(sparqlBody)]);
    await a.client.sparql('q');
    expect(a.sleeps).toEqual([3000]);
    const lag = () => json({ error: { code: 'maxlag' } });
    const b = harness(Array.from({ length: 5 }, () => lag));
    const err = await b.client.entities(['Q1']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WikidataUnavailable);
    expect(b.calls).toHaveLength(5);
  });
});
