// Polite Wikidata client: serial requests, spaced, bounded retries. Never touches the database.

const USER_AGENT = 'AMDB-importer/0.1 (https://github.com/cake-in-a-paw/amdb)';
const SPARQL_URL = 'https://query.wikidata.org/sparql';
const ENTITY_URL = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&maxlag=5';
const MAX_IDS = 50;
const MIN_GAP_MS = 500;
const ENTITY_TIMEOUT_MS = 30_000;
// The query service enforces its own 60 s limit; this one only guards against a hang past it.
const SPARQL_TIMEOUT_MS = 65_000;
const MAX_TRIES = 5;
const MAX_WAIT_MS = 120_000;
const BACKOFF_MS = [5000, 10_000, 20_000, 40_000];

export class WikidataUnavailable extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'WikidataUnavailable';
  }
}

export type SparqlRow = Record<string, string>;

export interface Snak {
  // Narrowed per property by the mapping layer.
  datavalue?: { value: unknown; type?: string };
  snaktype?: string;
  property?: string;
}
export interface Claim {
  mainsnak: Snak;
  qualifiers?: Record<string, Snak[]>;
  rank?: string;
}
export interface WikidataEntity {
  id: string;
  labels?: Record<string, { value: string; language?: string }>;
  descriptions?: Record<string, { value: string; language?: string }>;
  claims?: Record<string, Claim[]>;
  sitelinks?: Record<string, { title: string; site?: string }>;
}

export interface WikidataClient {
  sparql(query: string): Promise<SparqlRow[]>;
  entities(ids: string[]): Promise<Record<string, WikidataEntity>>;
}

export interface WikidataClientDeps {
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Injectable so tests can assert the 30 s timeout. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

export function createWikidataClient(deps: WikidataClientDeps): WikidataClient {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  let lastStart: number | undefined;

  // Retry-After is delta-seconds or an HTTP-date; empty/unparsable counts as absent. Capped so a
  // hostile or buggy header cannot park the importer.
  const retryDelay = (res: Response | undefined, attempt: number): number => {
    const raw = res?.headers.get('retry-after')?.trim();
    let ms: number | undefined;
    if (raw) {
      const secs = Number(raw);
      if (Number.isFinite(secs)) ms = secs * 1000;
      else {
        const date = Date.parse(raw);
        if (!Number.isNaN(date)) ms = date - now();
      }
    }
    return Math.min(MAX_WAIT_MS, Math.max(0, ms ?? BACKOFF_MS[attempt] ?? 40_000));
  };

  const discard = async (res: Response) => {
    // Free the connection; a failed cancel changes nothing about the outcome.
    await res.body?.cancel().catch(() => {});
  };

  // Serial by contract (callers await each call); returns the parsed JSON body.
  async function request(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
    let lastStatus = 0;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      if (lastStart !== undefined) {
        const wait = MIN_GAP_MS - (now() - lastStart);
        if (wait > 0) await sleep(wait);
      }
      lastStart = now();

      let res: Response | undefined;
      try {
        res = await deps.fetch(url, {
          headers: { 'User-Agent': USER_AGENT, ...headers },
          signal: timeoutSignal(timeoutMs),
        });
        if (res.status === 429 || res.status === 503) {
          lastStatus = res.status;
          await discard(res);
        } else if (!res.ok) {
          await discard(res);
          throw new WikidataUnavailable(`Wikidata responded ${res.status}`, res.status, url);
        } else {
          const body: unknown = await res.json();
          // The Action API reports replication lag as an HTTP 200 error body; other error bodies are final.
          const error = (body as { error?: { code?: string } } | null)?.error;
          if (!error) return body;
          if (error.code !== 'maxlag') {
            throw new WikidataUnavailable(`Wikidata error: ${error.code ?? 'unknown'}`, res.status, url);
          }
          lastStatus = res.status;
        }
      } catch (e) {
        if (e instanceof WikidataUnavailable) throw e;
        // Network/DNS failure, timeout, or an unparsable 200 body: all retryable, reported as status 0.
        lastStatus = 0;
        res = undefined;
      }
      if (attempt === MAX_TRIES - 1) {
        throw new WikidataUnavailable(`Wikidata unavailable after ${MAX_TRIES} tries`, lastStatus, url);
      }
      await sleep(retryDelay(res, attempt));
    }
    // Unreachable: the loop returns or throws on its last try.
    throw new WikidataUnavailable('Wikidata unavailable', 0, url);
  }

  return {
    async sparql(query) {
      const url = `${SPARQL_URL}?${new URLSearchParams({ query, format: 'json' })}`;
      // Shape is fixed by the SPARQL results JSON spec; we only read bindings.
      const body = (await request(url, { Accept: 'application/sparql-results+json' }, SPARQL_TIMEOUT_MS)) as {
        results?: { bindings?: Array<Record<string, { value: string }>> };
      } | null;
      if (!body?.results?.bindings)
        throw new WikidataUnavailable('Wikidata returned an unexpected SPARQL body', 200, url);
      return body.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
    },

    async entities(ids) {
      if (ids.length > MAX_IDS) throw new Error(`entities() takes at most ${MAX_IDS} ids, got ${ids.length}`);
      if (ids.length === 0) return {};
      const params = new URLSearchParams({
        ids: ids.join('|'),
        props: 'labels|descriptions|claims|sitelinks',
        languages: 'en',
      });
      // Shape follows wbgetentities; `missing` marks absent entities, `redirects` a followed redirect.
      const url = `${ENTITY_URL}&${params}`;
      const body = (await request(url, {}, ENTITY_TIMEOUT_MS)) as {
        entities?: Record<string, WikidataEntity & { missing?: unknown; redirects?: { from: string; to: string } }>;
      } | null;
      if (!body?.entities) throw new WikidataUnavailable('Wikidata returned an unexpected entities body', 200, url);
      const found = Object.values(body.entities).filter((e) => e.missing === undefined);
      // A redirected request comes back under the target id; re-key it by the id that was asked for.
      const byKey = new Map<string, WikidataEntity>();
      for (const e of found) {
        byKey.set(e.id, e);
        if (e.redirects) byKey.set(e.redirects.from, e);
      }
      const out: Record<string, WikidataEntity> = {};
      for (const id of ids) {
        const e = byKey.get(id);
        if (e) out[id] = e;
      }
      return out;
    },
  };
}
