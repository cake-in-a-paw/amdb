import { useQuery } from '@tanstack/react-query';
import type { ApiClient, paths } from '@amdb/shared/api';
import { unwrap } from './api';

export type ArtItem = paths['/api/art']['get']['responses'][200]['content']['application/json']['items'][string];

/** How long an `unavailable` answer waits before its one second try. */
const RETRY_AFTER_MS = 5000;
/** Art changes rarely, and the API caches it too. */
const STALE_MS = 5 * 60_000;

async function loadArt(api: ApiClient, id: string, signal: AbortSignal): Promise<ArtItem> {
  const { items } = unwrap(await api.GET('/api/art', { params: { query: { works: id } }, signal }));
  const item = items[id];
  if (!item) throw new Error('The art answer left out the work');
  return item;
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

/** An `unavailable` answer is never reused: the next visit asks again. */
const staleTime = (query: { state: { data: ArtItem | undefined } }) =>
  query.state.data?.status === 'unavailable' ? 0 : STALE_MS;

/**
 * A work's art. `undefined` while it loads (or if the request failed): callers show the
 * placeholder for that, as for `none`. An `unavailable` answer is asked for again once, 5 seconds
 * later, then left alone; a later visit to the page asks afresh.
 */
export function useArt(api: ApiClient, workId: string): ArtItem | undefined {
  const first = useQuery({
    queryKey: ['art', workId],
    queryFn: ({ signal }) => loadArt(api, workId, signal),
    staleTime,
  });
  const second = useQuery({
    queryKey: ['art', 'retry', workId],
    enabled: first.data?.status === 'unavailable',
    queryFn: async ({ signal }) => {
      await delay(RETRY_AFTER_MS, signal);
      return loadArt(api, workId, signal);
    },
    staleTime,
  });
  return first.data?.status === 'unavailable' ? (second.data ?? first.data) : first.data;
}
