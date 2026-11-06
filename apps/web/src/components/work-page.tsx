import { Link } from '@tanstack/react-router';
import type { Lifecycle, MediaType, Subtype } from '@amdb/shared';
import type { ReactNode } from 'react';
import { RelatedWorks } from '@/components/related-works';
import { summaryDetail } from '@/components/entry-row';
import { entityTitle, type EntityView } from '@/lib/entity';
import {
  formatReleaseDate,
  idSchemeLabels,
  lifecycleLabels,
  mediaTypeLabels,
  roleLabel,
  subtypeLabels,
  workLinkLabels,
} from '@/lib/labels';
import { headingLinkClass, linkClass } from '@/lib/styles';

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const count = (value: unknown, unit: string) =>
  typeof value === 'number' ? `${value.toLocaleString('en-US')} ${unit}` : null;

/** There are no covers yet (plan 3): the title, set as a book spine would, stands in. */
function CoverPlaceholder({ title }: { title: string }) {
  return (
    <div
      role="img"
      aria-label={`No cover yet for ${title}`}
      className="flex aspect-[2/3] w-40 items-center justify-center rounded-md border border-border bg-secondary p-4 text-center font-serif text-xl leading-snug text-balance text-muted-foreground"
    >
      {title}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-3 border-b border-border/70 py-2">
      <dt className="w-32 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function WorkPage({ entity }: { entity: EntityView }) {
  const { fields, relations } = entity;
  const title = entityTitle(entity);
  const mediaType = fields.mediaType as MediaType | undefined;
  const subtype = fields.subtype as Subtype | null | undefined;
  const lifecycle = fields.lifecycle as Lifecycle | undefined;
  const released = formatReleaseDate(fields.releaseYear, fields.releaseMonth, fields.releaseDay);
  const attributes = (fields.attributes ?? {}) as Record<string, unknown>;
  const facts: { label: string; value: ReactNode }[] = [
    {
      label: 'Type',
      value: [mediaType && mediaTypeLabels[mediaType], subtype && subtypeLabels[subtype]].filter(Boolean).join(', '),
    },
    { label: 'Original title', value: text(fields.originalTitle) },
    { label: 'Release date', value: released },
    { label: 'Status', value: lifecycle && lifecycleLabels[lifecycle] },
    { label: 'Runtime', value: count(attributes.runtimeMin, 'min') },
    { label: 'Episodes', value: count(attributes.episodes, 'episodes') },
    { label: 'Pages', value: count(attributes.pageCount, 'pages') },
    { label: 'Original language', value: text(attributes.originalLanguage) },
  ].filter((fact) => fact.value);

  const related = relations.related;
  const seriesGroups = new Map(related?.bySeries.map((g) => [g.series.id, g.works]));
  const propertyGroups = new Map(related?.byProperty.map((g) => [g.property.id, g.works]));

  // Links read from this work (outgoing) or toward it (incoming), one group per phrase.
  const linkGroups = new Map<string, NonNullable<typeof relations.links>>();
  for (const link of relations.links ?? []) {
    const label = workLinkLabels[link.type][link.direction];
    linkGroups.set(label, [...(linkGroups.get(label) ?? []), link]);
  }

  return (
    <div className="grid gap-8 py-6 md:grid-cols-[10rem_minmax(0,1fr)]">
      <CoverPlaceholder title={title} />
      <div>
        {text(fields.description) && <p className="max-w-prose leading-relaxed">{text(fields.description)}</p>}

        <dl className="mt-4 max-w-xl">
          {facts.map((fact) => (
            <Fact key={fact.label} label={fact.label}>
              {fact.value}
            </Fact>
          ))}
          {(relations.creators?.length ?? 0) > 0 && (
            <Fact label="Credits">
              <ul aria-label="Credits">
                {relations.creators?.map((credit) => (
                  <li key={credit.relationId}>
                    <Link to="/entities/$id" params={{ id: credit.creator.id }} className={linkClass}>
                      {credit.creator.title}
                    </Link>
                    <span className="text-muted-foreground"> — {roleLabel(credit.role)}</span>
                  </li>
                ))}
              </ul>
            </Fact>
          )}
          {(relations.tags?.length ?? 0) > 0 && (
            <Fact label="Tags">
              <ul aria-label="Tags" className="flex flex-wrap gap-x-4">
                {relations.tags?.map(({ relationId, tag }) => (
                  <li key={relationId}>
                    <Link to="/entities/$id" params={{ id: tag.id }} className={linkClass}>
                      {tag.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </Fact>
          )}
          {(relations.externalIds?.length ?? 0) > 0 && (
            <Fact label="Identifiers">
              <ul aria-label="Identifiers">
                {relations.externalIds?.map((id) => (
                  <li key={id.relationId}>
                    {idSchemeLabels[id.scheme]} {id.value}
                  </li>
                ))}
              </ul>
            </Fact>
          )}
        </dl>

        {related?.byCreator.map(({ creator, works }) => (
          <RelatedWorks
            key={creator.id}
            title={
              <>
                More by{' '}
                <Link to="/entities/$id" params={{ id: creator.id }} className={headingLinkClass}>
                  {creator.title}
                </Link>
              </>
            }
            works={works.map((entry) => ({ entry, detail: summaryDetail(entry) }))}
          />
        ))}

        {relations.series?.map(({ relationId, series, position }) => (
          <RelatedWorks
            key={relationId}
            title={
              <>
                In{' '}
                <Link to="/entities/$id" params={{ id: series.id }} className={headingLinkClass}>
                  {series.title}
                </Link>
              </>
            }
            note={`No. ${position} in the series`}
            works={(seriesGroups.get(series.id) ?? []).map((entry) => ({ entry, detail: summaryDetail(entry) }))}
            empty="No other works in the series yet."
          />
        ))}

        {relations.properties?.map(({ relationId, property }) => {
          const works = propertyGroups.get(property.id) ?? [];
          return (
            <RelatedWorks
              key={relationId}
              title={
                <>
                  {/* "Also" only when there are others to be in it with. */}
                  {works.length > 0 ? 'Also in' : 'In'}{' '}
                  <Link to="/entities/$id" params={{ id: property.id }} className={headingLinkClass}>
                    {property.title}
                  </Link>
                </>
              }
              works={works.map((entry) => ({ entry, detail: summaryDetail(entry) }))}
              empty="No other works in the property yet."
            />
          );
        })}

        {[...linkGroups].map(([label, links]) => (
          <RelatedWorks
            key={label}
            title={label}
            works={links.map((link) => ({ entry: link.work, detail: summaryDetail(link.work) }))}
          />
        ))}
      </div>
    </div>
  );
}
