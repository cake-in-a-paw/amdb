import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { createdTitle } from '@/components/change-diff';
import { LoadError, Loading, NotFound } from '@/components/entity-states';
import { LoadMore } from '@/components/load-more';
import { changeAnchor, QueueItem } from '@/components/queue-item';
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

  // After a review the item is gone; focus moves to the next one (or the heading) instead of being lost.
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewed = useRef<{ id: string; next: string | null } | null>(null);
  // Why an item left the queue without this moderator's review (someone else reviewed it first).
  const [notice, setNotice] = useState<string | null>(null);
  const shown = queue.data?.pages.flatMap((page) => page.items) ?? [];
  useEffect(() => {
    const done = reviewed.current;
    if (!done || shown.some((entry) => entry.change.id === done.id)) return;
    reviewed.current = null;
    // After the closing dialog has returned its own focus (to a button that no longer exists).
    setTimeout(() => {
      const next = done.next ? document.getElementById(changeAnchor(done.next)) : null;
      (next ?? heading.current)?.focus();
    }, 0);
  });

  if (me.isPending) return <Loading what="the review queue" />;
  if (me.isError) return <LoadError what="your account" error={me.error} onRetry={() => void me.refetch()} />;
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
  // An approval or rejection changes the queue and, for approvals, what the catalog shows. A
  // `note` says why the item went when it wasn't this review that took it out.
  const onReviewed = (id: string, note?: string) => {
    setNotice(note ?? null);
    const at = entries.findIndex((entry) => entry.change.id === id);
    reviewed.current = { id, next: (entries[at + 1] ?? entries[at - 1])?.change.id ?? null };
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: queueQueryKey }),
      queryClient.invalidateQueries({ queryKey: ['entity'] }),
    ]);
  };

  return (
    <div className="max-w-3xl py-10">
      <h1 ref={heading} tabIndex={-1} className="font-serif text-3xl font-semibold">
        Moderation queue
      </h1>
      {notice && (
        <p role="status" className="mt-4 rounded-md border border-border bg-card p-3">
          {notice}
        </p>
      )}
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
