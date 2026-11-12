// A fake Wikidata behind the real client, and the fixture builders it needs, shared by the importer tests.
import { createWikidataClient, type WikidataEntity } from '../../src/features/imports/wikidata/client.js';

export const FILM_CLASS = 'Q11424';

// --- Wikidata fixtures, in the wbgetentities shape ---

export const item = (id: string) => ({ 'entity-type': 'item', id });
export const claim = (property: string, value: unknown, ordinal?: string) => ({
  rank: 'normal',
  mainsnak: { snaktype: 'value', property, datavalue: { value } },
  ...(ordinal
    ? { qualifiers: { P1545: [{ snaktype: 'value', property: 'P1545', datavalue: { value: ordinal } }] } }
    : {}),
});

export const person = (id: string, name: string): WikidataEntity =>
  // Built to the WikidataEntity shape; claims are loosely typed here to keep the fixtures short.
  ({ id, labels: { en: { value: name } }, claims: { P31: [claim('P31', item('Q5'))] } }) as WikidataEntity;

/**
 * A real client over a fake `fetch`: SPARQL answers with `candidates`, wbgetentities with
 * `entities` (absent ids come back `missing`). `down(ids)` makes an entity call answer 503;
 * `onEntities(ids)` is awaited before an entity call answers. `sparql(query)`, when given, answers
 * every SPARQL query instead: its rows (each value a binding's `value`) or a response as is.
 */
export function fakeWikidata(
  candidates: { qid: string; sitelinks: number }[],
  entities: Record<string, WikidataEntity>,
  down: (ids: string[]) => boolean = () => false,
  {
    onEntities,
    sparql,
  }: {
    onEntities?: (ids: string[]) => Promise<void>;
    sparql?: (query: string) => Record<string, string>[] | Response;
  } = {},
) {
  const entityCalls: string[][] = [];
  const sparqlCalls: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'query.wikidata.org') {
      const query = url.searchParams.get('query') ?? '';
      sparqlCalls.push(query);
      if (sparql) {
        const answer = sparql(query);
        if (answer instanceof Response) return answer;
        const bindings = answer.map((row) =>
          Object.fromEntries(Object.entries(row).map(([key, value]) => [key, { value }])),
        );
        return Response.json({ results: { bindings } });
      }
      const bindings = query.includes(`wd:${FILM_CLASS}`)
        ? candidates.map((c) => ({
            item: { value: `http://www.wikidata.org/entity/${c.qid}` },
            sl: { value: String(c.sitelinks) },
          }))
        : [];
      return Response.json({ results: { bindings } });
    }
    const ids = (url.searchParams.get('ids') ?? '').split('|');
    entityCalls.push(ids);
    await onEntities?.(ids);
    if (down(ids)) return new Response('', { status: 503 });
    return Response.json({ entities: Object.fromEntries(ids.map((id) => [id, entities[id] ?? { id, missing: '' }])) });
  };
  // The fake implements only the call shape the client uses.
  const client = createWikidataClient({ fetch: fetch as typeof globalThis.fetch, sleep: async () => {} });
  return { client, entityCalls, sparqlCalls };
}
