import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { createdTitle } from '@/components/change-diff';
import { LoadError, Loading, NotFound } from '@/components/entity-states';
import { LoadMore } from '@/components/load-more';
import { QueueItem } from '@/components/queue-item';
import { unwrap } from '@/lib/api';
import { PAGE_SIZE } from '@/lib/entity';
import { canModerate, meQueryOptions } from '@/lib/me';

export const Route = createFileRoute('/moderation/')({ component: Moderation });

const queueQueryKey = ['moderation-queue'] as const;

function Moderation() {
  const { api, queryClient } = Route.useRouteContext();
  const me = useQuery(meQueryOptions(api));
  const allowed = canModerate(me.data);
  // Only moderators may ask; to everyone else the queue doesn't exist.
  const queue = useInfiniteQuery({
    queryKey: queueQueryKey,
    enabled: allowed,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/moderation/queue', { params: { query: { cursor: pageParam, limit: PAGE_SIZE } }, signal }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  if (me.isPending) return <Loading what="the review queue" />;
  if (!allowed) return <NotFound what="page" />;
  if (queue.isPending) return <Loading what="the review queue" />;
  // A failed "Load more" keeps the pages already loaded; only a failed first load replaces the list.
  if (queue.isError && !queue.data)
    return <LoadError what="the review queue" error={queue.error} onRetry={() => void queue.refetch()} />;

  const entries = queue.data.pages.flatMap((page) => page.items);
  // Entries and changes still waiting in the queue, so a link can name them without another request.
  const titles = new Map<string, string>();
  const changeTitles = new Map<string, string>();
  for (const { change } of entries) {
    const title = createdTitle(change);
    if (change.op !== 'create' || title === null) continue;
    changeTitles.set(change.id, title);
    if (change.entityId) titles.set(change.entityId, title);
  }
  // An approval or rejection changes the queue and, for approvals, what the catalog shows.
  const onReviewed = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queueQueryKey }),
      queryClient.invalidateQueries({ queryKey: ['entity'] }),
    ]);

  return (
    <div className="max-w-3xl py-10">
      <h1 className="font-serif text-3xl font-semibold">Moderation queue</h1>
      {entries.length === 0 ? (
        <p className="mt-4 text-muted-foreground">Nothing is waiting for review.</p>
      ) : (
        <ul aria-label="Review queue" className="mt-4">
          {entries.map((entry) => (
            <QueueItem
              key={entry.change.id}
              entry={entry}
              titles={titles}
              changeTitles={changeTitles}
              onReviewed={onReviewed}
            />
          ))}
        </ul>
      )}
      <LoadMore query={queue} />
    </div>
  );
}
