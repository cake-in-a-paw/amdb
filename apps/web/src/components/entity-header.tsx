import { Link } from '@tanstack/react-router';
import { entityTitle, type EntityView } from '@/lib/entity';
import { kindLabels } from '@/lib/labels';
import { linkClass } from '@/lib/styles';

/** The title of an entry, its kind, and the ways to look at it: the entry, its history, an edit. */
export function EntityHeader({ entity }: { entity: EntityView }) {
  const title = entityTitle(entity);
  return (
    <header className="border-b border-border pt-8 pb-3">
      <p className="text-sm text-muted-foreground">{kindLabels[entity.kind].singular}</p>
      <h1 className="font-serif text-3xl leading-tight font-semibold text-balance sm:text-4xl">{title}</h1>
      <nav aria-label="This entry" className="-ml-1 flex flex-wrap gap-x-4">
        <Link
          to="/entities/$id"
          params={{ id: entity.id }}
          activeOptions={{ exact: true }}
          className={linkClass}
          activeProps={{ 'aria-current': 'page' }}
        >
          Entry
        </Link>
        <Link
          to="/entities/$id/history"
          params={{ id: entity.id }}
          className={linkClass}
          activeProps={{ 'aria-current': 'page' }}
        >
          History
        </Link>
        <Link
          to="/entities/$id/edit"
          params={{ id: entity.id }}
          className={linkClass}
          activeProps={{ 'aria-current': 'page' }}
        >
          Edit
        </Link>
      </nav>
    </header>
  );
}
