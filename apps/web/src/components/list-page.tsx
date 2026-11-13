import { useId } from 'react';
import { CreditRow } from '@/components/credit-row';
import { RelatedWorks } from '@/components/related-works';
import { summaryDetail } from '@/components/entry-row';
import { type EntityView } from '@/lib/entity';
import { creatorKindLabels, tagKindLabels } from '@/lib/labels';
import type { CreatorKind, TagKind } from '@amdb/shared';

/** What kind of creator or tag this is, when it has one to say. */
function subtitle(entity: EntityView): string | null {
  const { kind: entryKind, fields } = entity;
  if (entryKind === 'creator') return creatorKindLabels[fields.kind as CreatorKind];
  if (entryKind === 'tag') return tagKindLabels[fields.kind as TagKind];
  return null;
}

/**
 * A creator, series, property or tag: its description and the works under it. A creator lists
 * each show or film once, with every role they had there; a series lists its works by position;
 * the rest are already in the API's order.
 */
export function ListPage({ entity }: { entity: EntityView }) {
  const sub = subtitle(entity);
  const description = typeof entity.fields.description === 'string' ? entity.fields.description : null;

  return (
    <div className="py-6">
      {sub && <p className="text-muted-foreground">{sub}</p>}
      {description && <p className="mt-2 max-w-prose leading-relaxed">{description}</p>}
      {entity.kind === 'creator' ? <CreatorWorks entity={entity} /> : <Works entity={entity} />}
    </div>
  );
}

/** A creator's credits, one row per show or film, in the API's order. */
function CreatorWorks({ entity }: { entity: EntityView }) {
  const headingId = useId();
  const credits = entity.relations.credits ?? [];
  return (
    <section aria-labelledby={headingId} className="mt-8">
      <h2 id={headingId} className="border-b border-border pb-2 font-serif text-xl font-semibold">
        Works
      </h2>
      {credits.length === 0 ? (
        <p className="py-3 text-muted-foreground">No works yet.</p>
      ) : (
        <ul aria-labelledby={headingId}>
          {credits.map((credit) => (
            <CreditRow key={credit.work.id} creatorId={entity.id} credit={credit} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The works of a series (by position), a property or a tag. */
function Works({ entity }: { entity: EntityView }) {
  const isSeries = entity.kind === 'series';
  const entries = [...(entity.relations.works ?? [])];
  if (isSeries) entries.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  return (
    <RelatedWorks
      title="Works"
      works={entries.map(({ work, position }) => ({
        entry: work,
        detail: [isSeries && position !== undefined && `No. ${position}`, summaryDetail(work)]
          .filter(Boolean)
          .join(' · '),
      }))}
      empty="No works yet."
    />
  );
}
