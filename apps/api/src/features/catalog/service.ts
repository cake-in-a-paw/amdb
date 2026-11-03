import { MediaType, type EntityKind } from '@amdb/shared';
import type { Db } from '../../platform/db/types';
import { resolveWinner } from '../../platform/db/merge';
import { notFound } from '../../platform/http/errors';
import { decodeKeyCursor, encodeKeyCursor } from '../../platform/http/pagination';
import { normalizeTitle } from './normalize';
import { catalogRepository } from './repository';
import { type EntityView, SearchCursor, type SearchQuery, type Summary } from './schemas';

/** Columns derived from others, not shown as fields. */
const DERIVED = new Set(['entityId', 'titleNorm', 'nameNorm', 'search']);

const byPosition = <T extends { position?: number }>(items: T[]) =>
  items.toSorted((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));

/** The most existing matches, and the most pending ones, a duplicate check lists. */
const DUPLICATE_LIMIT = 20;

interface SummaryRow {
  id: string;
  kind: EntityKind;
  title: string;
  mediaType: MediaType | null;
  releaseYear: number | null;
}

const toSummary = (s: SummaryRow): Summary => ({
  id: s.id,
  kind: s.kind,
  title: s.title,
  ...(s.mediaType ? { mediaType: s.mediaType } : {}),
  ...(s.releaseYear !== null ? { releaseYear: s.releaseYear } : {}),
});

export function createCatalogService(db: Db) {
  const repo = catalogRepository(db);

  return {
    /** Current state of a live entity; a merged id answers `{ redirectTo }` with its winner. A reserved id whose create isn't live yet is unknown: 404. */
    async getEntity(id: string): Promise<EntityView | { redirectTo: string }> {
      const winnerId = await resolveWinner(db, id);
      if (winnerId !== id) return { redirectTo: winnerId };
      const entity = await repo.findEntity(id);
      // A retracted entity is unknown. Removed ones get their own answer in a later task; until then not found either.
      if (!entity || entity.removedAt || entity.retractedByChange) throw notFound();
      const row = await repo.kindRow(entity.kind, id);
      if (!row) throw new Error(`entity ${id} has no ${entity.kind} row`);
      const fields = Object.fromEntries(Object.entries(row).filter(([k]) => !DERIVED.has(k)));

      const active = await repo.activeRelations(id);
      const others = active.flatMap((r) => [r.fromId, r.toId]).filter((x): x is string => !!x && x !== id);
      const summaries = new Map(
        (await repo.summaries([...new Set(others)])).map((s): [string, Summary] => [s.id, toSummary(s)]),
      );
      // Only relations to listed entities are shown; `summaries` holds exactly those.
      const isShown = (x: string | null) => x === null || x === id || summaries.has(x);
      const rels = active.filter((r) => isShown(r.fromId) && isShown(r.toId));
      const summary = (otherId: string | null) => {
        const s = otherId ? summaries.get(otherId) : undefined;
        if (!s) throw new Error(`relation endpoint ${otherId} has no summary`);
        return s;
      };
      const position = (p: number | null) => (p === null ? {} : { position: p });
      const outgoing = (type: string) => rels.filter((r) => r.type === type && r.fromId === id);
      const incoming = (type: string) => rels.filter((r) => r.type === type && r.toId === id);

      const relations: EntityView['relations'] = {};
      switch (entity.kind) {
        case 'work':
          relations.creators = byPosition(
            // relations_type_columns guarantees a work_creator has a role; flatMap only narrows the type.
            outgoing('work_creator').flatMap((r) =>
              r.role === null
                ? []
                : [{ relationId: r.id, creator: summary(r.toId), role: r.role, ...position(r.position) }],
            ),
          );
          relations.series = incoming('series_work').flatMap((r) =>
            r.position === null ? [] : [{ relationId: r.id, series: summary(r.fromId), position: r.position }],
          );
          relations.properties = incoming('property_work').map((r) => ({
            relationId: r.id,
            property: summary(r.fromId),
          }));
          relations.links = rels
            .filter((r) => r.type === 'work_link')
            .flatMap((r) => {
              const out = r.fromId === id;
              return r.linkType === null
                ? []
                : [
                    {
                      relationId: r.id,
                      type: r.linkType,
                      direction: out ? ('outgoing' as const) : ('incoming' as const),
                      work: summary(out ? r.toId : r.fromId),
                    },
                  ];
            });
          relations.tags = outgoing('work_tag').map((r) => ({ relationId: r.id, tag: summary(r.toId) }));
          relations.externalIds = outgoing('external_id').flatMap((r) =>
            r.scheme && r.value ? [{ relationId: r.id, scheme: r.scheme, value: r.value }] : [],
          );
          break;
        case 'creator':
          relations.works = incoming('work_creator').map((r) => ({
            relationId: r.id,
            work: summary(r.fromId),
            ...(r.role === null ? {} : { role: r.role }),
            ...position(r.position),
          }));
          break;
        case 'series':
          relations.works = byPosition(
            outgoing('series_work').map((r) => ({
              relationId: r.id,
              work: summary(r.toId),
              ...position(r.position),
            })),
          );
          break;
        case 'property':
          relations.works = outgoing('property_work').map((r) => ({ relationId: r.id, work: summary(r.toId) }));
          break;
        case 'tag':
          relations.works = incoming('work_tag').map((r) => ({ relationId: r.id, work: summary(r.fromId) }));
          break;
      }
      return { id, kind: entity.kind, fields, fieldSources: entity.fieldSources, relations };
    },

    /** Listed entities matching the query, alphabetical by title. Excludes removed, retracted and merged ones. */
    async search(query: SearchQuery) {
      const rows = await repo.search(
        normalizeTitle(query.q),
        { kind: query.kind, mediaType: query.mediaType },
        decodeKeyCursor(query.cursor, SearchCursor),
        query.limit,
      );
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: items.map(toSummary),
        nextCursor: rows.length > query.limit && last ? encodeKeyCursor({ title: last.title, id: last.id }) : null,
      };
    },

    /**
     * What a contributor should look at before creating `title`: the entities that already match,
     * and pending creates that match, showing only kind, title, media type and year (spec §5.3).
     */
    async duplicates(query: { kind: EntityKind; title: string; mediaType?: MediaType }) {
      const norm = normalizeTitle(query.title);
      const existing = await repo.existingMatching(norm, query, DUPLICATE_LIMIT);
      const pending = (await repo.pendingMatching(norm, query, DUPLICATE_LIMIT)).map(({ payload }) => {
        const mediaType = MediaType.safeParse(payload?.mediaType);
        const year = payload?.releaseYear;
        return {
          kind: query.kind,
          // Matched on the stored normalized title, so the payload has one of these.
          title: String(payload?.title ?? payload?.name),
          mediaType: mediaType.success ? mediaType.data : null,
          releaseYear: typeof year === 'number' ? year : null,
        };
      });
      return { existing: existing.map(toSummary), pending };
    },
  };
}
export type CatalogService = ReturnType<typeof createCatalogService>;
