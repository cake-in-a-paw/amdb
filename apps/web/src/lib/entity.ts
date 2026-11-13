import { queryOptions } from '@tanstack/react-query';
import type { ApiClient, paths } from '@amdb/shared/api';
import { unwrap } from './api';

export type EntityView = paths['/api/entities/{id}']['get']['responses'][200]['content']['application/json'];
export type Summary = paths['/api/browse']['get']['responses'][200]['content']['application/json']['items'][number];
/** One row of a creator's credits: a show or film, every role they had at or under it, and their part counts. */
export type Credit = NonNullable<EntityView['relations']['credits']>[number];

/** How many entries a list asks for at a time. */
export const PAGE_SIZE = 20;

export const entityQueryKey = (id: string) => ['entity', id] as const;

/**
 * One entry. The API answers a merged id with a 308 that `fetch` follows, so the entity that comes
 * back may carry another id than the one asked for: callers compare the two (`entity.id !== id`).
 */
export const entityQueryOptions = (api: ApiClient, id: string) =>
  queryOptions({
    queryKey: entityQueryKey(id),
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/entities/{id}', { params: { path: { id } }, signal })),
  });

/** The text a person calls an entry: a creator's or tag's `name`, anything else's `title`. */
export function entityTitle(entity: Pick<EntityView, 'fields'>): string {
  const { title, name } = entity.fields;
  return typeof title === 'string' ? title : typeof name === 'string' ? name : 'Untitled';
}
