import { useMutation, useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { ChangeDiff, record, type QueueEntry, type Titles } from '@/components/change-diff';
import { EditApproveDialog } from '@/components/edit-approve-dialog';
import { RejectDialog } from '@/components/reject-dialog';
import { Button } from '@/components/ui/button';
import { ApiError, unwrap } from '@/lib/api';
import { entityQueryOptions } from '@/lib/entity';
import { describeError } from '@/lib/errors';
import { fieldLabel } from '@/lib/labels';
import { valueText } from '@/components/history-list';
import { linkClass } from '@/lib/styles';

const rootRoute = getRouteApi('__root__');

/** The anchor id of a queue item, so a message can point at another item. */
export const changeAnchor = (changeId: string) => `change-${changeId}`;

/** Who submitted: their handle, else "contributor" (signed in, no handle), else "anonymous". Never an id. */
export function authorName(author: QueueEntry['submission']['author']): string {
  if (author === 'anonymous') return 'anonymous';
  return author.handle ?? 'contributor';
}

/** How long a change has waited, in the largest whole unit. */
export function ageText(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return unit(Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return unit(Math.floor(seconds / 3600), 'hour');
  return unit(Math.floor(seconds / 86_400), 'day');
}

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** What went wrong approving, with the way forward: the change to approve first, or the field's new value. */
function ApproveError({
  error,
  entry,
  changeTitles,
}: {
  error: unknown;
  entry: QueueEntry;
  changeTitles: ReadonlyMap<string, string>;
}) {
  const { api } = rootRoute.useRouteContext();
  const { change } = entry;
  const code = error instanceof ApiError ? error.code : null;
  const details = error instanceof ApiError ? record(error.details) : {};
  const staleFields = code === 'stale_change' && change.op === 'update' ? stringsOf(details.fields) : [];
  const entity = useQuery({
    ...entityQueryOptions(api, change.entityId ?? ''),
    enabled: staleFields.length > 0 && Boolean(change.entityId),
  });

  if (code === 'dependency_pending') {
    const waiting = stringsOf(details.changeIds);
    return (
      <p role="alert" className="mt-2 text-sm text-destructive">
        {waiting.length === 0 ? (
          'Approve the change this one depends on first.'
        ) : (
          <>
            Approve{' '}
            {waiting.map((id, i) => {
              const title = changeTitles.get(id);
              return (
                <span key={id}>
                  {i > 0 && ' and '}
                  {title === undefined ? (
                    'a change that is further down the queue'
                  ) : (
                    <a href={`#${changeAnchor(id)}`} className={linkClass}>
                      {title}
                    </a>
                  )}
                </span>
              );
            })}{' '}
            first.
          </>
        )}
      </p>
    );
  }
  if (staleFields.length > 0) {
    return (
      <div role="alert" className="mt-2 text-sm text-destructive">
        {staleFields.map((key) => (
          <p key={key}>
            {fieldLabel(key)}: This field changed since the edit was made.
            {entity.data && <> Now: {valueText(entity.data.fields[key] ?? null)}</>}
          </p>
        ))}
      </div>
    );
  }
  return (
    <p role="alert" className="mt-2 text-sm text-destructive">
      {describeError(error, "Couldn't approve this change. Try again.")}
    </p>
  );
}

/** One waiting change: what it would do, who sent it and how long ago, and the three ways to review it. */
export function QueueItem({
  entry,
  titles,
  changeTitles,
  onReviewed,
}: {
  entry: QueueEntry;
  titles: Titles;
  changeTitles: ReadonlyMap<string, string>;
  /** Called with the reviewed change's id once the queue has been told. */
  onReviewed: (changeId: string) => Promise<unknown>;
}) {
  const { api } = rootRoute.useRouteContext();
  const { change } = entry;
  const approve = useMutation({
    mutationFn: async (fields?: Record<string, unknown>) =>
      unwrap(
        await api.POST('/api/changes/{id}/approve', {
          params: { path: { id: change.id } },
          body: fields ? { fields } : {},
        }),
      ),
    onSuccess: () => onReviewed(change.id),
  });
  const canEdit = change.op === 'create' || change.op === 'update';

  return (
    <li id={changeAnchor(change.id)} tabIndex={-1} className="border-b border-border py-4">
      <p className="flex flex-wrap items-baseline gap-x-3 text-sm text-muted-foreground">
        <span>
          From <span className="font-medium text-foreground">{authorName(entry.submission.author)}</span>
        </span>
        <span>Waiting {ageText(entry.ageSeconds)}</span>
      </p>
      <div className="mt-1">
        <ChangeDiff change={change} titles={titles} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={approve.isPending} onClick={() => approve.mutate(undefined)}>
          Approve
        </Button>
        {canEdit && (
          <EditApproveDialog fields={record(change.payload)} onApprove={(fields) => approve.mutateAsync(fields)} />
        )}
        <RejectDialog changeId={change.id} onRejected={() => onReviewed(change.id)} />
      </div>
      {approve.isError && <ApproveError error={approve.error} entry={entry} changeTitles={changeTitles} />}
    </li>
  );
}
