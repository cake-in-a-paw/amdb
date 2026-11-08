// Polite clients for the sites AMDB links art from (artwork spec, "Resolving a work's art").
// Each has a timeout, its own rate limit and honors Retry-After (constitution II). They never
// touch the database and never log: a TMDB URL carries the API key.
import type { IdScheme } from '@amdb/shared';
import { z } from 'zod';
import { createOutboundLimit, retryAfterMs, type OutboundLimit } from '../../platform/http/outbound-limit';

export type ArtImage = { thumb: string; full: string; link: string };
/** The sites art is linked from, in the order they are tried. */
export const SOURCE_NAMES = ['tmdb', 'openlibrary', 'anilist'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];
export type Lookup = { status: 'found'; image: ArtImage } | { status: 'none' } | { status: 'unavailable' };

export interface ArtSource {
  name: SourceName;
  schemes: readonly IdScheme[];
  lookup(scheme: IdScheme, value: string, deadline: number): Promise<Lookup>;
}

export interface ArtDeps {
  fetch: typeof fetch;
  /** TMDB v3 API key. Unset means every TMDB lookup is unavailable. Never logged. */
  tmdbApiKey?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const USER_AGENT = 'AMDB/0.1 (https://github.com/cake-in-a-paw/amdb)';
/** The longest one call may take; the request's overall deadline can cut it shorter. */
const CALL_TIMEOUT_MS = 3000;
/** How long a source is left alone after a 429 or 503 that names no `Retry-After`. */
const DEFAULT_BACKOFF_MS = 60_000;

const NONE: Lookup = { status: 'none' };
const UNAVAILABLE: Lookup = { status: 'unavailable' };
const found = (image: ArtImage): Lookup => ({ status: 'found', image });

/** An `https` URL, as image hosts return them. */
const HttpsUrl = z.url({ protocol: /^https$/ });

/**
 * One outbound call under `limit`, within `deadline`. Returns the response, or null when the
 * source is unavailable: no slot in time, blocked, a network error or timeout, or a 429/503 (which
 * also blocks the source for its `Retry-After`).
 */
async function call(
  deps: Required<Pick<ArtDeps, 'fetch' | 'now'>>,
  limit: OutboundLimit,
  url: string,
  init: RequestInit,
  deadline: number,
): Promise<Response | null> {
  if (!(await limit.acquire(deadline))) return null;
  const timeout = Math.min(CALL_TIMEOUT_MS, deadline - deps.now());
  if (timeout <= 0) return null;
  let res: Response;
  try {
    res = await deps.fetch(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...init.headers },
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    // A network failure or the timeout: the source is unavailable. The error is dropped, not
    // logged or rethrown, because its message may carry the URL and so the TMDB key.
    return null;
  }
  if (res.status === 429 || res.status === 503) {
    await discard(res);
    limit.blockUntil(deps.now() + (retryAfterMs(res.headers.get('retry-after'), deps.now()) ?? DEFAULT_BACKOFF_MS));
    return null;
  }
  return res;
}

async function discard(res: Response) {
  // Frees the connection; a failed cancel changes nothing about the outcome.
  await res.body?.cancel().catch(() => {});
}

/** The body parsed by `schema`, or undefined when it isn't JSON of that shape. */
async function parse<T extends z.ZodType>(res: Response, schema: T): Promise<z.infer<T> | undefined> {
  try {
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Not JSON: the caller reports the source unavailable.
    return undefined;
  }
}

const TMDB_IMAGES = 'https://image.tmdb.org/t/p/';
const TmdbBody = z.object({
  poster_path: z
    .string()
    .regex(/^\/[\w.-]+$/)
    .nullable()
    .optional(),
});

function tmdb(deps: Required<Pick<ArtDeps, 'fetch' | 'now'>> & ArtDeps, limit: OutboundLimit): ArtSource {
  return {
    name: 'tmdb',
    schemes: ['tmdb_movie', 'tmdb_tv'],
    async lookup(scheme, value, deadline) {
      if (!deps.tmdbApiKey) return UNAVAILABLE;
      if (!/^[1-9]\d*$/.test(value)) return NONE;
      const kind = scheme === 'tmdb_tv' ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/${kind}/${value}?${new URLSearchParams({ api_key: deps.tmdbApiKey })}`;
      const res = await call(deps, limit, url, {}, deadline);
      if (!res) return UNAVAILABLE;
      if (res.status === 404) {
        await discard(res);
        return NONE;
      }
      if (!res.ok) {
        await discard(res);
        return UNAVAILABLE;
      }
      const body = await parse(res, TmdbBody);
      if (!body) return UNAVAILABLE;
      if (!body.poster_path) return NONE;
      return found({
        thumb: `${TMDB_IMAGES}w154${body.poster_path}`,
        full: `${TMDB_IMAGES}w500${body.poster_path}`,
        link: `https://www.themoviedb.org/${kind}/${value}`,
      });
    },
  };
}

