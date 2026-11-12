import { Link } from '@tanstack/react-router';
import { isPartSubtype, type Subtype } from '@amdb/shared';
import type { Ancestor } from '@/lib/parts';
import { linkClass } from '@/lib/styles';

/**
 * Where a work sits in its show: each ancestor, root first, as a link (a removed one in words),
 * then the work itself. A part with no parent says it isn't attached; any other work shows nothing.
 */
export function PartBreadcrumbs({
  title,
  subtype,
  hasParent,
  ancestors,
}: {
  title: string;
  subtype: Subtype | null;
  hasParent: boolean;
  ancestors: Ancestor[];
}) {
  if (!hasParent || ancestors.length === 0) {
    return isPartSubtype(subtype) ? <p className="mb-4 text-sm text-muted-foreground">Not attached to a show</p> : null;
  }
  return (
    <nav aria-label="Part of" className="mb-4 text-sm">
      <ol className="flex flex-wrap items-baseline gap-x-2">
        {ancestors.map((ancestor) => (
          <li key={ancestor.id} className="flex items-baseline gap-x-2">
            {ancestor.removed ? (
              <span className="text-muted-foreground">a removed work</span>
            ) : (
              <Link to="/entities/$id" params={{ id: ancestor.id }} className={linkClass}>
                {ancestor.title}
              </Link>
            )}
            <span aria-hidden="true" className="text-muted-foreground">
              ›
            </span>
          </li>
        ))}
        <li aria-current="page">{title}</li>
      </ol>
    </nav>
  );
}
