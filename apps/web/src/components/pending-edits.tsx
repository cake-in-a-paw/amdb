import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { unwrap } from '@/lib/api';
import { meQueryOptions } from '@/lib/me';
import { linkClass } from '@/lib/styles';

const rootRoute = getRouteApi('__root__');

/**
 * Tells the person looking at an entry that an edit of theirs is still waiting for a moderator,
 * found among their submissions' pending changes about this entry. The notice is a courtesy: while
 * it loads, or if it can't be loaded, the entry page simply shows without it.
 *
 * Only the newest 50 submissions are looked through, which holds anything still waiting in
 * practice. A relation to a series or a property is recorded against that series or property, so
 * an edit that only adds one doesn't appear here.
 */
export function PendingEdits({ entityId }: { entityId: string }) {
  const { api } = rootRoute.useRouteContext();
  const me = useQuery(meQueryOptions(api));
  const identity = me.isPending ? null : (me.data?.id ?? 'anonymous');
  const mine = useQuery({
    // Under 'my-submissions' so a new submission refreshes it along with the list.
    queryKey: ['my-submissions', 'pending-edits', identity],
    enabled: identity !== null,
    queryFn: async ({ signal }) =>
      unwrap(await api.GET('/api/me/submissions', { params: { query: { limit: 50 } }, signal })),
  });
  const waiting = (mine.data?.items ?? [])
    .flatMap((submission) => submission.changes)
    .filter((c) => c.entityId === entityId && c.status === 'pending' && c.op !== 'create').length;
  if (waiting === 0) return null;
  return (
    <p role="status" className="mt-4 rounded-md border border-border bg-card p-3">
      {waiting === 1 ? 'Your edit is waiting for review.' : `Your ${waiting} edits are waiting for review.`}{' '}
      <Link to="/me/submissions" className={linkClass}>
        See your submissions
      </Link>
    </p>
  );
}
