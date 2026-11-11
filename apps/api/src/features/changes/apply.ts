import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dedupeNames, type EntityKind, FieldsFor, joinNorms, normalizeTitle } from '@amdb/shared';
import { z } from '@hono/zod-openapi';
import { and, arrayContains, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { changes, creators, entities, properties, relations, series, tags, works } from '../../platform/db/schema';
import type { Tx } from '../../platform/db/types';
import { mergeFamily, resolveWinner } from '../../platform/db/merge';
import { type ApiError, badRequest, conflict, isUniqueViolation } from '../../platform/http/errors';
import { type ChangeRow, changesRepository } from './repository';
import { MergePayload, REDACTED_VALUE, RedactedValue, RelatePayload, UnrelatePayload } from './schemas';

/**
 * The one place catalog tables are written (constitution VIII). Each applied change returns the
 * inverse that undoes it, which is stored on the change so a rejection or revert is itself exact.
 */

export const InverseSchema = z.discriminatedUnion('op', [
  /** Inverse of a create: tombstones the entity, keeping its rows as history. */
  z.object({ op: z.literal('retract_entity'), entityId: z.uuid() }),
  /** Inverse of an update: the previous values and the changes that had set them. */
  z.object({
    op: z.literal('set_fields'),
    entityId: z.uuid(),
    fields: z.record(z.string(), z.unknown()),
    fieldSources: z.record(z.string(), z.string().nullable()),
  }),
  /** Inverse of a relate. */
  z.object({ op: z.literal('remove_relation'), relationId: z.uuid() }),
  /** Inverse of an unrelate. */
  z.object({ op: z.literal('restore_relation'), relationId: z.uuid() }),
  /**
   * Inverse of a merge: `from` is live again and the relations repointed to `into` go back
   * (`movedAsTo` are those whose `to` end moved, the rest moved their `from` end); relations the
   * merge dropped as duplicates are restored. `intoNames` is the winner's names list before the
   * merge added the loser's names, and the change that had set it; absent when the merge added none
   * (and on merges applied before merges took names).
   */
  z.object({
    op: z.literal('unmerge'),
    from: z.uuid(),
    into: z.uuid(),
    movedRelationIds: z.array(z.uuid()),
    movedAsTo: z.array(z.uuid()),
    removedRelationIds: z.array(z.uuid()),
    intoNames: z
      .object({
        key: z.enum(['alternateTitles', 'alternateNames']),
        value: z.array(z.string()),
        source: z.string().nullable(),
      })
      .optional(),
  }),
]);
export type Inverse = z.infer<typeof InverseSchema>;

/** A change's fields without `submitted`, the contributor's original kept by edit-and-approve. */
export function fieldsOf(payload: Record<string, unknown> | null): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload ?? {}).filter(([k]) => k !== 'submitted'));
}

const KIND_TABLES = { work: works, creator: creators, series, property: properties, tag: tags } as const;

/** Columns derived from others, never part of a kind's fields. */
const DERIVED = new Set([
  'entityId',
  'titleNorm',
  'nameNorm',
  'search',
  'alternateTitlesNorm',
  'alternateNamesNorm',
  'altSearch',
]);
/** Fields whose null is a value (`subtype` is null for a book), not "absent". */
const NULLABLE = new Set(['subtype']);

/** Fields with their absent values (null, except where null is a value) left out. */
export const withoutAbsent = (fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== null || NULLABLE.has(k)));

/** A kind row as its zod field schema's input: derived columns dropped and absent values (null) left out. */
const asInput = (row: Record<string, unknown>) =>
  withoutAbsent(Object.fromEntries(Object.entries(row).filter(([k]) => !DERIVED.has(k))));

