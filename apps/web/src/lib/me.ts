import { queryOptions, useQuery } from '@tanstack/react-query';
import type { ApiClient } from '@amdb/shared/api';
import { ApiError, unwrap } from './api';

export const meQueryKey = ['me'] as const;

/**
 * Who is signed in, as the API sees it: the account, or `null` when signed out. Browsing is public,
 * so a 401 here is an answer, not an error.
 */
export const meQueryOptions = (api: ApiClient) =>
  queryOptions({
    queryKey: meQueryKey,
    queryFn: async ({ signal }) => {
      try {
        return unwrap(await api.GET('/api/me', { signal }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });

/** Moderators and admins review changes. */
export const canModerate = (me: { role: string } | null | undefined): boolean =>
  me?.role === 'moderator' || me?.role === 'admin';

/**
 * Whose work this browser is doing: the signed-in account's id or `'anonymous'`, once known.
 * `identity` is `null` until then. A failed lookup isn't an answer: treating it as signed out would
 * open the anonymous draft or list, which may be someone else's on a shared browser, so `error` is
 * set until Try again (`retry`) succeeds. A failed background refetch keeps the identity already
 * known.
 */
export function useIdentity(api: ApiClient): { identity: string | null; error: unknown; retry: () => void } {
  // A lookup that already failed (the submit loader's) isn't retried just because a page mounted:
  // the page says so at once and offers Try again, rather than spinning through the backoff.
  const me = useQuery({ ...meQueryOptions(api), retryOnMount: false });
  const identity = me.data === undefined ? null : (me.data?.id ?? 'anonymous');
  return {
    identity,
    error: identity === null && me.isError ? me.error : null,
    retry: () => void me.refetch(),
  };
}
