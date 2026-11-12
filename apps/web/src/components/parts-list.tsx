import { useInfiniteQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useId } from 'react';
import { EntryRow } from '@/components/entry-row';
import { LoadError, Loading } from '@/components/entity-states';
import { LoadMore } from '@/components/load-more';
import { unwrap } from '@/lib/api';
import { type Ancestor, partLabel } from '@/lib/parts';

const rootRoute = getRouteApi('__root__');

/** How many parts a page of the list asks for: a season's episodes usually fit in one. */
const PARTS_PAGE_SIZE = 50;

/**
 * A work's seasons and episodes, in parts order, each named by its place ("Season 2",
 * "S2E1 · Pilot"). `ancestors` ends with the work itself, so an episode is numbered by its season.
 */
export function PartsList({
  workId,
  partCount,
  ancestors,
}: {
  workId: string;
  partCount: number;
  ancestors: Ancestor[];
}) {
  const { api } = rootRoute.useRouteContext();
  const headingId = useId();
  const parts = useInfiniteQuery({
    queryKey: ['parts', workId],
    enabled: partCount > 0,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/entities/{id}/parts', {
          params: { path: { id: workId }, query: { cursor: pageParam, limit: PARTS_PAGE_SIZE } },
          signal,
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  if (partCount === 0) return null;
  if (parts.isPending) return <Loading what="seasons and episodes" />;
  if (parts.isError && !parts.data) {
    return <LoadError what="seasons and episodes" error={parts.error} onRetry={() => void parts.refetch()} />;
  }

  const items = parts.data.pages.flatMap((page) => page.items);
  if (items.length === 0) return null;
  const heading = items.every((item) => item.subtype === 'season')
    ? 'Seasons'
    : items.every((item) => item.subtype === 'episode')
      ? 'Episodes'
      : 'Seasons and episodes';
  return (
    <section aria-labelledby={headingId} className="mt-8">
      <h2 id={headingId} className="border-b border-border pb-2 font-serif text-xl font-semibold">
        {heading}
      </h2>
      <ul aria-labelledby={headingId}>
        {items.map((item) => (
          <EntryRow
            key={item.relationId}
            entry={item.work}
            title={[partLabel(item.subtype, item.position, ancestors), item.subtype === 'season' ? '' : item.work.title]
              .filter(Boolean)
              .join(' · ')}
          />
        ))}
      </ul>
      <LoadMore query={parts} />
    </section>
  );
}
