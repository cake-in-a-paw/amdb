import { Link } from '@tanstack/react-router';
import { summaryDetail } from '@/components/entry-row';
import type { Credit } from '@/lib/entity';
import { rolesLabel } from '@/lib/labels';
import { creditPartsLabel, partTitle } from '@/lib/parts';
import { linkClass } from '@/lib/styles';

/**
 * One show or film on a creator's page, read like an `EntryRow`: its title, a dotted leader, then
 * every role the creator had at or under it and its media type and year. When they're credited on
 * its parts, a count ("2 seasons, 14 episodes") follows, linking to those credits. A removed root
 * reads "a removed work" and isn't linked. A `<li>`, to sit in a list the caller names.
 */
export function CreditRow({ creatorId, credit }: { creatorId: string; credit: Credit }) {
  const { work, removed, roles, parts } = credit;
  const title = removed ? 'a removed work' : partTitle(work);
  const detail = [rolesLabel(roles), summaryDetail(work)].filter(Boolean).join(' · ');
  const count = creditPartsLabel(parts);
  const line = (
    <>
      <span
        className={
          removed
            ? 'font-serif text-lg leading-snug text-muted-foreground'
            : 'font-serif text-lg leading-snug group-hover:underline group-hover:underline-offset-4'
        }
      >
        {title}
      </span>
      <span aria-hidden="true" className="leader flex-1" />
      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{detail}</span>
    </>
  );
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 border-b border-border/70">
      {removed ? (
        <span className="flex min-h-11 flex-1 items-baseline gap-3 py-2.5">{line}</span>
      ) : (
        <Link
          to="/entities/$id"
          params={{ id: work.id }}
          className="group flex min-h-11 min-w-11 flex-1 items-baseline gap-3 py-2.5 hover:bg-secondary/60"
        >
          {line}
        </Link>
      )}
      {count && (
        <Link
          to="/entities/$id/credits/$workId"
          params={{ id: creatorId, workId: work.id }}
          aria-label={`${count} in ${title}`}
          className={`${linkClass} shrink-0 text-sm`}
        >
          {count}
        </Link>
      )}
    </li>
  );
}
