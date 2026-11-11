/** Words for a change, shared by the history and the moderation queue. */

/** Who made a change: their handle, else "contributor" (signed in, no handle), else "anonymous"; an import is named for its source. Never an id. */
export function authorName(
  author: 'anonymous' | { handle: string | null } | { importRun: { id: string; source: string } },
): string {
  if (author === 'anonymous') return 'anonymous';
  if ('importRun' in author) return 'Wikidata import';
  return author.handle ?? 'contributor';
}

/** A value from a change's fields, short enough for a line of history or the queue. */
export function valueText(value: unknown): string {
  if (value === null) return 'cleared';
  // A list of names (alternate titles) reads as the names; an empty one clears the list.
  if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
    return value.length === 0 ? 'cleared' : value.join(', ');
  const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 280 ? `${text.slice(0, 280)}…` : text;
}

/** A payload read as a record; anything that isn't an object reads as empty. */
export const record = (value: unknown): Record<string, unknown> =>
  // A non-null object; its keys are read as unknown, so nothing is assumed about them.
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
