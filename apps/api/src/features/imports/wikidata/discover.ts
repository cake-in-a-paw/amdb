import type { MediaType, Subtype } from '@amdb/shared';
import type { WikidataClient } from './client.js';

export interface Candidate {
  qid: string;
  sitelinks: number;
  mediaType: MediaType;
  subtype: Subtype | null;
}

interface WikidataClass {
  qid: string;
  mediaType: MediaType;
  subtype: Subtype | null;
}

// Precedence order: an item in several classes takes the first one listed (anime beats plain film/TV).
export const CLASSES: readonly WikidataClass[] = [
  { qid: 'Q20650540', mediaType: 'film_tv', subtype: 'anime_film' },
  { qid: 'Q63952888', mediaType: 'film_tv', subtype: 'anime_series' },
  { qid: 'Q11424', mediaType: 'film_tv', subtype: 'movie' },
  { qid: 'Q5398426', mediaType: 'film_tv', subtype: 'series' },
  { qid: 'Q7725634', mediaType: 'book', subtype: null },
];

const query = (classQid: string, minSitelinks: number) =>
  `SELECT ?item ?sl WHERE { ?item wdt:P31 wd:${classQid}; wikibase:sitelinks ?sl; rdfs:label ?l. ` +
  `FILTER(LANG(?l)="en") FILTER(?sl >= ${minSitelinks}) }`;

const qidNumber = (qid: string) => Number(qid.slice(1));

export async function discover(
  client: WikidataClient,
  opts: { classes: string[]; minSitelinks: number },
): Promise<Candidate[]> {
  for (const q of opts.classes) {
    if (!CLASSES.some((c) => c.qid === q)) throw new Error(`Unknown Wikidata class ${q}`);
  }
  const wanted = CLASSES.filter((c) => opts.classes.includes(c.qid));
  const byQid = new Map<string, Candidate>();
  // Serial: the client is serial by contract. Earlier (higher-precedence) classes win duplicates.
  for (const cls of wanted) {
    for (const row of await client.sparql(query(cls.qid, opts.minSitelinks))) {
      const qid = row.item?.split('/').pop() ?? '';
      const sitelinks = Number(row.sl);
      if (!/^Q\d+$/.test(qid) || !row.sl || !Number.isFinite(sitelinks)) continue;
      if (!byQid.has(qid)) byQid.set(qid, { qid, sitelinks, mediaType: cls.mediaType, subtype: cls.subtype });
    }
  }
  return [...byQid.values()].sort((a, b) => b.sitelinks - a.sitelinks || qidNumber(a.qid) - qidNumber(b.qid));
}
