import type { EntityView } from '@/lib/entity';
import { formFromEntity } from '@/lib/entity-form';
import { emptyForm, relationChanges, toFields, type ChangeInput, type EntryForm } from '@/lib/submission';

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  // Records of API values: a missing key and an `undefined` one are the same.
  return [...keys].every((key) => same(left[key], right[key]));
}

/**
 * The keys of `after` that differ from `before`, as the API's `update` wants them: only what
 * changed, and `null` for a field that was there and is now gone (which clears it).
 */
export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue;
    changed[key] = after[key] === undefined ? null : after[key];
  }
  return changed;
}

/**
 * The rows of one relation list that went away and the ones to add. A row that kept its
 * `relationId` but was changed (a new role, position or ID) is both: relations aren't edited in
 * place, so the old one is removed and the changed one added.
 */
function rowChanges<T extends { relationId?: string | undefined }>(
  before: T[],
  after: T[],
  unchanged: (a: T, b: T) => boolean,
): { removed: string[]; added: T[] } {
  const now = new Map(after.flatMap((row) => (row.relationId ? [[row.relationId, row] as const] : [])));
  const removed: string[] = [];
  for (const old of before) {
    const kept = old.relationId ? now.get(old.relationId) : undefined;
    if (old.relationId && !(kept && unchanged(old, kept))) removed.push(old.relationId);
  }
  const gone = new Set(removed);
  const added = after
    .filter((row) => !row.relationId || gone.has(row.relationId))
    .map((row) => ({ ...row, relationId: undefined }));
  return { removed, added };
}

/**
 * What the form changes about `entity`, as submission changes: one `update` carrying only the
 * changed fields (none if no field changed), an `unrelate` for each relation taken away, and the
 * `create`s and `relate`s for each one added. Empty when the form matches the entry.
 */
export function buildEdit(entity: EntityView, form: EntryForm): ChangeInput[] {
  const original = formFromEntity(entity);
  const kind = entity.kind;
  const fields = diffFields(toFields(kind, original.fields), toFields(kind, form.fields));
  const changes: ChangeInput[] =
    Object.keys(fields).length > 0 ? [{ op: 'update', kind, entityId: entity.id, fields }] : [];
  if (kind !== 'work') return changes;

  const credits = rowChanges(original.credits, form.credits, (a, b) => a.role === b.role);
  const series = rowChanges(original.series, form.series, (a, b) => a.position.trim() === b.position.trim());
  const properties = rowChanges(original.properties, form.properties, () => true);
  const tags = rowChanges(original.tags, form.tags, () => true);
  const links = rowChanges(original.links, form.links, (a, b) => a.linkType === b.linkType);
  const ids = rowChanges(
    original.externalIds,
    form.externalIds,
    (a, b) => a.scheme === b.scheme && a.value.trim() === b.value.trim(),
  );

  const removed = [credits, series, properties, tags, links, ids].flatMap((r) => r.removed);
  const added: EntryForm = {
    ...emptyForm(),
    kind,
    credits: credits.added,
    series: series.added,
    properties: properties.added,
    tags: tags.added,
    links: links.added,
    externalIds: ids.added,
  };
  return [
    ...changes,
    ...removed.map((relationId): ChangeInput => ({ op: 'unrelate', relationId })),
    ...relationChanges(added, { id: entity.id }),
  ];
}
