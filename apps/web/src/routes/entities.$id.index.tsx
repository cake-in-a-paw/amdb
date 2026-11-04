import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ListPage } from '@/components/list-page';
import { WorkPage } from '@/components/work-page';
import { entityQueryOptions } from '@/lib/entity';

export const Route = createFileRoute('/entities/$id/')({ component: Entry });

/** The entry itself. The layout above has loaded it, so this reads it from the cache. */
function Entry() {
  const { id } = Route.useParams();
  const { api } = Route.useRouteContext();
  const { data: entity } = useQuery(entityQueryOptions(api, id));
  if (!entity) return null;
  return entity.kind === 'work' ? <WorkPage entity={entity} /> : <ListPage entity={entity} />;
}
