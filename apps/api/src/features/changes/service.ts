import { randomUUID } from 'node:crypto';
import {
  CreatorRole,
  type EntityKind,
  FieldsFor,
  type MediaType,
  normalizeTitle,
  type RelationType,
  UpdateFieldsFor,
} from '@amdb/shared';
import type { z } from '@hono/zod-openapi';
import type { Db, Tx } from '../../platform/db/types';
import type { Actor } from '../../platform/http/app-env';
import { resolveWinner } from '../../platform/db/merge';
import {
  ApiError,
  badRequest,
  conflict,
  gone,
  isUniqueViolation,
  notFound,
  unauthenticated,
} from '../../platform/http/errors';
import { decodeCursor, decodeKeyCursor, encodeKeyCursor, toPage } from '../../platform/http/pagination';
import { createImportsService } from '../imports/service';
import { anonHashOf, isAdmin, isModerator } from '../users/identity';
import {
  applyChange,
  applyInverse,
  applyRelationRemoval,
  applyRemoval,
  eraseRedacted,
  scrubRedacted,
  assertUndoable,
  currentContent,
  duplicateExternalId,
  duplicateSlug,
  fieldsOf,
  type Inverse,
  InverseSchema,
  withoutAbsent,
} from './apply';
import { publicAuthor, runOf } from './author';
import {
  type ChangeRow,
  changesRepository,
  type HistoryKey,
  type NewChange,
  type Owner,
  type QueueKey,
} from './repository';
import { holdAll, type ReviewPolicy } from './review-policy';
import {
  type ApproveInput,
  type RedactInput,
  ChangeInput,
  HistoryCursor,
  type HistorySchema,
  QueueCursor,
  type EntityRef,
  MergePayload,
  RelatePayload,
  type ResubmitInput,
  type SubmissionInput,
  UnrelatePayload,
} from './schemas';

/** An entity a change refers to: existing, or reserved by a pending create. */
interface Resolved {
  id: string;
  kind: EntityKind;
  mediaType: MediaType | null;
  /** The pending create that reserved it, if it isn't an entity yet. */
  dependsOn: string | null;
}

/** Which kinds each relation joins (`from` lists every kind it may start at), and which `data` keys it needs and allows. */
const RELATION_RULES: Record<
  RelationType,
  { from: EntityKind[]; to: EntityKind | null; required: string[]; allowed: string[] }
> = {
  work_creator: { from: ['work'], to: 'creator', required: ['role'], allowed: ['role', 'position'] },
  series_work: { from: ['series'], to: 'work', required: ['position'], allowed: ['position'] },
  property_work: { from: ['property'], to: 'work', required: [], allowed: [] },
  work_link: { from: ['work'], to: 'work', required: ['linkType'], allowed: ['linkType'] },
  work_tag: { from: ['work'], to: 'tag', required: [], allowed: [] },
  external_id: {
    from: ['work', 'creator', 'series', 'property'],
    to: null,
    required: ['scheme', 'value'],
    allowed: ['scheme', 'value'],
  },
};

/**
 * Who an import plans as: no one. It sees no one's pending creates and has no moderator rights, so
 * its changes can only name live entities and its own refs. Kept inside this service rather than
 * widening the HTTP `Actor`, since no request can ever be an importer.
 */
const IMPORTER: Actor = { kind: 'none' };

const ownerOf = (actor: Actor): Owner | null =>
  actor.kind === 'user' ? { userId: actor.userId } : actor.kind === 'anon' ? { anonHash: actor.anonHash } : null;

const identityRequired = () =>
  badRequest('identity_required', 'Sign in, or send an x-amdb-anon token (32–128 URL-safe characters).');

function invalidFields(index: number, error: z.ZodError) {
  return badRequest(
    'invalid_fields',
    `Change ${index + 1} has invalid fields`,
    error.issues.map((i) => ({ path: ['changes', index, 'fields', ...i.path].join('.'), message: i.message })),
  );
}

/** The submitter of a change or submission, by account or anonymous token. */
interface Authored {
  authorUserId: string | null;
  anonHash: string | null;
}

const isAuthor = (actor: Actor, row: Authored) =>
  (actor.kind === 'user' && row.authorUserId === actor.userId) ||
  (actor.kind === 'anon' && row.anonHash === actor.anonHash);

