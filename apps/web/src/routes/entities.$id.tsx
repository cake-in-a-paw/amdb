import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Outlet, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { EntityHeader } from '@/components/entity-header';
import { entryGone, LoadError, Loading, NotFound, Removed } from '@/components/entity-states';
import { entityQueryKey, entityQueryOptions } from '@/lib/entity';

export const Route = createFileRoute('/entities/$id')({ component: EntityLayout });

/**
 * Everything under `/entities/$id`: loads the entry once for the page and its history (and, later,
 * its edit form), says so if it is unknown, removed or unreachable, and sends a merged id to the
 * winner. The pages below read the same query from the cache.
 */
function EntityLayout() {
  const { id } = Route.useParams();
  const { api, queryClient } = Route.useRouteContext();
  const router = useRouter();
  const entity = useQuery(entityQueryOptions(api, id));
  // `fetch` followed the API's 308, so a different id in the answer means this one was merged.
  const winnerId = entity.data && entity.data.id !== id ? entity.data.id : null;

  useEffect(() => {
    if (!winnerId || !entity.data) return;
    queryClient.setQueryData(entityQueryKey(winnerId), entity.data);
    // Replace, not push: Back shouldn't land on the dead id and bounce forward again.
    router.history.replace(router.state.location.pathname.replace(id, winnerId) + router.state.location.searchStr);
  }, [winnerId, entity.data, id, queryClient, router]);

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
