import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { unwrap } from '@/lib/api';
import { useIdentity } from '@/lib/me';
import { linkClass } from '@/lib/styles';

const rootRoute = getRouteApi('__root__');

/**
 * Tells the person looking at an entry that an edit of theirs is still waiting for a moderator:
 * any pending change of theirs that targets the entry, or adds or removes a link at either end of
 * it (a series or property link included). The notice is a courtesy: while it loads, or if it
 * can't be loaded, the entry page simply shows without it.
 */
export function PendingEdits({ entityId }: { entityId: string }) {
  const { api } = rootRoute.useRouteContext();
  const { identity } = useIdentity(api);
  const pending = useQuery({
    // Under 'my-submissions' so a new submission refreshes it along with the list.
    queryKey: ['my-submissions', 'pending-edits', identity, entityId],
    enabled: identity !== null,
    queryFn: async ({ signal }) =>
      unwrap(await api.GET('/api/me/pending', { params: { query: { entityId } }, signal })),
  });
  const waiting = pending.data?.count ?? 0;
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