function parseFields<T extends z.ZodType>(schema: T, input: Record<string, unknown>): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    // The change was valid when submitted; it is the current state it lands on that makes it invalid.
    throw conflict(
      'invalid_fields',
      'The change would leave the entity with invalid fields',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

/**
 * Validates `input` as the entity's complete fields and writes every column, absent ones as
 * null, with the `*_norm` columns recomputed.
 */
async function writeRow(
  tx: Tx,
  kind: EntityKind,
  id: string,
  input: Record<string, unknown>,
  mode: 'insert' | 'update',
) {
  switch (kind) {
    case 'work': {
      const f = parseFields(FieldsFor.work, input);
      const values = {
        mediaType: f.mediaType,
        subtype: f.subtype,
        title: f.title,
        titleNorm: normalizeTitle(f.title),
        originalTitle: f.originalTitle ?? null,
        originalTitleNorm: f.originalTitle ? normalizeTitle(f.originalTitle) : null,
        description: f.description ?? null,
        releaseYear: f.releaseYear ?? null,
        releaseMonth: f.releaseMonth ?? null,
        releaseDay: f.releaseDay ?? null,
        lifecycle: f.lifecycle,
        attributes: f.attributes ?? {},
        alternateTitles: f.alternateTitles ?? [],
        alternateTitlesNorm: joinNorms(f.alternateTitles ?? []),
      };
      if (mode === 'insert') await tx.insert(works).values({ entityId: id, ...values });
      else await tx.update(works).set(values).where(eq(works.entityId, id));
      return;
    }
    case 'creator': {
      const f = parseFields(FieldsFor.creator, input);
      const values = {
        name: f.name,
        nameNorm: normalizeTitle(f.name),
        kind: f.kind,
        description: f.description ?? null,
        alternateNames: f.alternateNames ?? [],
        alternateNamesNorm: joinNorms(f.alternateNames ?? []),
      };
      if (mode === 'insert') await tx.insert(creators).values({ entityId: id, ...values });
      else await tx.update(creators).set(values).where(eq(creators.entityId, id));
      return;
    }
    case 'series': {
      const f = parseFields(FieldsFor.series, input);
      const values = { title: f.title, titleNorm: normalizeTitle(f.title), description: f.description ?? null };
      if (mode === 'insert') await tx.insert(series).values({ entityId: id, ...values });
      else await tx.update(series).set(values).where(eq(series.entityId, id));
      return;
    }
    case 'property': {
      const f = parseFields(FieldsFor.property, input);
      const values = { title: f.title, titleNorm: normalizeTitle(f.title), description: f.description ?? null };
      if (mode === 'insert') await tx.insert(properties).values({ entityId: id, ...values });
      else await tx.update(properties).set(values).where(eq(properties.entityId, id));
      return;
    }
    case 'tag': {
      const f = parseFields(FieldsFor.tag, input);
      const values = { kind: f.kind, name: f.name, nameNorm: normalizeTitle(f.name), slug: f.slug };
      await writeUnique(
        tx,
        (sp) =>
          mode === 'insert'
            ? sp.insert(tags).values({ entityId: id, ...values })
            : sp.update(tags).set(values).where(eq(tags.entityId, id)),
        async () => {
          const existing = await changesRepository(tx).findTagBySlug(f.slug);
          return existing ? duplicateSlug(f.slug, existing) : null;
        },
      );
      return;
    }
  }
}

/** The kinds with a list of other names, and the field that holds it. */
const NAMES_KEY = { work: 'alternateTitles', creator: 'alternateNames' } as const;
/** Each named kind's main names, which a merge copies into the winner's list. */
const MAIN_NAMES = { work: ['title', 'originalTitle'], creator: ['name'] } as const;
type NamedKind = keyof typeof NAMES_KEY;
const isNamed = (kind: EntityKind): kind is NamedKind => kind in NAMES_KEY;

/** An entity's main names (title and original title, or name) and its list of other names. */
async function namesOf(tx: Tx, kind: NamedKind, id: string): Promise<{ main: (string | null)[]; list: string[] }> {
  if (kind === 'work') {
    const [row] = await tx
      .select({ title: works.title, originalTitle: works.originalTitle, list: works.alternateTitles })
      .from(works)
      .where(eq(works.entityId, id));
    if (!row) throw new Error(`entity ${id} has no work row`);
    return { main: [row.title, row.originalTitle], list: row.list };
  }
  const [row] = await tx
    .select({ name: creators.name, list: creators.alternateNames })
    .from(creators)
    .where(eq(creators.entityId, id));
  if (!row) throw new Error(`entity ${id} has no creator row`);
  return { main: [row.name], list: row.list };
}

/**
 * For a merge: adds the loser's names (main and other) to the winner's list, deduped, and returns
 * what the inverse needs to put the list back. Null when the merge adds no names.
 */
async function unionNames(tx: Tx, kind: NamedKind, fromId: string, intoId: string, sources: Record<string, string>) {
  const winner = await namesOf(tx, kind, intoId);
  const loser = await namesOf(tx, kind, fromId);
  const union = dedupeNames(winner.main, [...winner.list, ...loser.main.filter((m) => m !== null), ...loser.list]);
  if (isDeepStrictEqual(union, dedupeNames(winner.main, winner.list))) return null;
  await writeAlternateNames(tx, kind, intoId, union);
  const key = NAMES_KEY[kind];
  return { key, value: winner.list, source: sources[key] ?? null };
}

/** Writes just an entity's names list and its norm column, as `writeRow` would. */
async function writeAlternateNames(tx: Tx, kind: NamedKind, id: string, names: string[]) {
  if (kind === 'work') {
    await tx
      .update(works)
      .set({ alternateTitles: names, alternateTitlesNorm: joinNorms(names) })
      .where(eq(works.entityId, id));
  } else {
    await tx
      .update(creators)
      .set({ alternateNames: names, alternateNamesNorm: joinNorms(names) })
      .where(eq(creators.entityId, id));
  }
}

async function kindRow(tx: Tx, kind: EntityKind, id: string): Promise<Record<string, unknown>> {
  const table = KIND_TABLES[kind];
  const [row] = await tx.select().from(table).where(eq(table.entityId, id));
  if (!row) throw new Error(`entity ${id} has no ${kind} row`);
  return row;
}

/** The live entity `id` (not removed or retracted), locked for the rest of the transaction. */
async function lockEntity(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(entities)
    .where(and(eq(entities.id, id), isNull(entities.removedAt), isNull(entities.retractedByChange)))
    .for('update');
  return row ?? null;
}

/**
 * The live entity `id` resolves to after merges, locked. Locking can race a merge of the entity
 * away, so it resolves again until the locked row is not merged.
 */
async function requireEntity(tx: Tx, id: string) {
  let target = id;
  for (;;) {
    target = await resolveWinner(tx, target);
    const entity = await lockEntity(tx, target);
    if (!entity) throw conflict('dependency_pending', `Entity ${target} doesn't exist yet`);
    if (!entity.mergedIntoId) return entity;
  }
}

/**
 * Like `requireEntity` for several ids: locks the live entities they resolve to, in id order so two
 * transactions locking the same pair can't deadlock, and returns a lookup from a named id to it.
 */
async function requireEntities(tx: Tx, ids: string[]): Promise<(named: string) => string> {
  for (;;) {
    const targets = await Promise.all(ids.map((id) => resolveWinner(tx, id)));
    let mergedMeanwhile = false;
    for (const id of [...new Set(targets)].toSorted()) {
      const entity = await lockEntity(tx, id);
      if (!entity) throw conflict('dependency_pending', `Entity ${id} doesn't exist yet`);
      if (entity.mergedIntoId) mergedMeanwhile = true;
    }
    // A merge took one away before it was locked: resolve again (the locks held stay held).
    if (!mergedMeanwhile) {
      const resolved = new Map(ids.map((id, i) => [id, targets[i] ?? id]));
      return (named) => resolved.get(named) ?? named;
    }
  }
}

/** The change's target entity, after merges. */
function targetOf(change: ChangeRow): string {
  if (!change.entityId) throw new Error(`change ${change.id} (${change.op}) has no entity id`);
  return change.entityId;
}

/** 409 for a tag slug that another tag already holds. */
export const duplicateSlug = (slug: string, existingId: string) =>
  conflict('duplicate_slug', `The slug "${slug}" is already in use`, { existingId });

/** 409 for an external id that another entity already holds. */
export const duplicateExternalId = (scheme: string, value: string, existingId: string) =>
  conflict('duplicate_external_id', `${scheme} ${value} is already recorded`, { existingId });

/**
 * Runs `write` in a savepoint; a unique violation (a slug or external id that appeared since the
 * change was checked) becomes `duplicate()`'s 409. Any other violation is rethrown as is.
 */
async function writeUnique(tx: Tx, write: (sp: Tx) => Promise<unknown>, duplicate: () => Promise<ApiError | null>) {
  try {
    await tx.transaction(write);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw (await duplicate()) ?? err;
  }
}

/** Applies one change to current state in `tx`, returning its inverse. Throws ApiError on conflict. */
export async function applyChange(tx: Tx, change: ChangeRow): Promise<Inverse> {
  const fields = fieldsOf(change.payload);
  switch (change.op) {
    case 'create': {
      const id = targetOf(change);
      const fieldSources = Object.fromEntries(Object.keys(fields).map((k) => [k, change.id]));
      const [existing] = await tx.select().from(entities).where(eq(entities.id, id)).for('update');
      if (!existing) {
        await tx.insert(entities).values({ id, kind: change.kind, fieldSources });
        await writeRow(tx, change.kind, id, fields, 'insert');
      } else if (existing.retractedByChange && existing.kind === change.kind) {
        // A retracted entity comes back (a resubmitted create keeps its reserved id): lift the
        // tombstone and write this create's fields over the old ones.
        await tx
          .update(entities)
          .set({ retractedByChange: null, fieldSources, updatedAt: new Date() })
          .where(eq(entities.id, id));
        await writeRow(tx, change.kind, id, fields, 'update');
      } else {
        throw conflict('already_exists', `Entity ${id} already exists`);
      }
      return { op: 'retract_entity', entityId: id };
    }
    case 'update': {
      const entity = await requireEntity(tx, targetOf(change));
      const id = entity.id;
      const current = await kindRow(tx, change.kind, id);
      const base = change.base;
      if (base) {
        const stale = Object.keys(base).filter((k) => !isDeepStrictEqual(current[k] ?? null, base[k] ?? null));
        if (stale.length) {
          throw conflict('stale_change', `${stale.join(', ')} changed since this change was submitted`, {
            fields: stale,
          });
        }
      }
      const keys = Object.keys(fields);
      const inverse: Inverse = {
        op: 'set_fields',
        entityId: id,
        fields: Object.fromEntries(keys.map((k) => [k, current[k] ?? null])),
        fieldSources: Object.fromEntries(keys.map((k) => [k, entity.fieldSources[k] ?? null])),
      };
      // A null field clears it: `asInput` leaves it out, as an absent value.
      await writeRow(tx, change.kind, id, asInput({ ...current, ...fields }), 'update');
      await tx
        .update(entities)
        .set({
          fieldSources: { ...entity.fieldSources, ...Object.fromEntries(keys.map((k) => [k, change.id])) },
          updatedAt: new Date(),
        })
        .where(eq(entities.id, id));
      return inverse;
    }
    case 'relate': {
      const p = RelatePayload.parse(change.payload);
      const ends = await requireEntities(tx, p.to ? [p.from, p.to] : [p.from]);
      const from = ends(p.from);
      const to = p.to ? ends(p.to) : null;
      const relationId = randomUUID();
      await writeUnique(
        tx,
        (sp) =>
          sp.insert(relations).values({
            id: relationId,
            type: p.type,
            fromId: from,
            toId: to,
            role: p.data.role ?? null,
            position: p.data.position ?? null,
            linkType: p.data.linkType ?? null,
            scheme: p.data.scheme ?? null,
            value: p.data.value ?? null,
            createdByChange: change.id,
          }),
        async () => {
          const { scheme, value } = p.data;
          const holder = scheme && value ? await changesRepository(tx).findExternalIdHolder(scheme, value) : null;
          return holder && scheme && value ? duplicateExternalId(scheme, value, holder) : null;
        },
      );
      return { op: 'remove_relation', relationId };
    }
    case 'unrelate': {
      const { relationId } = UnrelatePayload.parse(change.payload);
      const removed = await tx
        .update(relations)
        .set({ removedByChange: change.id })
        .where(and(eq(relations.id, relationId), isNull(relations.removedByChange)))
        .returning({ id: relations.id });
      if (!removed.length) throw conflict('stale_change', `Relation ${relationId} was already removed`, { relationId });
      return { op: 'restore_relation', relationId };
    }
    case 'merge': {
      const { from: fromId, into } = MergePayload.parse(change.payload);
      const intoId = await resolveWinner(tx, into);
      if (intoId === fromId) throw badRequest('self_merge', 'An entity can’t merge into itself');
      const { loser, target } = await lockPair(tx, fromId, intoId);
      if (loser.mergedIntoId) throw conflict('already_merged', `Entity ${fromId} was already merged`);
      if (target.mergedIntoId) throw conflict('stale_change', `Entity ${intoId} was merged away meanwhile`);
      if (loser.kind !== change.kind || target.kind !== loser.kind) {
        throw badRequest('kind_mismatch', 'Only entities of the same kind can be merged');
      }
      const touching = (id: string) =>
        and(or(eq(relations.fromId, id), eq(relations.toId, id)), isNull(relations.removedByChange));
      const loserRels = await tx
        .select()
        .from(relations)
        .where(touching(fromId))
        .orderBy(relations.createdAt, relations.id)
        .for('update');
      const winnerRels = await tx.select().from(relations).where(touching(intoId)).for('update');
      // Deliberately ignores `position`: the same credit at another position is still a duplicate.
      const seen = new Set(winnerRels.map(relationKey));
      const moved: string[] = [];
      const movedAsTo: string[] = [];
      const removed: string[] = [];
      for (const r of loserRels) {
        const after = {
          ...r,
          fromId: r.fromId === fromId ? intoId : r.fromId,
          toId: r.toId === fromId ? intoId : r.toId,
        };
        // Repointing would duplicate a relation the winner has (or link it to itself): drop it.
        if (after.fromId === after.toId || seen.has(relationKey(after))) {
          removed.push(r.id);
          continue;
        }
        seen.add(relationKey(after));
        moved.push(r.id);
        if (r.toId === fromId) movedAsTo.push(r.id);
        await tx.update(relations).set({ fromId: after.fromId, toId: after.toId }).where(eq(relations.id, r.id));
      }
      if (removed.length) {
        await tx.update(relations).set({ removedByChange: change.id }).where(inArray(relations.id, removed));
      }
      const intoNames = isNamed(change.kind)
        ? await unionNames(tx, change.kind, fromId, intoId, target.fieldSources)
        : null;
      const intoSources = intoNames ? { ...target.fieldSources, [intoNames.key]: change.id } : target.fieldSources;
      await tx.update(entities).set({ mergedIntoId: intoId, updatedAt: new Date() }).where(eq(entities.id, fromId));
      await tx
        .update(entities)
        .set({ fieldSources: intoSources, updatedAt: new Date() })
        .where(eq(entities.id, intoId));
      return {
        op: 'unmerge',
        from: fromId,
        into: intoId,
        movedRelationIds: moved,
        movedAsTo,
        removedRelationIds: removed,
        ...(intoNames && { intoNames }),
      };
    }
  }
}

/** Two relations are duplicates when they agree on everything but position and identity (see the merge). */
const relationKey = (r: typeof relations.$inferSelect) =>
  JSON.stringify([r.type, r.fromId, r.toId, r.role, r.linkType, r.scheme, r.value]);

/**
 * Locks `fromId` and `intoId` (in id order, so concurrent merges can't deadlock) and returns
 * them. Throws 409 if either isn't live. Merged ones are still returned: callers check.
 */
async function lockPair(tx: Tx, fromId: string, intoId: string) {
  const rows = new Map<string, typeof entities.$inferSelect>();
  for (const id of [fromId, intoId].toSorted()) {
    const row = await lockEntity(tx, id);
    if (!row) throw conflict('entity_unavailable', `Entity ${id} is removed or doesn’t exist`);
    rows.set(id, row);
  }
  const loser = rows.get(fromId);
  const target = rows.get(intoId);
  if (!loser || !target) throw new Error('lockPair lost an entity');
  return { loser, target };
}

/**
 * Refuses to undo `change` when later state builds on it: live changes that depend on a create,
 * fields another change has since set, or a relation that is no longer as the change left it.
 * Call before `applyInverse` when rejecting or reverting a live change.
 */
export async function assertUndoable(tx: Tx, change: ChangeRow): Promise<void> {
  switch (change.op) {
    case 'create': {
      const id = targetOf(change);
      // Lock first, so a change applied concurrently against the entity is either seen below or waits.
      if (!(await lockEntity(tx, id))) throw conflict('stale_change', `Entity ${id} is no longer live`);
      // Not dependents: reverts (they only undo), changes already reverted, and redacted changes
      // (they can't be undone, and their content is erased anyway).
      const dependents = await tx
        .select({ id: changes.id })
        .from(changes)
        .where(
          and(
            ne(changes.id, change.id),
            inArray(changes.status, ['published', 'approved']),
            or(arrayContains(changes.dependsOn, [change.id]), eq(changes.entityId, id)),
            isNull(changes.redactedAt),
            sql`${changes.payload}->>'revertOf' is null`,
            sql`not exists (select 1 from ${changes} r where r.payload->>'revertOf' = ${changes.id}::text and r.status in ('approved', 'published'))`,
          ),
        );
      if (dependents.length) {
        throw conflict('has_dependents', 'Live changes build on this one; reject or revert them first', {
          changeIds: dependents.map((d) => d.id),
        });
      }
      return;
    }
    case 'update': {
      const entity = await requireEntity(tx, targetOf(change));
      const changed = Object.keys(fieldsOf(change.payload)).filter((k) => entity.fieldSources[k] !== change.id);
      if (changed.length) {
        throw conflict('stale_change', `${changed.join(', ')} changed since this change went live`, {
          fields: changed,
        });
      }
      return;
    }
    case 'relate':
    case 'unrelate': {
      const relationId = change.relationId;
      if (!relationId) throw new Error(`live ${change.op} change ${change.id} has no relation id`);
      const [row] = await tx
        .select({ removedBy: relations.removedByChange })
        .from(relations)
        .where(eq(relations.id, relationId))
        .for('update');
      const asLeft = change.op === 'relate' ? row?.removedBy === null : row?.removedBy === change.id;
      if (!asLeft) throw conflict('stale_change', `Relation ${relationId} changed since this change went live`);
      return;
    }
    case 'merge': {
      const inverse = InverseSchema.parse(change.inverse);
      if (inverse.op !== 'unmerge') throw new Error(`merge change ${change.id} has inverse ${inverse.op}`);
      const stale = (why: string) => conflict('stale_change', why);
      const { loser, target } = await lockPair(tx, inverse.from, inverse.into);
      if (loser.mergedIntoId !== inverse.into)
        throw stale(`Entity ${inverse.from} is no longer merged into ${inverse.into}`);
      if (target.mergedIntoId) throw stale(`Entity ${inverse.into} was merged into another entity since`);
      if (inverse.intoNames && target.fieldSources[inverse.intoNames.key] !== change.id) {
        throw stale(`${inverse.intoNames.key} of ${inverse.into} changed since this merge`);
      }
      const moved = inverse.movedRelationIds.length
        ? await tx.select().from(relations).where(inArray(relations.id, inverse.movedRelationIds)).for('update')
        : [];
      const asTo = new Set(inverse.movedAsTo);
      const intact = moved.filter((r) => !r.removedByChange && (asTo.has(r.id) ? r.toId : r.fromId) === inverse.into);
      if (intact.length !== inverse.movedRelationIds.length) {
        throw stale('Relations this merge moved have changed since');
      }
      const dropped = inverse.removedRelationIds.length
        ? await tx.select().from(relations).where(inArray(relations.id, inverse.removedRelationIds)).for('update')
        : [];
      if (
        dropped.length !== inverse.removedRelationIds.length ||
        dropped.some((r) => r.removedByChange !== change.id)
      ) {
        throw stale('Relations this merge dropped have changed since');
      }
      // Restoring a relation to an end that has since been removed or retracted would leave it dangling.
      const others = dropped.map((r) => (r.fromId === inverse.from ? r.toId : r.fromId));
      const gone = await tx
        .select({ id: entities.id })
        .from(entities)
        .where(
          and(
            inArray(
              entities.id,
              others.filter((x): x is string => !!x),
            ),
            or(isNotNull(entities.removedAt), isNotNull(entities.retractedByChange)),
          ),
        );
      if (gone.length) throw stale('A relation this merge dropped now points at a removed entity');
      return;
    }
  }
}

/** Undoes an applied change. `byChangeId` is the change doing the undoing, recorded where a row is retired. */
export async function applyInverse(tx: Tx, inverse: Inverse, byChangeId: string): Promise<void> {
  switch (inverse.op) {
    case 'retract_entity': {
      // Lock first, so a relate applied concurrently is either counted below or waits and then
      // finds the entity gone.
      const id = inverse.entityId;
      const entity = await lockEntity(tx, id);
      if (!entity) throw conflict('stale_change', `Entity ${id} is no longer live`);
      const referencing = await tx
        .select({ id: relations.id })
        .from(relations)
        .where(and(or(eq(relations.fromId, id), eq(relations.toId, id)), isNull(relations.removedByChange)));
      const mergedIn = await tx.select({ id: entities.id }).from(entities).where(eq(entities.mergedIntoId, id));
      if (referencing.length || mergedIn.length) {
        throw conflict('has_dependents', 'Other records still reference this entity', {
          relationIds: referencing.map((r) => r.id),
          entityIds: mergedIn.map((e) => e.id),
        });
      }
      await tx
        .update(entities)
        .set({ retractedByChange: byChangeId, updatedAt: new Date() })
        .where(eq(entities.id, id));
      return;
    }
    case 'set_fields': {
      const entity = await requireEntity(tx, inverse.entityId);
      const current = await kindRow(tx, entity.kind, entity.id);
      await writeRow(tx, entity.kind, entity.id, asInput({ ...current, ...inverse.fields }), 'update');
      const sources = { ...entity.fieldSources };
      for (const [k, source] of Object.entries(inverse.fieldSources)) {
        if (source === null) delete sources[k];
        else sources[k] = source;
      }
      await tx.update(entities).set({ fieldSources: sources, updatedAt: new Date() }).where(eq(entities.id, entity.id));
      return;
    }
    case 'remove_relation': {
      const removed = await tx
        .update(relations)
        .set({ removedByChange: byChangeId })
        .where(and(eq(relations.id, inverse.relationId), isNull(relations.removedByChange)))
        .returning({ id: relations.id });
      if (!removed.length) throw conflict('stale_change', `Relation ${inverse.relationId} was already removed`);
      return;
    }
    case 'restore_relation': {
      await tx.update(relations).set({ removedByChange: null }).where(eq(relations.id, inverse.relationId));
      return;
    }
    case 'unmerge': {
      const { loser, target } = await lockPair(tx, inverse.from, inverse.into);
      if (loser.mergedIntoId !== inverse.into || target.mergedIntoId) {
        throw conflict('stale_change', `Entity ${inverse.from} is no longer merged into ${inverse.into}`);
      }
      const asTo = inverse.movedRelationIds.filter((id) => inverse.movedAsTo.includes(id));
      const asFrom = inverse.movedRelationIds.filter((id) => !inverse.movedAsTo.includes(id));
      if (asTo.length) await tx.update(relations).set({ toId: inverse.from }).where(inArray(relations.id, asTo));
      if (asFrom.length) await tx.update(relations).set({ fromId: inverse.from }).where(inArray(relations.id, asFrom));
      if (inverse.removedRelationIds.length) {
        await tx
          .update(relations)
          .set({ removedByChange: null })
          .where(inArray(relations.id, inverse.removedRelationIds));
      }
      await tx.update(entities).set({ mergedIntoId: null, updatedAt: new Date() }).where(eq(entities.id, inverse.from));
      const sources = { ...target.fieldSources };
      if (inverse.intoNames) {
        const { key, value, source } = inverse.intoNames;
        if (!isNamed(target.kind)) throw new Error(`unmerge of ${target.kind} ${inverse.into} carries ${key}`);
        await writeAlternateNames(tx, target.kind, inverse.into, value);
        if (source === null) delete sources[key];
        else sources[key] = source;
      }
      await tx
        .update(entities)
        .set({ fieldSources: sources, updatedAt: new Date() })
        .where(eq(entities.id, inverse.into));
      return;
    }
  }
}

/** What a change's effects still hold in the catalog: the live entity and/or relation it put there. */
export interface CurrentContent {
  entityId: string | null;
  relationId: string | null;
}

/**
 * The entity whose row holds a create's or update's fields: a create's reserved id; for an update,
 * the entity it was applied to (its `set_fields` inverse), which differs from the id it named when
 * that id was merged away before it applied. An update never applied names its winner.
 */
async function contentEntityOf(tx: Tx, change: ChangeRow): Promise<string> {
  const id = targetOf(change);
  if (change.op !== 'update') return id;
  const inverse = InverseSchema.safeParse(change.inverse);
  if (inverse.success && inverse.data.op === 'set_fields') return inverse.data.entityId;
  return resolveWinner(tx, id);
}

/**
 * The live content of an applied change, or null when its effects are gone. A create is current
 * while its entity is neither retracted nor removed; an update while any field's source is the
 * change; a relate while its relation is active; a merge while the loser is still merged into
 * `into`. An unrelate carries only a relation id, so it never counts. Locks what it reads.
 */
export async function currentContent(tx: Tx, change: ChangeRow): Promise<CurrentContent | null> {
  switch (change.op) {
    case 'create':
    case 'update': {
      const entity = await lockEntity(tx, await contentEntityOf(tx, change));
      if (!entity) return null;
      if (change.op === 'update') {
        const keys = Object.keys(fieldsOf(change.payload));
        if (!keys.some((k) => entity.fieldSources[k] === change.id)) return null;
      }
      return { entityId: entity.id, relationId: null };
    }
    case 'relate': {
      if (!change.relationId) return null;
      const [row] = await tx
        .select({ removedBy: relations.removedByChange })
        .from(relations)
        .where(eq(relations.id, change.relationId))
        .for('update');
      return row && row.removedBy === null ? { entityId: null, relationId: change.relationId } : null;
    }
    case 'merge': {
      const inverse = InverseSchema.safeParse(change.inverse);
      if (!inverse.success || inverse.data.op !== 'unmerge') return null;
      const loser = await lockEntity(tx, inverse.data.from);
      return loser?.mergedIntoId === inverse.data.into ? { entityId: loser.id, relationId: null } : null;
    }
    case 'unrelate':
      return null;
  }
}

/**
 * Removes an entity from public view (legal or abuse removal) and erases its free text; the
 * entity's history stays.
 */
export async function applyRemoval(tx: Tx, entityId: string): Promise<void> {
  const now = new Date();
  await tx.update(entities).set({ removedAt: now, updatedAt: now }).where(eq(entities.id, entityId));
  await eraseText(tx, entityId);
}

const PLACEHOLDER = '[removed]';

/**
 * Erases an entity's free text, leaving valid placeholders in its kind row (NOT NULL columns,
 * `*_norm` consistent, a tag's slug unique).
 */
async function eraseText(tx: Tx, entityId: string): Promise<void> {
  const [entity] = await tx.select({ kind: entities.kind }).from(entities).where(eq(entities.id, entityId));
  const norm = normalizeTitle(PLACEHOLDER);
  switch (entity?.kind) {
    case 'work':
      await tx
        .update(works)
        .set({
          title: PLACEHOLDER,
          titleNorm: norm,
          originalTitle: null,
          originalTitleNorm: null,
          description: null,
          attributes: {},
          alternateTitles: [],
          alternateTitlesNorm: '',
        })
        .where(eq(works.entityId, entityId));
      return;
    case 'creator':
      await tx
        .update(creators)
        .set({ name: PLACEHOLDER, nameNorm: norm, description: null, alternateNames: [], alternateNamesNorm: '' })
        .where(eq(creators.entityId, entityId));
      return;
    case 'series':
      await tx
        .update(series)
        .set({ title: PLACEHOLDER, titleNorm: norm, description: null })
        .where(eq(series.entityId, entityId));
      return;
    case 'property':
      await tx
        .update(properties)
        .set({ title: PLACEHOLDER, titleNorm: norm, description: null })
        .where(eq(properties.entityId, entityId));
      return;
    case 'tag':
      await tx
        .update(tags)
        .set({ name: PLACEHOLDER, nameNorm: norm, slug: `removed-${entityId}` })
        .where(eq(tags.entityId, entityId));
      return;
    case undefined:
      return;
  }
}

/**
 * Erases what a redacted change wrote that is no longer live and so wasn't taken down with it: a
 * create's entity text once the entity is retracted or removed (it stays retracted, so a
 * resubmission can still bring it back), and a relate's role and value once its relation is
 * retired (placeholders keep `relations_type_columns` satisfied). An entity a later create made
 * live again holds that create's content, and is left alone.
 */
export async function eraseRedacted(tx: Tx, change: ChangeRow): Promise<void> {
  if (change.op === 'create' && change.entityId) {
    const [entity] = await tx
      .select()
      .from(entities)
      .where(
        and(eq(entities.id, change.entityId), or(isNotNull(entities.removedAt), isNotNull(entities.retractedByChange))),
      )
      .for('update');
    if (entity) await eraseText(tx, entity.id);
  }
  if (change.op === 'relate' && change.relationId) {
    const [row] = await tx
      .select()
      .from(relations)
      .where(and(eq(relations.id, change.relationId), isNotNull(relations.removedByChange)))
      .for('update');
    if (row) {
      await tx
        .update(relations)
        .set({
          role: row.role === null ? null : PLACEHOLDER,
          value: row.value === null ? null : `removed-${row.id}`,
        })
        .where(eq(relations.id, row.id));
    }
  }
}

/**
 * Removes copies of a redacted change's content held by other changes, so a later revert can't
 * bring it back. For an update or create: every other change on the entity it landed on (and on
 * the entities merged into that one) loses the redacted fields from its `set_fields` inverse
 * where they hold the redacted value (a null, which clears, is no content) or are sourced to the
 * redacted change, and its `base` keeps those keys as `REDACTED_VALUE`, so the base still never
 * matches and the change stays stale. For a relate: any unrelate inverse that would restore its relation (left unrestorable: null) and the
 * merge inverses that would restore it as a dropped duplicate.
 */
export async function scrubRedacted(tx: Tx, change: ChangeRow): Promise<void> {
  if ((change.op === 'create' || change.op === 'update') && change.entityId) {
    const redacted = fieldsOf(change.payload);
    const keys = Object.keys(redacted);
    const family = new Set([change.entityId, ...(await mergeFamily(tx, await contentEntityOf(tx, change)))]);
    // Every other change on those entities, whatever its op or status (reverts included): any of
    // them may hold the value in `base` or `inverse`.
    const others = await tx
      .select()
      .from(changes)
      .where(and(inArray(changes.entityId, [...family]), ne(changes.id, change.id)));
    const without = <T extends Record<string, unknown>>(o: T, drop: string[]) =>
      Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)));
    for (const other of others) {
      const inverse = InverseSchema.safeParse(other.inverse);
      const own = inverse.success && inverse.data.op === 'set_fields' ? inverse.data : null;
      // A copy is the redacted value itself, or anything recorded as sourced to the redacted change.
      const dropInverse = keys.filter(
        (k) =>
          own &&
          (own.fieldSources[k] === change.id ||
            (redacted[k] !== null && k in own.fields && isDeepStrictEqual(own.fields[k], redacted[k]))),
      );
      const base = other.base;
      const eraseBase = keys.filter(
        (k) =>
          base &&
          k in base &&
          !RedactedValue.safeParse(base[k]).success &&
          (dropInverse.includes(k) || (redacted[k] !== null && isDeepStrictEqual(base[k], redacted[k]))),
      );
      if (!dropInverse.length && !eraseBase.length) continue;
      await tx
        .update(changes)
        .set({
          base: base ? { ...base, ...Object.fromEntries(eraseBase.map((k) => [k, REDACTED_VALUE])) } : base,
          inverse: own
            ? { ...own, fields: without(own.fields, dropInverse), fieldSources: without(own.fieldSources, dropInverse) }
            : other.inverse,
        })
        .where(eq(changes.id, other.id));
    }
  }
  if (change.op === 'relate' && change.relationId) {
    const relationId = change.relationId;
    await tx
      .update(changes)
      .set({ inverse: null })
      .where(and(eq(changes.op, 'unrelate'), eq(changes.relationId, relationId)));
    const merges = await tx.select().from(changes).where(eq(changes.op, 'merge'));
    for (const m of merges) {
      const inverse = InverseSchema.safeParse(m.inverse);
      if (!inverse.success || inverse.data.op !== 'unmerge' || !inverse.data.removedRelationIds.includes(relationId))
        continue;
      await tx
        .update(changes)
        .set({
          inverse: {
            ...inverse.data,
            removedRelationIds: inverse.data.removedRelationIds.filter((x) => x !== relationId),
          },
        })
        .where(eq(changes.id, m.id));
    }
  }
}