/** Whether the actor may see a pending or rejected submission: its author, or a moderator. */
const canSee = (actor: Actor, row: Authored) => isModerator(actor) || isAuthor(actor, row);

/** A change counts as met for its dependents once it is live. */
const isLive = (status: string) => status === 'published' || status === 'approved';

const notEditable = (op: string, what: 'fields' | 'data') =>
  badRequest('not_editable', `A ${op} change has no ${what} to edit`);

/** The field shape a create or update payload must match: a create's full shape, or the update shape (null clears). */
const shapeFor = (op: 'create' | 'update', kind: EntityKind) =>
  op === 'create' ? FieldsFor[kind] : UpdateFieldsFor[kind];

/** A validated change and the row it will be stored as. */
interface Planned {
  input: ChangeInput;
  row: NewChange;
}

/** The stored inverse of a live change. */
function inverseOf(change: ChangeRow): Inverse {
  // Every live change was stored with its inverse; a missing one is a bug, not a user error.
  return InverseSchema.parse(change.inverse);
}

/** The relation a change acts on once applied: the one a relate created, else the one it names. */
const relationAfter = (change: ChangeRow, inverse: Inverse) =>
  inverse.op === 'remove_relation' ? inverse.relationId : change.relationId;

/** Rebuilds a rejected change as a new submission's input, with the author's edits merged in. */
function resubmission(change: ChangeRow, edits: ResubmitInput): ChangeInput {
  if (change.redactedAt || !change.payload)
    throw conflict('redacted', 'This change was removed and can’t be resubmitted');
  if (edits.fields && change.op !== 'create' && change.op !== 'update') throw notEditable(change.op, 'fields');
  if (edits.data && change.op !== 'relate') throw notEditable(change.op, 'data');
  let candidate: unknown;
  switch (change.op) {
    case 'create':
      candidate = {
        op: 'create',
        kind: change.kind,
        ref: 'resubmitted',
        // A create has no old value to clear, so a null edit just leaves the field out.
        fields: withoutAbsent({ ...fieldsOf(change.payload), ...edits.fields }),
      };
      break;
    case 'update':
      candidate = {
        op: 'update',
        kind: change.kind,
        entityId: change.entityId,
        fields: { ...fieldsOf(change.payload), ...edits.fields },
      };
      break;
    case 'relate': {
      const p = RelatePayload.parse(change.payload);
      candidate = {
        op: 'relate',
        type: p.type,
        from: { id: p.from },
        ...(p.to ? { to: { id: p.to } } : {}),
        data: { ...p.data, ...edits.data },
      };
      break;
    }
    case 'unrelate':
      candidate = { op: 'unrelate', ...UnrelatePayload.parse(change.payload) };
      break;
    case 'merge':
      candidate = { op: 'merge', kind: change.kind, ...MergePayload.parse(change.payload) };
      break;
  }
  const parsed = ChangeInput.safeParse(candidate);
  if (!parsed.success) {
    throw badRequest(
      'invalid_fields',
      'The resubmitted change is invalid',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

export function createChangesService(db: Db, policy: ReviewPolicy = holdAll) {
  const repo = changesRepository(db);

  /** A loser id is still a valid name for its winner (ids are permanent): the result carries the winner. */
  async function lookupEntity(actor: Actor, named: string): Promise<Resolved> {
    const id = await resolveWinner(db, named);
    const entity = await repo.findEntity(id);
    if (entity) return { id, kind: entity.kind, mediaType: entity.mediaType, dependsOn: null };
    const pending = await repo.findPendingCreate(id);
    if (pending && canSee(actor, pending)) {
      const mediaType = pending.payload?.mediaType;
      return {
        id,
        kind: pending.kind,
        mediaType: mediaType === 'film_tv' || mediaType === 'book' ? mediaType : null,
        dependsOn: pending.changeId,
      };
    }
    throw badRequest('unknown_entity', `No entity ${id}`);
  }

  /** Validates changes and turns them into rows: refs resolved, `base` captured, `depends_on` worked out. */
  async function plan(actor: Actor, items: { change: ChangeInput; reservedId?: string }[]): Promise<Planned[]> {
    const refs = new Map<string, Resolved>();
    const planned: Planned[] = [];

    const resolve = async (index: number, ref: EntityRef): Promise<Resolved> => {
      if ('id' in ref) return lookupEntity(actor, ref.id);
      const found = refs.get(ref.ref);
      if (!found) {
        throw badRequest('unknown_ref', `Change ${index + 1} uses ref "${ref.ref}", which no earlier create declares`);
      }
      return found;
    };
    const expectKind = (index: number, entity: Resolved, kind: EntityKind) => {
      if (entity.kind !== kind) {
        throw badRequest('kind_mismatch', `Change ${index + 1}: ${entity.id} is a ${entity.kind}, not a ${kind}`);
      }
    };
    const depends = (...entities: (Resolved | null)[]) => [
      ...new Set(entities.flatMap((e) => (e?.dependsOn ? [e.dependsOn] : []))),
    ];

    for (const [index, item] of items.entries()) {
      planned.push({
        input: item.change,
        row: await toRow(item.change, index, index + 1, randomUUID(), item.reservedId),
      });
    }
    return planned;

    async function toRow(
      change: ChangeInput,
      index: number,
      seq: number,
      id: string,
      reservedId?: string,
    ): Promise<NewChange> {
      switch (change.op) {
        case 'create': {
          if (refs.has(change.ref)) throw badRequest('duplicate_ref', `Ref "${change.ref}" is declared twice`);
          const parsed = FieldsFor[change.kind].safeParse(change.fields);
          if (!parsed.success) throw invalidFields(index, parsed.error);
          const payload: Record<string, unknown> = parsed.data;
          if (change.kind === 'tag' && typeof payload.slug === 'string') {
            const existing = await repo.findTagBySlug(payload.slug);
            if (existing) throw duplicateSlug(payload.slug, existing);
          }
          // A resubmitted create keeps the id its first submission reserved.
          const entityId = reservedId ?? randomUUID();
          const mediaType = payload.mediaType;
          refs.set(change.ref, {
            id: entityId,
            kind: change.kind,
            mediaType: mediaType === 'film_tv' || mediaType === 'book' ? mediaType : null,
            dependsOn: id,
          });
          // `title` for works, series and properties; `name` for creators and tags.
          const label = payload.title ?? payload.name;
          const titleNorm = typeof label === 'string' ? normalizeTitle(label) : null;
          return { id, seq, op: 'create', kind: change.kind, entityId, payload, titleNorm, dependsOn: [] };
        }
        case 'update': {
          const target = await lookupEntity(actor, change.entityId);
          expectKind(index, target, change.kind);
          // A work's cross-field rules are checked when it is applied.
          const parsed = shapeFor('update', change.kind).safeParse(change.fields);
          if (!parsed.success) throw invalidFields(index, parsed.error);
          const payload: Record<string, unknown> = parsed.data;
          const keys = Object.keys(payload);
          if (keys.length === 0) {
            throw badRequest('invalid_fields', `Change ${index + 1} changes no fields`);
          }
          // Caught here as for a create, or the change could be submitted but never approved.
          if (change.kind === 'tag' && typeof payload.slug === 'string') {
            const existing = await repo.findTagBySlug(payload.slug);
            if (existing && existing !== target.id) throw duplicateSlug(payload.slug, existing);
          }
          // A reserved entity has no row yet, so there is nothing to record as its base.
          const base = target.dependsOn ? null : await repo.currentFields(change.kind, target.id, keys);
          return {
            id,
            seq,
            op: 'update',
            kind: change.kind,
            entityId: target.id,
            payload,
            base,
            dependsOn: depends(target),
          };
        }
        case 'relate': {
          const rule = RELATION_RULES[change.type];
          const from = await resolve(index, change.from);
          if (!rule.from.includes(from.kind)) {
            throw badRequest(
              'kind_mismatch',
              `Change ${index + 1}: ${from.id} is a ${from.kind}, not a ${rule.from.join(' or ')}`,
            );
          }
          let to: Resolved | null = null;
          if (rule.to) {
            if (!change.to) throw badRequest('invalid_relation', `Change ${index + 1}: ${change.type} needs "to"`);
            to = await resolve(index, change.to);
            expectKind(index, to, rule.to);
          } else if (change.to) {
            throw badRequest('invalid_relation', `Change ${index + 1}: ${change.type} takes no "to"`);
          }
          const given = Object.keys(change.data);
          const extra = given.filter((k) => !rule.allowed.includes(k));
          const missing = rule.required.filter((k) => !given.includes(k));
          if (extra.length || missing.length) {
            throw badRequest(
              'invalid_relation',
              `Change ${index + 1}: ${change.type} data ${missing.length ? `needs ${missing.join(', ')}` : `can't have ${extra.join(', ')}`}`,
            );
          }
          if (change.type === 'external_id' && change.data.scheme && change.data.value) {
            // An earlier change here that unrelates the holder's id frees it first (moving an id between works).
            const freed = planned.flatMap((p) =>
              p.row.op === 'unrelate' && p.row.relationId ? [p.row.relationId] : [],
            );
            const holder = await repo.findExternalIdHolder(change.data.scheme, change.data.value, freed);
            if (holder) throw duplicateExternalId(change.data.scheme, change.data.value, holder);
          }
          if (change.type === 'work_creator') {
            if (!from.mediaType)
              throw badRequest('invalid_relation', `Change ${index + 1}: the work has no media type`);
            if (!CreatorRole[from.mediaType].safeParse(change.data.role).success) {
              throw badRequest(
                'invalid_role',
                `Change ${index + 1}: "${change.data.role}" is not a role for a ${from.mediaType} work`,
                { allowed: CreatorRole[from.mediaType].options },
              );
            }
          }
          return {
            id,
            seq,
            op: 'relate',
            kind: from.kind,
            entityId: from.id,
            payload: { type: change.type, from: from.id, to: to?.id ?? null, data: change.data },
            dependsOn: depends(from, to),
          };
        }
        case 'unrelate': {
          const relation = await repo.findActiveRelation(change.relationId);
          if (!relation) throw badRequest('unknown_relation', `No active relation ${change.relationId}`);
          return {
            id,
            seq,
            op: 'unrelate',
            kind: relation.fromKind,
            entityId: relation.fromId,
            relationId: change.relationId,
            payload: { relationId: change.relationId },
            dependsOn: [],
          };
        }
        case 'merge': {
          // Either side may name a merged entity: both go to their winners.
          const from = await lookupEntity(actor, change.from);
          const into = await lookupEntity(actor, change.into);
          if (from.id === into.id) throw badRequest('self_merge', 'An entity can’t merge into itself');
          expectKind(index, from, change.kind);
          expectKind(index, into, change.kind);
          return {
            id,
            seq,
            op: 'merge',
            kind: change.kind,
            entityId: from.id,
            payload: { from: from.id, into: into.id },
            dependsOn: depends(from, into),
          };
        }
      }
    }
  }

  /**
   * Stores a submission and asks the review policy about each change in order. A `publish`
   * decision applies the change now, unless something it depends on isn't live yet. A change
   * that conflicts with current state when applied is held for a moderator instead (its attempt
   * runs in a savepoint), so the rest of the submission still goes in.
   */
  async function store(tx: Tx, actor: Actor, owner: Owner, note: string | undefined, items: Planned[]) {
    const r = changesRepository(tx);
    const created = await r.insertSubmission(
      owner,
      note,
      items.map((i) => i.row),
    );
    const live = new Set<string>();
    for (const { input, row } of items) {
      if ((await policy({ change: input, actor })) !== 'publish') continue;
      const waiting = row.dependsOn.filter((d) => !live.has(d));
      const deps = await r.lockStatuses(waiting);
      if (deps.length !== waiting.length || !deps.every((d) => isLive(d.status))) continue;
      try {
        await tx.transaction((sp) => applyNow(sp, row.id, 'published'));
      } catch (err) {
        // Not swallowed: the change stays pending, and a moderator approving it gets this same error.
        if (err instanceof ApiError || isUniqueViolation(err)) continue;
        throw err;
      }
      live.add(row.id);
    }
    return {
      id: created.id,
      changes: created.changes.map((c) => (live.has(c.id) ? { ...c, status: 'published' as const } : c)),
    };
  }

  /** Applies a locked change and records its inverse; `extra` is merged into the change row. */
  async function applyNow(tx: Tx, id: string, status: 'published' | 'approved', extra: Partial<ChangeRow> = {}) {
    const r = changesRepository(tx);
    const locked = await r.lockChange(id);
    if (!locked) throw new Error(`change ${id} vanished`);
    const change = { ...locked, ...extra };
    const inverse = await applyChange(tx, change);
    await r.updateChange(id, {
      ...extra,
      status,
      inverse,
      relationId: relationAfter(change, inverse),
      appliedAt: new Date(),
    });
  }

  /**
   * Rejects the pending changes that depend on `roots`, transitively. A rejected create (or a
   * removed or reverted entity) also takes down pending changes made against its entity after it went live:
   * they name the entity but, submitted once it existed, have no `depends_on` entry.
   */
  async function cascadeReject(
    r: ReturnType<typeof changesRepository>,
    roots: string[],
    entityId: string | null,
    reviewed: { reviewedBy: string; reviewedAt: Date },
    entityReason: string,
  ) {
    const because = (dep: string) => ({ ...reviewed, reason: `Depends on rejected change ${dep}` });
    const targeting = entityId ? await r.rejectPendingTargeting(entityId, { ...reviewed, reason: entityReason }) : [];
    let frontier = [...roots, ...targeting];
    while (frontier.length) {
      const next: string[] = [];
      for (const dep of frontier) next.push(...(await r.rejectPendingDependents(dep, because(dep))));
      frontier = next;
    }
  }

  /** Edit-and-approve: the moderator's fields merged in, the contributor's original kept as `submitted`. */
  function edited(change: ChangeRow, fields: Record<string, unknown>) {
    if (change.op !== 'create' && change.op !== 'update') throw notEditable(change.op, 'fields');
    const original = fieldsOf(change.payload);
    // A moderator corrects what was submitted; adding fields is a change of its own.
    const outOfScope = Object.keys(fields).filter((k) => !(k in original));
    if (outOfScope.length) {
      throw badRequest('edit_out_of_scope', 'An edit may only change fields the change submitted', {
        fields: outOfScope,
      });
    }
    const parsed = shapeFor(change.op, change.kind).safeParse({ ...original, ...fields });
    if (!parsed.success) {
      throw badRequest(
        'invalid_fields',
        'The edited fields are invalid',
        parsed.error.issues.map((i) => ({ path: ['fields', ...i.path].join('.'), message: i.message })),
      );
    }
    const payload: Record<string, unknown> = { ...parsed.data, submitted: original };
    return payload;
  }

  /** Locks a change for review: moderators only (others 404), and not already reviewed. */
  async function lockForReview(tx: Tx, actor: Actor, id: string) {
    if (actor.kind !== 'user' || !isModerator(actor)) throw notFound();
    const change = await changesRepository(tx).lockChange(id);
    if (!change) throw notFound();
    if (change.redactedAt) throw conflict('redacted', 'This change was removed and can’t be reviewed');
    if (change.status === 'approved' || change.status === 'rejected') {
      throw conflict('already_reviewed', `This change was already ${change.status}`);
    }
    return { change, reviewed: { reviewedBy: actor.userId, reviewedAt: new Date() } };
  }

  return {
    async createSubmission(actor: Actor, input: SubmissionInput) {
      const owner = ownerOf(actor);
      if (!owner) throw identityRequired();
      const items = await plan(
        actor,
        input.changes.map((change) => ({ change })),
      );
      return db.transaction((tx) => store(tx, actor, owner, input.note, items));
    },

    /**
     * Writes an import run's submission: planned like a submit (same errors, such as
     * `duplicate_external_id` 409), then every change applied in order as `approved`, with no
     * reviewer. One transaction, so a change that fails to apply leaves nothing of it behind.
     */
    async importSubmission(runId: string, changes: ChangeInput[]) {
      // An unknown run is a 404; a finished one takes no more work (say, after an interrupt).
      const run = await createImportsService(db).getRun(runId);
      if (run.status !== 'running') throw conflict('run_not_running', `import run ${runId} is ${run.status}`);
      const items = await plan(
        IMPORTER,
        changes.map((change) => ({ change })),
      );
      return db.transaction(async (tx) => {
        const created = await changesRepository(tx).insertSubmission(
          { importRunId: runId },
          undefined,
          items.map((i) => i.row),
        );
        const reviewedAt = new Date();
        for (const c of created.changes) await applyNow(tx, c.id, 'approved', { reviewedBy: null, reviewedAt });
        return { id: created.id, changes: created.changes.map(({ id, entityId }) => ({ id, entityId })) };
      });
    },

    /**
     * The tag holding `slug` (its merge winner), so an importer can reuse it instead of creating a
     * duplicate. `live` is false for a retracted or removed tag: the slug is still taken, but nothing
     * can be related to it.
     */
    async tagBySlug(slug: string): Promise<{ id: string; live: boolean } | null> {
      const holder = await repo.findTagBySlug(slug);
      if (!holder) return null;
      const id = await resolveWinner(db, holder);
      return { id, live: (await repo.findEntity(id)) !== null };
    },

    /** One change, with the submission it belongs to: visible to its author and to moderators; everyone else gets a 404. */
    async getChange(actor: Actor, id: string) {
      const found = await repo.getChangeWithAuthor(id);
      if (!found || !canSee(actor, found)) throw notFound();
      return found.change;
    },

    /** How many of the caller's pending edits touch an entry; none without an identity. */
    async countMyPending(actor: Actor, entityId: string) {
      const owner = ownerOf(actor);
      return owner ? repo.countPending(owner, entityId) : 0;
    },

    /** Visible to its author and to moderators; everyone else gets a 404. */
    async getSubmission(actor: Actor, id: string) {
      const found = await repo.getSubmission(id);
      if (!found || !canSee(actor, found.submission)) throw notFound();
      return found;
    },

    /** With no identity there is nothing of the caller's to list, so a visitor who never submitted needs no token. */
    async listMine(actor: Actor, query: { cursor?: string; limit: number }) {
      const owner = ownerOf(actor);
      if (!owner) return { items: [], nextCursor: null };
      const subs = await repo.listSubmissions(owner, decodeCursor(query.cursor), query.limit);
      return toPage(subs, query.limit, (s) => ({ createdAt: s.createdAt, id: s.id }));
    },

    /** Pending and published changes, oldest first. Moderators only; anyone else gets a 404. */
    async queue(actor: Actor, query: { cursor?: string; limit: number }) {
      if (!isModerator(actor)) throw notFound();
      const rows = await repo.queue(decodeKeyCursor(query.cursor, QueueCursor), query.limit);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      const key = (c: ChangeRow): QueueKey => ({
        createdAt: c.createdAt.toISOString(),
        submissionId: c.submissionId,
        seq: c.seq,
      });
      return { items, nextCursor: rows.length > query.limit && last ? encodeKeyCursor(key(last.change)) : null };
    },

    /** Applies a pending change (optionally edited first), or confirms a published one. */
    async approve(actor: Actor, id: string, input: ApproveInput) {
      return db.transaction(async (tx) => {
        const { change, reviewed } = await lockForReview(tx, actor, id);
        const edit = input.fields && Object.keys(input.fields).length ? input.fields : null;
        if (change.status === 'published') {
          if (edit)
            throw conflict('already_published', 'This change is already live; submit a new change to correct it');
          await changesRepository(tx).updateChange(id, { ...reviewed, status: 'approved' });
          return { id, status: 'approved' as const };
        }
        const deps = await changesRepository(tx).lockStatuses(change.dependsOn);
        const unmet = change.dependsOn.filter((d) => !deps.some((x) => x.id === d && isLive(x.status)));
        if (unmet.length) {
          throw conflict('dependency_pending', 'Approve the changes this one depends on first', { changeIds: unmet });
        }
        await applyNow(tx, id, 'approved', { ...reviewed, ...(edit ? { payload: edited(change, edit) } : {}) });
        return { id, status: 'approved' as const };
      });
    },

    /**
     * Rejects a change, undoing it if it was live, and rejects the pending changes that depend on
     * it. The change and its payload are kept so the author can fix and resubmit.
     */
    async reject(actor: Actor, id: string, reason: string) {
      return db.transaction(async (tx) => {
        const r = changesRepository(tx);
        const { change, reviewed } = await lockForReview(tx, actor, id);
        if (change.status === 'published') {
          if (!change.inverse) throw conflict('redacted', 'This change’s undo data was removed; it can’t be rejected');
          if (await r.findRevert(id)) throw conflict('already_reverted', 'This change was already reverted');
          await assertUndoable(tx, change);
          await applyInverse(tx, inverseOf(change), change.id);
        }
        await r.updateChange(id, { ...reviewed, status: 'rejected', reason });
        await cascadeReject(
          r,
          [change.id],
          change.op === 'create' ? change.entityId : null,
          reviewed,
          `Depends on rejected change ${change.id}`,
        );
        return { id, status: 'rejected' as const };
      });
    },

    /** Approved and published changes that touched the entity, newest first. Public. A merged id answers `{ redirectTo }`. */
    async history(
      id: string,
      query: { cursor?: string; limit: number },
    ): Promise<{ redirectTo: string } | z.infer<typeof HistorySchema>> {
      if (await repo.isRemoved(id)) throw gone('removed', 'This entity was removed');
      // A merged id's history is its winner's.
      const winnerId = await resolveWinner(db, id);
      if (winnerId !== id) return { redirectTo: winnerId };
      if (!(await repo.findEntity(id))) throw notFound();
      const rows = await repo.history(id, decodeKeyCursor(query.cursor, HistoryCursor), query.limit);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1)?.change;
      const key = (c: ChangeRow): HistoryKey => ({
        // Every change in history was applied.
        appliedAt: (c.appliedAt ?? c.createdAt).toISOString(),
        seq: c.seq,
        id: c.id,
      });
      return {
        items: items.map(({ change: c, authorUserId, authorHandle, importRunId, importSource }) => {
          const run = runOf(importRunId, importSource);
          const author = publicAuthor(authorUserId, authorHandle, run);
          if (c.redactedAt) {
            return {
              changeId: c.id,
              op: c.op,
              redacted: true as const,
              reason: c.redactionReason,
              author,
              appliedAt: (c.appliedAt ?? c.createdAt).toISOString(),
            };
          }
          const revertOf = c.payload?.revertOf;
          return {
            changeId: c.id,
            op: c.op,
            // Without `submitted`: what a moderator edited out of a contributor's original stays out of public view.
            payload: fieldsOf(c.payload),
            author,
            source: run ? ('import' as const) : ('human' as const),
            appliedAt: (c.appliedAt ?? c.createdAt).toISOString(),
            revertOf: typeof revertOf === 'string' ? revertOf : null,
          };
        }),
        nextCursor: rows.length > query.limit && last ? encodeKeyCursor(key(last)) : null,
      };
    },

    /**
     * Undoes a live change as a new, approved change whose payload is `{ revertOf }`. Moderators
     * only (others 404). A revert has no inverse of its own: to undo one, submit the change again.
     */
    async revert(actor: Actor, id: string) {
      if (actor.kind !== 'user' || !isModerator(actor)) throw notFound();
      const moderator = actor.userId;
      return db.transaction(async (tx) => {
        const r = changesRepository(tx);
        const change = await r.lockChange(id);
        if (!change) throw notFound();
        if (!isLive(change.status)) throw conflict('not_live', 'Only an approved or published change can be reverted');
        if (change.redactedAt || !change.inverse) {
          throw conflict('redacted', 'This change was removed and can’t be reverted');
        }
        if (typeof change.payload?.revertOf === 'string') {
          throw conflict('not_revertable', 'A revert can’t be reverted; submit the change again instead');
        }
        if (await r.findRevert(id)) throw conflict('already_reverted', 'This change was already reverted');
        await assertUndoable(tx, change);
        const created = await r.insertSubmission({ userId: moderator }, `Revert of change ${id}`, [
          {
            id: randomUUID(),
            seq: 1,
            op: change.op,
            kind: change.kind,
            entityId: change.entityId,
            relationId: change.relationId,
            payload: { revertOf: id },
            dependsOn: [],
          },
        ]);
        const revertId = created.changes[0]?.id;
        if (!revertId) throw new Error('revert insert returned no row');
        const inverse = inverseOf(change);
        await applyInverse(tx, inverse, revertId);
        const now = new Date();
        await r.updateChange(revertId, { status: 'approved', reviewedBy: moderator, reviewedAt: now, appliedAt: now });
        // Pending changes that act on what the revert took away could only fail at approval: reject them now.
        const reviewed = { reviewedBy: moderator, reviewedAt: now };
        if (inverse.op === 'retract_entity') {
          await cascadeReject(r, [], inverse.entityId, reviewed, 'The entity was reverted');
        }
        if (inverse.op === 'remove_relation') {
          const unrelates = await r.rejectPendingUnrelates(inverse.relationId, {
            ...reviewed,
            reason: 'The relation was reverted',
          });
          await cascadeReject(r, unrelates, null, reviewed, 'The relation was reverted');
        }
        return { id: revertId, status: 'approved' as const };
      });
    },

    /**
     * Erases a change's content (legal or abuse removal), keeping who, when and why. Admins only
     * (others 404). Content that is still current in the catalog is removed with it, and only
     * when `removeEntity` is set, else 409 `content_is_current`: a create or update removes its
     * entity, a merge its loser, a relate its relation. A pending change is rejected so it can't
     * go live. A revert holds nothing to erase and is refused.
     */
    async redact(actor: Actor, id: string, input: RedactInput) {
      if (!isAdmin(actor) || actor.kind !== 'user') throw notFound();
      const admin = actor.userId;
      return db.transaction(async (tx) => {
        const r = changesRepository(tx);
        const change = await r.lockChange(id);
        if (!change) throw notFound();
        if (change.redactedAt) throw conflict('already_redacted', 'This change was already removed');
        if (typeof change.payload?.revertOf === 'string') {
          throw conflict('not_redactable', 'A revert holds no content; remove the change it reverted');
        }
        const now = new Date();
        const removed: { entityId: string | null; relationId: string | null } = { entityId: null, relationId: null };
        if (isLive(change.status)) {
          const current = await currentContent(tx, change);
          if (current && !input.removeEntity) {
            throw conflict(
              'content_is_current',
              'This change’s content is live; pass removeEntity: true to take it down too',
              {
                entityId: current.entityId,
                relationId: current.relationId,
              },
            );
          }
          if (current?.entityId) {
            await applyRemoval(tx, current.entityId);
            // Pending changes against it would only answer dependency_pending: reject them now.
            await cascadeReject(
              r,
              [],
              current.entityId,
              { reviewedBy: admin, reviewedAt: now },
              'The entity was removed',
            );
          }
          if (current?.relationId) await applyRelationRemoval(tx, current.relationId, change.id);
          removed.entityId = current?.entityId ?? null;
          removed.relationId = current?.relationId ?? null;
        }
        const pending = change.status === 'pending';
        await eraseRedacted(tx, change);
        await scrubRedacted(tx, change);
        await r.updateChange(id, {
          // A merge keeps `from` and `into`: ids aren't content, and history finds the merge by them.
          payload: change.op === 'merge' ? MergePayload.parse(change.payload) : null,
          base: null,
          inverse: null,
          titleNorm: null,
          redactedAt: now,
          redactionReason: input.reason,
          ...(pending
            ? { status: 'rejected' as const, reason: 'Removed by an administrator', reviewedBy: admin, reviewedAt: now }
            : {}),
        });
        if (pending) {
          await cascadeReject(
            r,
            [id],
            change.op === 'create' ? change.entityId : null,
            { reviewedBy: admin, reviewedAt: now },
            `Depends on rejected change ${id}`,
          );
        }
        return { id, ...removed };
      });
    },

    /** Moves every anonymous submission of this token to the signed-in user. Idempotent: a second claim moves none. */
    async claimAnonymous(actor: Actor, token: string | undefined) {
      if (actor.kind !== 'user') throw unauthenticated();
      // The session wins over the header in `resolveActor`, so the token is read from the header itself.
      const anonHash = anonHashOf(token);
      if (!anonHash)
        throw badRequest(
          'anon_token_required',
          'Send the anonymous token in x-amdb-anon (32–128 URL-safe characters).',
        );
      return { claimed: await repo.claimSubmissions(anonHash, actor.userId) };
    },

    /** The rejected change's author sends it again, as a new change in a new submission. */
    async resubmit(actor: Actor, id: string, edits: ResubmitInput) {
      const owner = ownerOf(actor);
      const found = await repo.getChangeWithAuthor(id);
      if (!owner || !found || !isAuthor(actor, found)) throw notFound();
      const { change } = found;
      if (change.status !== 'rejected') throw conflict('not_rejected', 'Only a rejected change can be resubmitted');
      const input = resubmission(change, edits);
      const [planned] = await plan(actor, [
        { change: input, reservedId: change.op === 'create' ? (change.entityId ?? undefined) : undefined },
      ]);
      if (!planned) throw new Error('plan returned no row');
      // Locking the rejected change makes a concurrent second resubmit wait, then see the first.
      return db.transaction(async (tx) => {
        await changesRepository(tx).lockChange(id);
        if (await changesRepository(tx).findResubmission(id)) {
          throw conflict('already_resubmitted', 'This change was already resubmitted');
        }
        return store(tx, actor, owner, undefined, [{ input, row: { ...planned.row, resubmitOf: id } }]);
      });
    },
  };
}
export type ChangesService = ReturnType<typeof createChangesService>;
