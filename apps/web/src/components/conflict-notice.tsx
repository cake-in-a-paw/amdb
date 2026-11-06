import type { EntityKind } from '@amdb/shared';

/** Field keys in the words the form uses for them. */
const fieldNames: Record<string, string> = {
  mediaType: 'media type',
  subtype: 'type',
  title: 'title',
  name: 'name',
  originalTitle: 'original title',
  description: 'description',
  lifecycle: 'release status',
  releaseYear: 'release year',
  releaseMonth: 'release month',
  releaseDay: 'release day',
  runtimeMin: 'runtime',
  episodes: 'episodes',
  pageCount: 'page count',
  originalLanguage: 'original language',
  slug: 'slug',
  // Relation lists, where a row the contributor changed was removed meanwhile.
  credits: 'credits',
  series: 'series',
  properties: 'properties',
  tags: 'tags',
  links: 'related works',
  externalIds: 'external IDs',
};

/** `kind` is a creator's "Person or organization" and a tag's "Tag kind". */
const kindNames: Partial<Record<EntityKind, string>> = { creator: 'person or organization', tag: 'tag kind' };

/**
 * Says the entry changed under an edit in progress, naming the fields both sides changed and the
 * relation lists where a changed row was removed; nothing if none. `kind` is the entry's.
 */
export function ConflictNotice({ conflicts, kind }: { conflicts: string[]; kind: EntityKind }) {
  if (conflicts.length === 0) return null;
  const name = (key: string) => (key === 'kind' ? (kindNames[kind] ?? 'kind') : (fieldNames[key] ?? key));
  return (
    <p role="status" className="mt-4 rounded-md border border-border bg-card p-3">
      This entry changed since you started editing. Your values are kept; check {conflicts.map(name).join(', ')}.
    </p>
  );
}