const isNames = (v: unknown): v is string[] => Array.isArray(v) && v.every((n) => typeof n === 'string');

/**
 * Removes the names a redacted create or update wrote (its names list, and the main names a merge
 * copies into a winner's list) wherever merges carried them: the names lists of its entity's
 * whole merge family, merge inverses' `intoNames`, the family's `set_fields` inverses (names
 * dropped) and `base`s (`REDACTED_VALUE`, so the change stays stale). Names match by
 * `normalizeTitle`, so an identical name someone else added is removed too; that is accepted for
 * a legal removal. A change never applied wrote nothing and is skipped. Call while the change
 * still has its payload.
 */
export async function scrubMergedNames(tx: Tx, change: ChangeRow): Promise<void> {
  if ((change.op !== 'create' && change.op !== 'update') || !change.entityId || !change.inverse) return;
  const kind = change.kind;
  if (!isNamed(kind)) return;
  const key = NAMES_KEY[kind];
  const fields = fieldsOf(change.payload);
  const written = [...(isNames(fields[key]) ? fields[key] : []), ...MAIN_NAMES[kind].map((k) => fields[k])];
  const norms = new Set(written.filter((n) => typeof n === 'string').map(normalizeTitle));
  if (!norms.size) return;
  const keep = (names: string[]) => names.filter((n) => !norms.has(normalizeTitle(n)));
  const family = await mergeFamily(tx, await resolveWinner(tx, await contentEntityOf(tx, change)));
  for (const id of family) {
    const { list } = await namesOf(tx, kind, id);
    const kept = keep(list);
    if (kept.length !== list.length) await writeAlternateNames(tx, kind, id, kept);
  }
  const others = await tx
    .select()
    .from(changes)
    .where(and(ne(changes.id, change.id), or(inArray(changes.entityId, family), eq(changes.op, 'merge'))));
  for (const other of others) {
    const parsed = InverseSchema.safeParse(other.inverse);
    const inverse = parsed.success ? parsed.data : null;
    let scrubbed: Inverse | null = null;
    if (inverse?.op === 'unmerge' && inverse.intoNames && family.includes(inverse.into)) {
      const value = keep(inverse.intoNames.value);
      if (value.length !== inverse.intoNames.value.length) {
        scrubbed = { ...inverse, intoNames: { ...inverse.intoNames, value } };
      }
    }
    const held = inverse?.op === 'set_fields' && family.includes(inverse.entityId) ? inverse.fields[key] : null;
    if (inverse?.op === 'set_fields' && isNames(held) && keep(held).length !== held.length) {
      scrubbed = { ...inverse, fields: { ...inverse.fields, [key]: keep(held) } };
    }
    const base = other.base;
    const based = base?.[key];
    const eraseBase = !!base && isNames(based) && keep(based).length !== based.length;
    if (!scrubbed && !eraseBase) continue;
    await tx
      .update(changes)
      .set({
        inverse: scrubbed ?? other.inverse,
        base: base && eraseBase ? { ...base, [key]: REDACTED_VALUE } : base,
      })
      .where(eq(changes.id, other.id));
  }
}

/** Retires a relation on behalf of a redaction; it is recorded as removed by that change. */
export async function applyRelationRemoval(tx: Tx, relationId: string, changeId: string): Promise<void> {
  await tx.update(relations).set({ removedByChange: changeId }).where(eq(relations.id, relationId));
}
