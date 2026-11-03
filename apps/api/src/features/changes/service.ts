import { randomUUID } from 'node:crypto';
import {
  CreatorRole,
  type EntityKind,
  FieldsFor,
  type MediaType,
  type RelationType,
  WorkFieldsBase,
} from '@amdb/shared';
import type { z } from '@hono/zod-openapi';
import type { Db } from '../../platform/db/types';
import type { Actor } from '../../platform/http/app-env';
import { badRequest, notFound } from '../../platform/http/errors';
import { decodeCursor, toPage } from '../../platform/http/pagination';
import { isModerator } from '../users/identity';
import { type ChangeInput, type EntityRef, type SubmissionInput } from './schemas';
import { changesRepository, type NewChange, type Owner } from './repository';

/** An entity a change refers to: existing, or reserved by a pending create. */
interface Resolved {
  id: string;
  kind: EntityKind;
  mediaType: MediaType | null;
  /** The pending create that reserved it, if it isn't an entity yet. */
  dependsOn: string | null;
}

/** Which kinds each relation joins, and which `data` keys it needs and allows. */
const RELATION_RULES: Record<
  RelationType,
  { from: EntityKind; to: EntityKind | null; required: string[]; allowed: string[] }
> = {
  work_creator: { from: 'work', to: 'creator', required: ['role'], allowed: ['role', 'position'] },
  series_work: { from: 'series', to: 'work', required: ['position'], allowed: ['position'] },
  property_work: { from: 'property', to: 'work', required: [], allowed: [] },
  work_link: { from: 'work', to: 'work', required: ['linkType'], allowed: ['linkType'] },
  work_tag: { from: 'work', to: 'tag', required: [], allowed: [] },
  external_id: { from: 'work', to: null, required: ['scheme', 'value'], allowed: ['scheme', 'value'] },
};

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

export function createChangesService(db: Db) {
  const repo = changesRepository(db);

  /** Whether the actor may see this pending create: its author, or a moderator. */
  const canSee = (actor: Actor, row: { authorUserId: string | null; anonHash: string | null }) =>
    isModerator(actor) ||
    (actor.kind === 'user' && row.authorUserId === actor.userId) ||
    (actor.kind === 'anon' && row.anonHash === actor.anonHash);

  async function lookupEntity(actor: Actor, id: string): Promise<Resolved> {
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

  return {
    async createSubmission(actor: Actor, input: SubmissionInput) {
      const owner = ownerOf(actor);
      if (!owner) throw identityRequired();

      const refs = new Map<string, Resolved>();
      const rows: NewChange[] = [];

      const resolve = async (index: number, ref: EntityRef): Promise<Resolved> => {
        if ('id' in ref) return lookupEntity(actor, ref.id);
        const found = refs.get(ref.ref);
        if (!found) {
          throw badRequest(
            'unknown_ref',
            `Change ${index + 1} uses ref "${ref.ref}", which no earlier create declares`,
          );
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

      for (const [index, change] of input.changes.entries()) {
        const seq = index + 1;
        const id = randomUUID();
        rows.push(await toRow(change, index, seq, id));
      }

      async function toRow(change: ChangeInput, index: number, seq: number, id: string): Promise<NewChange> {
        switch (change.op) {
          case 'create': {
            if (refs.has(change.ref)) throw badRequest('duplicate_ref', `Ref "${change.ref}" is declared twice`);
            const parsed = FieldsFor[change.kind].safeParse(change.fields);
            if (!parsed.success) throw invalidFields(index, parsed.error);
            const payload: Record<string, unknown> = parsed.data;
            const entityId = randomUUID();
            const mediaType = payload.mediaType;
            refs.set(change.ref, {
              id: entityId,
              kind: change.kind,
              mediaType: mediaType === 'film_tv' || mediaType === 'book' ? mediaType : null,
              dependsOn: id,
            });
            return { id, seq, op: 'create', kind: change.kind, entityId, payload, dependsOn: [] };
          }
          case 'update': {
            const target = await lookupEntity(actor, change.entityId);
            expectKind(index, target, change.kind);
            // `.partial()` of the create shape; a work's cross-field rules are checked when it is applied.
            const shape = change.kind === 'work' ? WorkFieldsBase.partial() : FieldsFor[change.kind].partial();
            const parsed = shape.safeParse(change.fields);
            if (!parsed.success) throw invalidFields(index, parsed.error);
            const payload: Record<string, unknown> = parsed.data;
            const keys = Object.keys(payload);
            if (keys.length === 0) {
              throw badRequest('invalid_fields', `Change ${index + 1} changes no fields`);
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
            expectKind(index, from, rule.from);
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
            if (change.from === change.into) throw badRequest('invalid_merge', 'An entity can’t merge into itself');
            const from = await lookupEntity(actor, change.from);
            const into = await lookupEntity(actor, change.into);
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

      return db.transaction((tx) => changesRepository(tx).insertSubmission(owner, input.note, rows));
    },

    /** Visible to its author and to moderators; everyone else gets a 404. */
    async getSubmission(actor: Actor, id: string) {
      const found = await repo.getSubmission(id);
      if (
        !found ||
        !canSee(actor, { authorUserId: found.submission.authorUserId, anonHash: found.submission.anonHash })
      ) {
        throw notFound();
      }
      return found;
    },

    async listMine(actor: Actor, query: { cursor?: string; limit: number }) {
      const owner = ownerOf(actor);
      if (!owner) throw identityRequired();
      const subs = await repo.listSubmissions(owner, decodeCursor(query.cursor), query.limit);
      return toPage(subs, query.limit, (s) => ({ createdAt: s.createdAt, id: s.id }));
    },
  };
}
export type ChangesService = ReturnType<typeof createChangesService>;
