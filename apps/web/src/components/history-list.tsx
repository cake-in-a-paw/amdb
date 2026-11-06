import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import type { paths } from '@amdb/shared/api';
import { LoadError, Loading } from '@/components/entity-states';
import { LoadMore } from '@/components/load-more';
import { RedactDialog } from '@/components/redact-dialog';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api';
import { authorName, record, valueText } from '@/lib/change-text';
import { entityQueryKey, PAGE_SIZE } from '@/lib/entity';
import { describeError } from '@/lib/errors';
import { fieldLabel, idSchemeLabels, roleLabel, workLinkLabels } from '@/lib/labels';
import { canModerate, meQueryOptions } from '@/lib/me';

type Page = paths['/api/entities/{id}/history']['get']['responses'][200]['content']['application/json'];
type Item = Page['items'][number];

const rootRoute = getRouteApi('__root__');

const historyQueryKey = (id: string) => ['history', id] as const;

function FieldList({ fields }: { fields: Record<string, unknown> }) {
  return (
    <ul className="mt-1 text-sm">
      {Object.entries(fields).map(([key, value]) => (
        <li key={key}>
          <span className="text-muted-foreground">{fieldLabel(key)}:</span> {valueText(value)}
        </li>
      ))}
    </ul>
  );
}

/** What a relate did, in words. History has the ids but not the names at the other end. */
function describeRelate(payload: Record<string, unknown>): string {
  const data = record(payload.data);
  switch (payload.type) {
    case 'work_creator':
      return `Added a credit${typeof data.role === 'string' ? ` (${roleLabel(data.role)})` : ''}`;
    case 'series_work':
      return `Added to a series${typeof data.position === 'number' ? ` at no. ${data.position}` : ''}`;
    case 'property_work':
      return 'Added to a property';
    case 'work_tag':
      return 'Added a tag';
    case 'work_link': {
      const type = data.linkType as keyof typeof workLinkLabels | undefined;
      return `Linked to another work${type && workLinkLabels[type] ? ` (${workLinkLabels[type].outgoing})` : ''}`;
    }
    case 'external_id': {
      const scheme = data.scheme as keyof typeof idSchemeLabels | undefined;
      return `Added an identifier${scheme && idSchemeLabels[scheme] ? ` (${idSchemeLabels[scheme]})` : ''}`;
    }
    default:
      return 'Added a link';
  }
}

/** What a change did, in words, with the fields it set. */
function ChangeSummary({ item }: { item: Extract<Item, { payload: unknown }> }) {
  if (item.revertOf) return <p>Reverted an earlier change</p>;
  switch (item.op) {
    case 'create':
      return (
        <>
          <p>Created the entry</p>
          <FieldList fields={item.payload} />
        </>
      );
    case 'update':
      return (
        <>
          <p>Changed</p>
          <FieldList fields={item.payload} />
        </>
      );
    case 'relate':
      return <p>{describeRelate(item.payload)}</p>;
    case 'unrelate':
      return <p>Removed a link</p>;
    case 'merge':
      return <p>Merged another entry into this one</p>;
  }
}

function HistoryItem({
  item,
  entityId,
  canRevert,
  canRedact,
}: {
  item: Item;
  entityId: string;
  canRevert: boolean;
  canRedact: boolean;
}) {
  const { api } = rootRoute.useRouteContext();
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: historyQueryKey(entityId) }),
      queryClient.invalidateQueries({ queryKey: entityQueryKey(entityId) }),
    ]);
  const revert = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST('/api/changes/{id}/revert', { params: { path: { id: item.changeId } } })),
    // The entry and its history both changed: ask again rather than patching either.
    onSuccess: () => refresh(),
  });
  const redacted = 'redacted' in item;
  // A revert can't be reverted; and a redacted change has no content to bring back or take away.
  const revertible = canRevert && !redacted && !item.revertOf;
  // A revert holds nothing to erase, and a redacted change is already erased.
  const redactable = canRedact && !redacted && !item.revertOf;

  return (
    <li className="border-b border-border py-3">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{authorName(item.author)}</span>
        <time dateTime={item.appliedAt}>
          {new Date(item.appliedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
      </p>
      {redacted ? <p>Removed: {item.reason ?? 'no reason given'}</p> : <ChangeSummary item={item} />}
      <div className="mt-2 flex flex-wrap gap-2">
        {revertible && (
          <Button
            variant="outline"
            disabled={revert.isPending}
            aria-label={`Revert: change by ${authorName(item.author)}, ${item.op}`}
            onClick={() => revert.mutate()}
          >
            Revert
          </Button>
        )}
        {redactable && (
          <RedactDialog
            changeId={item.changeId}
            label={`change by ${authorName(item.author)}, ${item.op}`}
            onRedacted={refresh}
          />
        )}
      </div>
      {revert.isError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {describeError(revert.error, "Couldn't revert this change. Try again.")}
        </p>
      )}
    </li>
  );
}

/** An entry's changes, newest first. Moderators can revert. */
export function HistoryList({ entityId }: { entityId: string }) {
  const { api } = rootRoute.useRouteContext();
  const me = useQuery(meQueryOptions(api));
  const canRevert = canModerate(me.data);
  const canRedact = me.data?.role === 'admin';
  const history = useInfiniteQuery({
    queryKey: historyQueryKey(entityId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/entities/{id}/history', {
          params: { path: { id: entityId }, query: { cursor: pageParam, limit: PAGE_SIZE } },
          signal,
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  if (history.isPending) return <Loading what="the history" />;
  // A failed "Load more" keeps the pages already loaded; only a failed first load replaces the list.
  if (history.isError && !history.data)
    return <LoadError what="the history" error={history.error} onRetry={() => void history.refetch()} />;
  const items = history.data.pages.flatMap((page) => page.items);
  return (
    <section aria-labelledby="history-heading" className="py-6">
      <h2 id="history-heading" className="font-serif text-xl font-semibold">
        History
      </h2>
      {items.length === 0 ? (
        <p className="py-3 text-muted-foreground">No changes yet.</p>
      ) : (
        <ul aria-labelledby="history-heading">
          {items.map((item) => (
            <HistoryItem
              key={item.changeId}
              item={item}
              entityId={entityId}
              canRevert={canRevert}
              canRedact={canRedact}
            />
          ))}
        </ul>
      )}
      <LoadMore query={history} />
    </section>
  );
}
