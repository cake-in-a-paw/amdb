import { useInfiniteQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useId } from 'react';
import { EntryRow } from '@/components/entry-row';
import { LoadError, Loading } from '@/components/entity-states';
import { LoadMore } from '@/components/load-more';
import { unwrap } from '@/lib/api';
import { rolesLabel } from '@/lib/labels';
import { partLabel } from '@/lib/parts';
import { headingLinkClass } from '@/lib/styles';

const rootRoute = getRouteApi('__root__');

/** How many credits a page of the list asks for, as the parts list does. */
const CREDITS_PAGE_SIZE = 50;

/**
 * A creator's credits at or under one work, in parts order: the work's own credit first, then each
 * credited season and episode, named by its place ("S1E2 · Two") and followed by the roles they
 * had on it. Headed "In <work>"; a removed work reads "a removed work" and isn't linked.
 */
export function CreatorCredits({ creatorId, workId }: { creatorId: string; workId: string }) {
  const { api } = rootRoute.useRouteContext();
  const headingId = useId();
  const credits = useInfiniteQuery({
    queryKey: ['credits', creatorId, workId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/entities/{id}/credits/{workId}', {
          params: { path: { id: creatorId, workId }, query: { cursor: pageParam, limit: CREDITS_PAGE_SIZE } },
          signal,
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  if (credits.isPending) return <Loading what="credits" />;
  if (credits.isError && !credits.data) {
    return <LoadError what="credits" error={credits.error} onRetry={() => void credits.refetch()} />;
  }

  // Every page names the same work; a loaded query has at least one page.
  const under = credits.data.pages[0]?.under;
  const items = credits.data.pages.flatMap((page) => page.items);
  return (
    <section aria-labelledby={headingId} className="py-6">
      <h2 id={headingId} className="border-b border-border pb-2 font-serif text-xl font-semibold">
        In{' '}
        {!under || under.removed ? (
          'a removed work'
        ) : (
          <Link to="/entities/$id" params={{ id: under.work.id }} className={headingLinkClass}>
            {under.work.title}
          </Link>
        )}
      </h2>
      {items.length === 0 ? (
        <p className="py-3 text-muted-foreground">No credits here.</p>
      ) : (
        <ul aria-labelledby={headingId}>
          {items.map(({ work, roles }) => (
            <EntryRow
              key={work.id}
              entry={work}
              title={
                work.part
                  ? [
                      partLabel(work.part.subtype, work.part.position, work.part.ancestors),
                      work.part.subtype === 'season' ? '' : work.title,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : work.title
              }
              detail={rolesLabel(roles)}
            />
          ))}
        </ul>
      )}
      <LoadMore query={credits} />
    </section>
  );
}
