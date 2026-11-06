import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Outlet, useMatch, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { EntityHeader } from '@/components/entity-header';
import { entryGone, LoadError, Loading, NotFound, Removed } from '@/components/entity-states';
import { moveDrafts } from '@/lib/drafts';
import { entityQueryKey, entityQueryOptions } from '@/lib/entity';

export const Route = createFileRoute('/entities/$id')({ component: EntityLayout });

/**
 * Everything under `/entities/$id`: loads the entry once for the page and its history and its edit
 * form, says so if it is unknown, removed or unreachable, and sends a merged id to the
 * winner. The pages below read the same query from the cache.
 */
function EntityLayout() {
  const { id } = Route.useParams();
  const { api, queryClient } = Route.useRouteContext();
  const router = useRouter();
  const onHistory = useMatch({ from: '/entities/$id/history', shouldThrow: false }) !== undefined;
  const onEdit = useMatch({ from: '/entities/$id/edit', shouldThrow: false }) !== undefined;
  const entity = useQuery(entityQueryOptions(api, id));
  // `fetch` followed the API's 308, so a different id in the answer means this one was merged.
  const winnerId = entity.data && entity.data.id !== id ? entity.data.id : null;

  useEffect(() => {
    if (!winnerId || !entity.data) return;
    queryClient.setQueryData(entityQueryKey(winnerId), entity.data);
    // An edit begun under this id would be stranded here: carry it to the winner, where it is
    // laid over the winner as it is (the form's rebase), like any draft of an entry that changed.
    moveDrafts(`edit.${id}`, `edit.${winnerId}`);
    // Replace, not push: Back shouldn't land on the dead id and bounce forward again.
    // A page under the entry (its history, its edit form) stays on that page for the winner, and
    // the address keeps its query and fragment.
    void router.navigate({
      to: onHistory ? '/entities/$id/history' : onEdit ? '/entities/$id/edit' : '/entities/$id',
      params: { id: winnerId },
      search: true,
      hash: true,
      replace: true,
    });
  }, [winnerId, entity.data, id, onHistory, onEdit, queryClient, router]);

  if (entity.isPending || winnerId) return <Loading what="this entry" />;
  if (entity.isError) {
    const gone = entryGone(entity.error);
    if (gone === 'removed') return <Removed />;
    if (gone === 'not-found') return <NotFound />;
    return <LoadError what="this entry" error={entity.error} onRetry={() => void entity.refetch()} />;
  }
  return (
    <>
      <EntityHeader entity={entity.data} />
      <Outlet />
    </>
  );
}
