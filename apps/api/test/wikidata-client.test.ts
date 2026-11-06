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
  });
  return { client, sleeps, calls };
};

const sparqlBody = { results: { bindings: [{ item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q1' } }] } };

describe('wikidata client', () => {
  it('sends the AMDB User-Agent and a 30 s timeout signal on every request', async () => {
    const { client, calls } = harness([json(sparqlBody), json({ entities: {} })]);
    const rows = await client.sparql('SELECT ?item WHERE {}');
    await client.entities(['Q1']);
    expect(rows).toEqual([{ item: 'http://www.wikidata.org/entity/Q1' }]);
    expect(calls).toHaveLength(2);
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
    expect(entUrl.searchParams.get('props')).toBe('labels|descriptions|claims|sitelinks');
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
});
