import { useQueries } from '@tanstack/react-query';
import type { ApiClient, paths } from '@amdb/shared/api';
import { unwrap } from './api';

export type ArtItem = paths['/api/art']['get']['responses'][200]['content']['application/json']['items'][string];

/** The API takes at most this many ids per request. */
const MAX_IDS = 50;
/** How long an `unavailable` id waits before its one second try. */
const RETRY_AFTER_MS = 5000;
/** Art changes rarely, and the API caches it too. */
const STALE_MS = 5 * 60_000;

const chunks = (ids: string[]) =>
  Array.from({ length: Math.ceil(ids.length / MAX_IDS) }, (_, i) => ids.slice(i * MAX_IDS, (i + 1) * MAX_IDS));

const fetchArt = async (api: ApiClient, ids: string[], signal: AbortSignal) =>
  unwrap(await api.GET('/api/art', { params: { query: { works: ids.join(',') } }, signal })).items;

/** Resolves after `ms`, or rejects when `signal` aborts, so a closed page leaves no timer behind. */
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/**
 * Art for a list of works, by id. An id maps to `undefined` while it loads (or if the request
 * failed): callers show the placeholder for that, as for `none`. Ids answered `unavailable` are
 * asked for again once, 5 seconds later, then left alone. No ids makes no request.
 */
export function useArt(api: ApiClient, workIds: string[]): Map<string, ArtItem | undefined> {
  const ids = [...new Set(workIds)].sort();
  const first = useQueries({
    queries: chunks(ids).map((chunk) => ({
      queryKey: ['art', chunk],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchArt(api, chunk, signal),
      staleTime: STALE_MS,
    })),
  });
  const items = new Map<string, ArtItem | undefined>(ids.map((id) => [id, undefined]));
  for (const query of first) for (const [id, item] of Object.entries(query.data ?? {})) items.set(id, item);

  const unavailable = ids.filter((id) => items.get(id)?.status === 'unavailable');
  const second = useQueries({
    queries: chunks(unavailable).map((chunk) => ({
      queryKey: ['art', 'retry', chunk],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        await delay(RETRY_AFTER_MS, signal);
        return fetchArt(api, chunk, signal);
      },
      staleTime: STALE_MS,
    })),
  });
  for (const query of second) for (const [id, item] of Object.entries(query.data ?? {})) items.set(id, item);
  return items;
}
