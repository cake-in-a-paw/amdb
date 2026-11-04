import { queryOptions } from '@tanstack/react-query';
import type { ApiClient, paths } from '@amdb/shared/api';
import { ApiError, unwrap } from './api';

type Detail = paths['/api/submissions/{id}']['get']['responses'][200]['content']['application/json'];
export type ChangeDetail = Detail['changes'][number];

/** Submissions looked through, a page at a time, before giving up on finding a change. */
const MAX_PAGES = 10;

/**
 * One of the caller's own changes, with its payload and reason. The API reads a change through its
 * submission, so this finds the submission in "my submissions" first (a link names only the change).
 */
export const changeQueryOptions = (api: ApiClient, changeId: string) =>
  queryOptions({
    queryKey: ['change', changeId],
    queryFn: async ({ signal }): Promise<ChangeDetail> => {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const mine = unwrap(await api.GET('/api/me/submissions', { params: { query: { cursor, limit: 50 } }, signal }));
        const found = mine.items.find((s) => s.changes.some((c) => c.id === changeId));
        if (found) {
          const detail = unwrap(await api.GET('/api/submissions/{id}', { params: { path: { id: found.id } }, signal }));
          const change = detail.changes.find((c) => c.id === changeId);
          if (change) return change;
        }
        if (!mine.nextCursor) break;
        cursor = mine.nextCursor;
      }
      // Not the caller's, or not there: the same answer the API gives for either.
      throw new ApiError(404, 'not_found', 'No such change');
    },
  });
