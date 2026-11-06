import { queryOptions } from '@tanstack/react-query';
import type { ApiClient, paths } from '@amdb/shared/api';
import { unwrap } from './api';

export type ChangeDetail = paths['/api/changes/{id}']['get']['responses'][200]['content']['application/json'];

/** One of the caller's own changes, with its payload and reason; a 404 if it isn't theirs or doesn't exist. */
export const changeQueryOptions = (api: ApiClient, changeId: string) =>
  queryOptions({
    queryKey: ['change', changeId],
    queryFn: async ({ signal }): Promise<ChangeDetail> =>
      unwrap(await api.GET('/api/changes/{id}', { params: { path: { id: changeId } }, signal })),
  });
