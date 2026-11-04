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
  kind: 'kind',
  slug: 'slug',
};

/** Says the entry changed under an edit in progress, naming the fields both sides changed; nothing if none. */
export function ConflictNotice({ conflicts }: { conflicts: string[] }) {
  if (conflicts.length === 0) return null;
  return (
    <p role="status" className="mt-4 rounded-md border border-border bg-card p-3">
      This entry changed since you started editing. Your values are kept; check{' '}
      {conflicts.map((key) => fieldNames[key] ?? key).join(', ')}.
    </p>
  );
}
