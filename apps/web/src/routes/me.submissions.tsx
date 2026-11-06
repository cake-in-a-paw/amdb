import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import type { paths } from '@amdb/shared/api';
import { ChangeStatus } from '@/components/change-status';
import { LoadError } from '@/components/entity-states';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api';
import { meQueryOptions } from '@/lib/me';
import { linkClass } from '@/lib/styles';

export const Route = createFileRoute('/me/submissions')({ component: MySubmissions });

type Page = paths['/api/me/submissions']['get']['responses'][200]['content']['application/json'];
type Submission = Page['items'][number];
type Change = Submission['changes'][number];

function describeChange(change: Change) {
  switch (change.op) {
    case 'create':
      return `New ${change.kind}`;
    case 'update':
      return `Edit: ${change.kind}`;
    case 'relate':
      return 'New link';
    case 'unrelate':
      return 'Removed link';
    case 'merge':
      return 'Merge';
  }
}

function MySubmissions() {
  const { api } = Route.useRouteContext();
  const me = useQuery(meQueryOptions(api));
  // Anonymous visitors see what their browser's token submitted, so wait to learn which this is. A
  // failed lookup isn't an answer: treating it as signed out would show a signed-in person the
  // anonymous view.
  const identity = me.isPending || me.isError ? null : (me.data?.id ?? 'anonymous');
  const submissions = useInfiniteQuery({
    queryKey: ['my-submissions', identity],
    enabled: identity !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(await api.GET('/api/me/submissions', { params: { query: { cursor: pageParam, limit: 20 } }, signal })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = submissions.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="max-w-3xl py-10">
      <h1 className="font-serif text-3xl font-semibold">My submissions</h1>
      {identity === 'anonymous' && (
        <p className="mt-3 text-muted-foreground">
          These are kept in this browser.{' '}
          <Link to="/sign-in" search={{ next: '/me/submissions' }} className={linkClass}>
            Sign in
          </Link>{' '}
          to keep them with an account.
        </p>
      )}
      {me.isError ? (
        <LoadError what="your account" error={me.error} onRetry={() => void me.refetch()} />
      ) : submissions.isPending ? (
        <p role="status" className="mt-4 text-muted-foreground">
          Loading your submissions…
        </p>
      ) : submissions.isError ? (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-3">
          <p>Couldn't load your submissions.</p>
          <Button variant="outline" onClick={() => void submissions.refetch()}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="mt-4">
          <p>You haven’t submitted anything yet.</p>
          <Link to="/submit" className={linkClass}>
            Contribute an entry
          </Link>
        </div>
      ) : (
        <>
          <ul aria-label="Your submissions" className="mt-4">
            {items.map((submission) => (
              <SubmissionItem key={submission.id} submission={submission} />
            ))}
          </ul>
          {submissions.hasNextPage && (
            <Button
              variant="outline"
              className="mt-4"
              disabled={submissions.isFetchingNextPage}
              onClick={() => void submissions.fetchNextPage()}
            >
              Show more
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function SubmissionItem({ submission }: { submission: Submission }) {
  const { api } = Route.useRouteContext();
  const hasRejected = submission.changes.some((c) => c.status === 'rejected');
  // The list has no reasons; a rejected change's reason comes from the submission's detail.
  const detail = useQuery({
    queryKey: ['submission', submission.id],
    enabled: hasRejected,
    queryFn: async ({ signal }) =>
      unwrap(await api.GET('/api/submissions/{id}', { params: { path: { id: submission.id } }, signal })),
  });
  const reasons = new Map(detail.data?.changes.map((c) => [c.id, c.reason]));

  return (
    <li className="border-b border-border py-4">
      <p className="text-sm text-muted-foreground">
        Submitted {new Date(submission.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
      </p>
      {submission.note && <p className="mt-1">{submission.note}</p>}
      <ul className="mt-2">
        {submission.changes.map((change) => (
          <li key={change.id} className="flex flex-wrap items-center gap-x-3 py-1">
            <span className="font-serif text-lg">{describeChange(change)}</span>
            <ChangeStatus status={change.status} reason={reasons.get(change.id)} />
            {change.status === 'rejected' && (
              <Link to="/changes/$id/resubmit" params={{ id: change.id }} className={linkClass}>
                Fix and resubmit
              </Link>
            )}
          </li>
        ))}
      </ul>
      {hasRejected && detail.isError && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't load the reason.
        </p>
      )}
    </li>
  );
}
