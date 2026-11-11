import { MediaType, normalizeTitle, type EntityKind } from '@amdb/shared';
import type { Db } from '../../platform/db/types';
import { resolveWinner } from '../../platform/db/merge';
import { gone, notFound } from '../../platform/http/errors';
import { decodeKeyCursor, encodeKeyCursor } from '../../platform/http/pagination';
import { catalogRepository } from './repository';
import {
  type BrowseQuery,
  type EntityView,
  RELATED_LIMIT,
  SearchCursor,
  type SearchQuery,
  type Summary,
} from './schemas';

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

/** One page of summaries from `limit` + 1 rows, with a cursor when another page exists. */
function pageOf(rows: SummaryRow[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(toSummary),
    nextCursor: rows.length > limit && last ? encodeKeyCursor({ title: last.title, id: last.id }) : null,
  };
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

  /** A work's other works through each shared creator, series and property: one query per kind of hub, then one for every summary. */
  async function related(workId: string, creators: Summary[], series: Summary[], properties: Summary[]) {
    const pairsOf = (type: Parameters<typeof repo.worksOfHubs>[0], hubs: Summary[]) =>
      repo.worksOfHubs(
        type,
        hubs.map((h) => h.id),
        workId,
        RELATED_LIMIT,
      );
    const [creatorPairs, seriesPairs, propertyPairs] = await Promise.all([
      pairsOf('work_creator', creators),
      pairsOf('series_work', series),
      pairsOf('property_work', properties),
    ]);
    const workIds = [...creatorPairs, ...seriesPairs, ...propertyPairs].map((p) => p.workId);
    const summaries = new Map(
      (await repo.summaries([...new Set(workIds)])).map((s): [string, Summary] => [s.id, toSummary(s)]),
    );
    const groups = (hubs: Summary[], pairs: typeof creatorPairs) =>
      hubs.flatMap((hub) => {
        const works = pairs.filter((p) => p.hubId === hub.id).flatMap((p) => summaries.get(p.workId) ?? []);
        return works.length ? [{ hub, works }] : [];
      });
    return {
      byCreator: groups(creators, creatorPairs).map(({ hub, works }) => ({ creator: hub, works })),
      bySeries: groups(series, seriesPairs).map(({ hub, works }) => ({ series: hub, works })),
      byProperty: groups(properties, propertyPairs).map(({ hub, works }) => ({ property: hub, works })),
    };
  }

  return {
    /** Current state of a live entity (410 `removed` once taken down); a merged id answers `{ redirectTo }` with its winner. A reserved id whose create isn't live yet is unknown: 404. */
    async getEntity(id: string): Promise<EntityView | { redirectTo: string }> {
      const entity = await repo.findEntity(id);
      // A removed entity (legal or abuse removal) says so, even if it was merged away first.
      if (entity?.removedAt) throw gone('removed', 'This entity was removed');
      const winnerId = await resolveWinner(db, id);
      if (winnerId !== id) return { redirectTo: winnerId };
      // A retracted entity is unknown.
      if (!entity || entity.retractedByChange) throw notFound();
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

      const externalIds = () =>
        outgoing('external_id').flatMap((r) =>
          r.scheme && r.value ? [{ relationId: r.id, scheme: r.scheme, value: r.value }] : [],
        );

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
          relations.externalIds = externalIds();
          relations.related = await related(
            id,
            relations.creators.map((c) => c.creator),
            relations.series.map((x) => x.series),
            relations.properties.map((p) => p.property),
          );
          break;
        case 'creator':
          relations.works = incoming('work_creator').map((r) => ({
            relationId: r.id,
            work: summary(r.fromId),
            ...(r.role === null ? {} : { role: r.role }),
            ...position(r.position),
          }));
          relations.externalIds = externalIds();
          break;
        case 'series':
          relations.works = byPosition(
            outgoing('series_work').map((r) => ({
              relationId: r.id,
              work: summary(r.toId),
              ...position(r.position),
            })),
          );
          relations.externalIds = externalIds();
          break;
        case 'property':
          relations.works = outgoing('property_work').map((r) => ({ relationId: r.id, work: summary(r.toId) }));
          relations.externalIds = externalIds();
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
      return pageOf(rows, query.limit);
    },

    /** Listed entities of a kind (and media type), alphabetical by title, paged like search. */
    async browse(query: BrowseQuery) {
      const rows = await repo.browse(
        query.kind,
        query.mediaType,
        decodeKeyCursor(query.cursor, SearchCursor),
        query.limit,
      );
      return pageOf(rows, query.limit);
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
