import { RelatedWorks } from '@/components/related-works';
import { summaryDetail } from '@/components/entry-row';
import { useArt } from '@/lib/art';
import { type EntityView } from '@/lib/entity';
import { creatorKindLabels, roleLabel, tagKindLabels } from '@/lib/labels';
import { getRouteApi } from '@tanstack/react-router';
import type { CreatorKind, TagKind } from '@amdb/shared';

const rootRoute = getRouteApi('__root__');

/** What kind of creator or tag this is, when it has one to say. */
function subtitle(entity: EntityView): string | null {
  const { kind: entryKind, fields } = entity;
  if (entryKind === 'creator') return creatorKindLabels[fields.kind as CreatorKind];
  if (entryKind === 'tag') return tagKindLabels[fields.kind as TagKind];
  return null;
}

/**
 * A creator, series, property or tag: its description and the works under it. A series lists them
 * by position; the rest are already in the API's order.
 */
export function ListPage({ entity }: { entity: EntityView }) {
  const { api } = rootRoute.useRouteContext();
  const sub = subtitle(entity);
  const description = typeof entity.fields.description === 'string' ? entity.fields.description : null;
  const isSeries = entity.kind === 'series';
  const entries = [...(entity.relations.works ?? [])];
  if (isSeries) entries.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));

  const art = useArt(
    api,
    entries.map(({ work }) => work.id),
  );

  return (
    <div className="py-6">
      {sub && <p className="text-muted-foreground">{sub}</p>}
      {description && <p className="mt-2 max-w-prose leading-relaxed">{description}</p>}
      <RelatedWorks
        title="Works"
        works={entries.map(({ work, role, position }) => ({
          entry: work,
          detail: [
            isSeries && position !== undefined && `No. ${position}`,
            role && roleLabel(role),
            summaryDetail(work),
          ]
            .filter(Boolean)
            .join(' · '),
        }))}
        empty="No works yet."
        art={art}
      />
    </div>
  );
}
