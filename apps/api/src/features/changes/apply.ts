import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type EntityKind, FieldsFor } from '@amdb/shared';
import { z } from '@hono/zod-openapi';
import { and, arrayContains, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { changes, creators, entities, properties, relations, series, tags, works } from '../../platform/db/schema';
import type { Tx } from '../../platform/db/types';
import { ApiError, conflict } from '../../platform/http/errors';
import { normalizeTitle } from '../catalog/normalize';
import type { ChangeRow } from './repository';
import { RelatePayload, UnrelatePayload } from './schemas';

/**
 * The one place catalog tables are written (constitution VIII). Each applied change returns the
 * inverse that undoes it, which is stored on the change so a rejection or revert is itself exact.
 */

export const InverseSchema = z.discriminatedUnion('op', [
  /** Inverse of a create. */
  z.object({ op: z.literal('delete_entity'), entityId: z.uuid() }),
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
  z.object({ op: z.literal('unmerge'), from: z.uuid(), into: z.uuid(), movedRelationIds: z.array(z.uuid()) }),
]);
export type Inverse = z.infer<typeof InverseSchema>;

/** A change's fields without `submitted`, the contributor's original kept by edit-and-approve. */
export function fieldsOf(payload: Record<string, unknown> | null): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload ?? {}).filter(([k]) => k !== 'submitted'));
}

const KIND_TABLES = { work: works, creator: creators, series, property: properties, tag: tags } as const;

/** Columns derived from others, never part of a kind's fields. */
const DERIVED = new Set(['entityId', 'titleNorm', 'nameNorm', 'search']);
/** Fields whose null is a value (`subtype` is null for a book), not "absent". */
const NULLABLE = new Set(['subtype']);

/** A kind row as its zod field schema's input: derived columns dropped and absent values (null) left out. */
const asInput = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).filter(([k, v]) => !DERIVED.has(k) && (v !== null || NULLABLE.has(k))));

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
        description: f.description ?? null,
        releaseYear: f.releaseYear ?? null,
        releaseMonth: f.releaseMonth ?? null,
        releaseDay: f.releaseDay ?? null,
        lifecycle: f.lifecycle,
        attributes: f.attributes ?? {},
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
      const values = { kind: f.kind, name: f.name, slug: f.slug };
      if (mode === 'insert') await tx.insert(tags).values({ entityId: id, ...values });
      else await tx.update(tags).set(values).where(eq(tags.entityId, id));
      return;
    }
  }
}

async function kindRow(tx: Tx, kind: EntityKind, id: string): Promise<Record<string, unknown>> {
  const table = KIND_TABLES[kind];
  const [row] = await tx.select().from(table).where(eq(table.entityId, id));
  if (!row) throw new Error(`entity ${id} has no ${kind} row`);
  return row;
}

/** Follows `merged_into_id` to the entity that finally holds `id`'s data. */
async function winner(tx: Tx, id: string): Promise<string> {
  let current = id;
  const seen = new Set<string>();
  for (;;) {
    const [row] = await tx.select({ into: entities.mergedIntoId }).from(entities).where(eq(entities.id, current));
    if (!row?.into) return current;
    if (seen.has(current)) throw new Error(`merge cycle at ${current}`);
    seen.add(current);
    current = row.into;
  }
}

/** The live entity `id`, locked for the rest of the transaction. */
async function lockEntity(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(entities)
    .where(and(eq(entities.id, id), isNull(entities.removedAt)))
    .for('update');
  return row ?? null;
}

async function requireEntity(tx: Tx, id: string) {
  const entity = await lockEntity(tx, id);
  if (!entity) throw conflict('dependency_pending', `Entity ${id} doesn't exist yet`);
  return entity;
}

/** The change's target entity, after merges. */
function targetOf(change: ChangeRow): string {
  if (!change.entityId) throw new Error(`change ${change.id} (${change.op}) has no entity id`);
  return change.entityId;
}

const notImplemented = () => new ApiError(501, 'not_implemented', 'Merging isn’t available yet');

/** Applies one change to current state in `tx`, returning its inverse. Throws ApiError on conflict. */
export async function applyChange(tx: Tx, change: ChangeRow): Promise<Inverse> {
  const fields = fieldsOf(change.payload);
  switch (change.op) {
    case 'create': {
      const id = targetOf(change);
      const [existing] = await tx.select({ id: entities.id }).from(entities).where(eq(entities.id, id));
      if (existing) throw conflict('already_exists', `Entity ${id} already exists`);
      await tx.insert(entities).values({
        id,
        kind: change.kind,
        fieldSources: Object.fromEntries(Object.keys(fields).map((k) => [k, change.id])),
      });
      await writeRow(tx, change.kind, id, fields, 'insert');
      return { op: 'delete_entity', entityId: id };
    }
    case 'update': {
      const id = await winner(tx, targetOf(change));
      const entity = await requireEntity(tx, id);
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
      await writeRow(tx, change.kind, id, { ...asInput(current), ...fields }, 'update');
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
      const from = await winner(tx, p.from);
      await requireEntity(tx, from);
      const to = p.to ? await winner(tx, p.to) : null;
      if (to) await requireEntity(tx, to);
      const relationId = randomUUID();
      await tx.insert(relations).values({
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
      });
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
    case 'merge':
      throw notImplemented();
  }
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
      const dependents = await tx
        .select({ id: changes.id })
        .from(changes)
        .where(
          and(
            ne(changes.id, change.id),
            inArray(changes.status, ['published', 'approved']),
            or(arrayContains(changes.dependsOn, [change.id]), eq(changes.entityId, id)),
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
      const id = await winner(tx, targetOf(change));
      const entity = await requireEntity(tx, id);
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
    case 'merge':
      throw notImplemented();
  }
}

/** Undoes an applied change. `byChangeId` is the change doing the undoing, recorded where a row is retired. */
export async function applyInverse(tx: Tx, inverse: Inverse, byChangeId: string): Promise<void> {
  switch (inverse.op) {
    case 'delete_entity': {
      // The one hard delete of current state: allowed only while nothing references the entity.
      const id = inverse.entityId;
      const referencing = await tx
        .select({ id: relations.id })
        .from(relations)
        .where(or(eq(relations.fromId, id), eq(relations.toId, id)));
      const mergedIn = await tx.select({ id: entities.id }).from(entities).where(eq(entities.mergedIntoId, id));
      if (referencing.length || mergedIn.length) {
        throw conflict('has_dependents', 'Other records still reference this entity', {
          relationIds: referencing.map((r) => r.id),
          entityIds: mergedIn.map((e) => e.id),
        });
      }
      const entity = await lockEntity(tx, id);
      if (!entity) throw conflict('stale_change', `Entity ${id} no longer exists`);
      const table = KIND_TABLES[entity.kind];
      await tx.delete(table).where(eq(table.entityId, id));
      await tx.delete(entities).where(eq(entities.id, id));
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
    case 'unmerge':
      throw notImplemented();
  }
}
