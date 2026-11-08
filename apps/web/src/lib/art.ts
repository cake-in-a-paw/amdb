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

type Waiter = { resolve: (item: ArtItem) => void; reject: (error: unknown) => void };
const pending = new WeakMap<ApiClient, Map<string, Waiter[]>>();

/**
 * One id's art. Ids asked for in the same tick go out together, in requests of at most 50, so a
 * list of works costs one request however many rows ask. Each id is its own query, so a list that
 * grows keeps the art it has and asks only for the new ids.
 */
function loadArt(api: ApiClient, id: string): Promise<ArtItem> {
  return new Promise((resolve, reject) => {
    let batch = pending.get(api);
    if (!batch) {
      const mine = new Map<string, Waiter[]>();
      batch = mine;
      pending.set(api, mine);
      void Promise.resolve().then(() => {
        pending.delete(api);
        return flush(api, mine);
      });
    }
    batch.set(id, [...(batch.get(id) ?? []), { resolve, reject }]);
  });
}

async function flush(api: ApiClient, batch: Map<string, Waiter[]>) {
  const ids = [...batch.keys()];
  const sends: Promise<void>[] = [];
  for (let i = 0; i < ids.length; i += MAX_IDS) {
    const chunk = ids.slice(i, i + MAX_IDS);
    sends.push(
      (async () => {
        try {
          const { items } = unwrap(await api.GET('/api/art', { params: { query: { works: chunk.join(',') } } }));
          for (const id of chunk) {
            const item = items[id];
            for (const waiter of batch.get(id) ?? []) {
              if (item) waiter.resolve(item);
              else waiter.reject(new Error('The art answer left out a work'));
            }
          }
        } catch (error) {
          for (const id of chunk) for (const waiter of batch.get(id) ?? []) waiter.reject(error);
        }
      })(),
    );
  }
  await Promise.all(sends);
}

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
  const ids = [...new Set(workIds)];
  const first = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['art', id],
      queryFn: () => loadArt(api, id),
      staleTime: STALE_MS,
    })),
  });
  const items = new Map<string, ArtItem | undefined>(ids.map((id, i) => [id, first[i]?.data]));

  const unavailable = ids.filter((id) => items.get(id)?.status === 'unavailable');
  const second = useQueries({
    queries: unavailable.map((id) => ({
      queryKey: ['art', 'retry', id],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        await delay(RETRY_AFTER_MS, signal);
        return loadArt(api, id);
      },
      staleTime: STALE_MS,
    })),
  });
  unavailable.forEach((id, i) => {
    const again = second[i]?.data;
    if (again) items.set(id, again);
  });
  return items;
}
