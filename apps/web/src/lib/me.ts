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
 * Whose work this browser is doing: the signed-in account's id, or `'anonymous'`; `null` until
 * that is known. If the account can't be read, the browser is treated as signed out.
 */
export function useIdentity(api: ApiClient): string | null {
  const me = useQuery(meQueryOptions(api));
  return me.isPending ? null : (me.data?.id ?? 'anonymous');
}
