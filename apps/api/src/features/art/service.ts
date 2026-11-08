import type { IdScheme } from '@amdb/shared';
import type { Db } from '../../platform/db/types';
import { artRepository } from './repository';
import type { ArtItem } from './schemas';
import { createArtSources, type ArtDeps, type ArtSource, type Lookup } from './sources';

/** The whole request, across every work and source (artwork spec, "Being a good client"). */
const DEADLINE_MS = 3000;
const DAY_MS = 24 * 3600_000;
const FOUND_TTL_MS = 7 * DAY_MS;
const NONE_TTL_MS = DAY_MS;
/** Entries per cache; the oldest written is evicted first. */
const CACHE_LIMIT = 20_000;

/**
 * A size-bounded in-memory cache with per-entry expiry. A Map keeps insertion order, so the first
 * key is the oldest write. This is a cache, not storage: it empties on deploy (spec Production
 * Annotations).
 */
function createCache<V>(now: () => number) {
  const entries = new Map<string, { value: V; expiresAt: number }>();
  return {
    get(key: string): V | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: V, ttlMs: number) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      if (entries.size > CACHE_LIMIT) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
    },
  };
}

type Id = { scheme: IdScheme; value: string };
const NONE: ArtItem = { status: 'none' };
const UNAVAILABLE: ArtItem = { status: 'unavailable' };

/**
 * Resolves works to art linked live from their sources. `deps` omitted means no sources: every
 * work is `none` and nothing is fetched.
 */
export function createArtService(db: Db, deps?: ArtDeps) {
  const repo = artRepository(db);
  const sources: ArtSource[] = deps ? createArtSources(deps) : [];
  const schemes = sources.flatMap((s) => s.schemes);
  const now = deps?.now ?? Date.now;
  /** One source's answer for one of its ids. */
  const lookups = createCache<Lookup>(now);
  /**
   * The resolved answer per work, keyed by the work and the art ids it holds, so a work whose ids
   * change is resolved afresh. The live-work read always runs first, so a removal or merge is
   * never hidden by this cache.
   */
  const resolved = createCache<ArtItem>(now);

  async function lookup(source: ArtSource, id: Id, deadline: number): Promise<Lookup> {
    const key = `${source.name}:${id.scheme}:${id.value}`;
    const cached = lookups.get(key);
    if (cached) return cached;
    const result = await source.lookup(id.scheme, id.value, deadline);
    if (result.status === 'found') lookups.set(key, result, FOUND_TTL_MS);
    else if (result.status === 'none') lookups.set(key, result, NONE_TTL_MS);
    return result;
  }

  /** Tries each source in order; moves on only on `none`, stops at the first `found` or `unavailable`. */
  async function resolveWork(ids: Id[], deadline: number): Promise<ArtItem> {
    for (const source of sources) {
      for (const scheme of source.schemes) {
        for (const id of ids.filter((i) => i.scheme === scheme)) {
          const result = await lookup(source, id, deadline);
          if (result.status === 'found') return { status: 'found', source: source.name, ...result.image };
          if (result.status === 'unavailable') return UNAVAILABLE;
        }
      }
    }
    return NONE;
  }

  return {
    /** Art for each requested id, keyed by the ids as requested. */
    async art(workIds: string[]): Promise<Record<string, ArtItem>> {
      // Uuids compare in lowercase (as Postgres returns them); the response keeps the ids as requested.
      const winners = await repo.liveWorks([...new Set(workIds.map((id) => id.toLowerCase()))]);
      const idsOf = new Map<string, Id[]>();
      for (const row of await repo.externalIds([...new Set(winners.values())], schemes)) {
        idsOf.set(row.workId, [...(idsOf.get(row.workId) ?? []), { scheme: row.scheme, value: row.value }]);
      }

      const deadline = now() + DEADLINE_MS;
      const answerFor = async (workId: string): Promise<ArtItem> => {
        const ids = idsOf.get(workId) ?? [];
        if (ids.length === 0) return NONE;
        const key = `${workId}:${ids.map((i) => `${i.scheme}=${i.value}`).join(',')}`;
        const cached = resolved.get(key);
        if (cached) return cached;
        const item = await resolveWork(ids, deadline);
        if (item.status === 'found') resolved.set(key, item, FOUND_TTL_MS);
        else if (item.status === 'none') resolved.set(key, item, NONE_TTL_MS);
        return item;
      };
      // In parallel across works; a work asked for twice (or through a merged-away id) resolves once.
      const answers = new Map(
        await Promise.all(
          [...new Set(winners.values())].map(async (w): Promise<[string, ArtItem]> => [w, await answerFor(w)]),
        ),
      );

      const items: Record<string, ArtItem> = {};
      for (const id of workIds) {
        const winner = winners.get(id.toLowerCase());
        items[id] = (winner === undefined ? undefined : answers.get(winner)) ?? NONE;
      }
      return items;
    },
  };
}

export type ArtService = ReturnType<typeof createArtService>;
