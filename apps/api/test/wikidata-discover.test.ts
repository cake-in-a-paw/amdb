import { describe, expect, it } from 'vitest';
import { discover } from '../src/features/imports/wikidata/discover.js';
import type { SparqlRow } from '../src/features/imports/wikidata/client.js';
import { type WikidataClient, WikidataUnavailable } from '../src/features/imports/wikidata/client.js';

const FILM = 'Q11424';
const ANIME_FILM = 'Q20650540';
const row = (n: number | string, sl: number | string): SparqlRow => ({
  item: `http://www.wikidata.org/entity/Q${n}`,
  sl: String(sl),
});

// Fake client: answers each query by the class QID it names.
function fake(byClass: Record<string, SparqlRow[]>) {
  const queries: string[] = [];
  const client = {
    async sparql(query: string) {
      queries.push(query);
      const cls = Object.keys(byClass).find((q) => query.includes(`wd:${q}`));
      return cls ? (byClass[cls] ?? []) : [];
    },
    async entities() {
      throw new Error('not used');
    },
  } as unknown as WikidataClient; // test double: only sparql is exercised
  return { client, queries };
}

describe('wikidata discover', () => {
  it('ranks by sitelinks, most first, ties by QID', async () => {
    const { client } = fake({
      [FILM]: [row(30, 50), row(5, 50), row(7, 90), row(9, 60)],
    });
    const out = await discover(client, { classes: [FILM], minSitelinks: 10 });
    expect(out.map((c) => c.qid)).toEqual(['Q7', 'Q9', 'Q5', 'Q30']);
    expect(out[0]).toEqual({ qid: 'Q7', sitelinks: 90, mediaType: 'film_tv', subtype: 'movie' });
  });

  it('an item in both anime film and film is an anime_film', async () => {
    const { client } = fake({ [FILM]: [row(1, 40)], [ANIME_FILM]: [row(1, 40)] });
    // Order passed must not matter: precedence comes from CLASSES.
    const out = await discover(client, { classes: [FILM, ANIME_FILM], minSitelinks: 10 });
    expect(out).toEqual([{ qid: 'Q1', sitelinks: 40, mediaType: 'film_tv', subtype: 'anime_film' }]);
  });

  it('the query names the class and the sitelink floor, with no label join', async () => {
    const { client, queries } = fake({});
    await discover(client, { classes: ['Q7725634'], minSitelinks: 25 });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('wdt:P31 wd:Q7725634');
    expect(queries[0]).not.toContain('rdfs:label');
    expect(queries[0]).not.toContain('LANG(');
    expect(queries[0]).toContain('FILTER(?sl >= 25)');
  });

  it('names the class when its query fails', async () => {
    const client = {
      async sparql() {
        throw new WikidataUnavailable('Wikidata unavailable after 5 tries', 0, 'https://q/x');
      },
      async entities() {
        return {};
      },
    } satisfies WikidataClient;
    const err = await discover(client, { classes: [FILM], minSitelinks: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WikidataUnavailable);
    expect(err).toMatchObject({ status: 0, url: 'https://q/x' });
    expect((err as Error).message).toMatch(/Q11424.*after 5 tries/);
  });

  it('maps literary works to books with no subtype', async () => {
    const { client } = fake({ Q7725634: [row(2, 12)] });
    const out = await discover(client, { classes: ['Q7725634'], minSitelinks: 10 });
    expect(out).toEqual([{ qid: 'Q2', sitelinks: 12, mediaType: 'book', subtype: null }]);
  });

  it('skips rows whose item or sitelinks do not parse', async () => {
    const { client } = fake({
      [FILM]: [
        { item: 'http://www.wikidata.org/entity/L123', sl: '40' },
        { item: 'http://www.wikidata.org/entity/Q8', sl: 'many' },
        { item: 'http://www.wikidata.org/entity/Q9', sl: '' },
        row(3, 20),
      ],
    });
    const out = await discover(client, { classes: [FILM], minSitelinks: 10 });
    expect(out.map((c) => c.qid)).toEqual(['Q3']);
  });

  it('throws on an unknown class', async () => {
    const { client } = fake({});
    await expect(discover(client, { classes: ['Q1'], minSitelinks: 10 })).rejects.toThrow(/Q1/);
  });
});