const OlWorkBody = z.object({ covers: z.array(z.number().int()).optional() });

function openLibrary(deps: Required<Pick<ArtDeps, 'fetch' | 'now'>>, limit: OutboundLimit): ArtSource {
  const covers = 'https://covers.openlibrary.org/b';
  return {
    name: 'openlibrary',
    schemes: ['openlibrary'],
    async lookup(_scheme, value, deadline) {
      if (/^OL[1-9]\d*M$/.test(value)) {
        // `default=false` makes a missing cover a 404. HEAD, so no image bytes come through AMDB.
        const res = await call(
          deps,
          limit,
          `${covers}/olid/${value}-M.jpg?default=false`,
          { method: 'HEAD' },
          deadline,
        );
        if (!res) return UNAVAILABLE;
        await discard(res);
        if (res.status === 404) return NONE;
        if (!res.ok) return UNAVAILABLE;
        return found({
          thumb: `${covers}/olid/${value}-M.jpg`,
          full: `${covers}/olid/${value}-L.jpg`,
          link: `https://openlibrary.org/books/${value}`,
        });
      }
      if (/^OL[1-9]\d*W$/.test(value)) {
        const res = await call(deps, limit, `https://openlibrary.org/works/${value}.json`, {}, deadline);
        if (!res) return UNAVAILABLE;
        if (res.status === 404) {
          await discard(res);
          return NONE;
        }
        if (!res.ok) {
          await discard(res);
          return UNAVAILABLE;
        }
        const body = await parse(res, OlWorkBody);
        if (!body) return UNAVAILABLE;
        // Open Library marks a removed cover as -1.
        const coverId = body.covers?.[0];
        if (coverId === undefined || coverId <= 0) return NONE;
        return found({
          thumb: `${covers}/id/${coverId}-M.jpg`,
          full: `${covers}/id/${coverId}-L.jpg`,
          link: `https://openlibrary.org/works/${value}`,
        });
      }
      // An author id or anything else has no cover here.
      return NONE;
    },
  };
}

const ANILIST_QUERY = 'query ($id: Int) { Media(id: $id, type: ANIME) { coverImage { medium large } } }';
const AniListBody = z.object({
  data: z
    .object({
      Media: z
        .object({ coverImage: z.object({ medium: HttpsUrl.nullish(), large: HttpsUrl.nullish() }).nullish() })
        .nullish(),
    })
    .nullish(),
  errors: z.array(z.object({ status: z.number().optional() })).optional(),
});

function aniList(deps: Required<Pick<ArtDeps, 'fetch' | 'now'>>, limit: OutboundLimit): ArtSource {
  return {
    name: 'anilist',
    schemes: ['anilist'],
    async lookup(_scheme, value, deadline) {
      if (!/^[1-9]\d{0,9}$/.test(value)) return NONE;
      const res = await call(
        deps,
        limit,
        'https://graphql.anilist.co',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: ANILIST_QUERY, variables: { id: Number(value) } }),
        },
        deadline,
      );
      if (!res) return UNAVAILABLE;
      // An unknown id is a 404 carrying a GraphQL error of status 404; anything else failing is unavailable.
      if (!res.ok && res.status !== 404) {
        await discard(res);
        return UNAVAILABLE;
      }
      const body = await parse(res, AniListBody);
      if (!body) return UNAVAILABLE;
      const notFound = body.errors?.some((e) => e.status === 404) ?? false;
      if (body.errors?.length && !notFound) return UNAVAILABLE;
      const cover = body.data?.Media?.coverImage;
      const thumb = cover?.medium ?? cover?.large;
      const full = cover?.large ?? cover?.medium;
      if (!thumb || !full) return NONE;
      return found({ thumb, full, link: `https://anilist.co/anime/${value}` });
    },
  };
}

/** The art sources in the order they are tried: TMDB, then Open Library, then AniList. */
export function createArtSources(deps: ArtDeps): ArtSource[] {
  const now = deps.now ?? Date.now;
  const resolved = { ...deps, now };
  const limitOf = (limit: number, intervalMs: number) =>
    createOutboundLimit({ limit, intervalMs, now, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  return [
    tmdb(resolved, limitOf(20, 1000)),
    openLibrary(resolved, limitOf(5, 1000)),
    // Under AniList's degraded 30 a minute (normally 90).
    aniList(resolved, limitOf(20, 60_000)),
  ];
}
