import {
  CreatorRole,
  MediaType,
  normalizeTitle,
  PART_SUBTYPES,
  ZERO_LAST_SUBTYPES,
  type EntityKind,
} from '@amdb/shared';
import type { Db } from '../../platform/db/types';
import { resolveWinner } from '../../platform/db/merge';
import { gone, notFound } from '../../platform/http/errors';
import { decodeKeyCursor, encodeKeyCursor } from '../../platform/http/pagination';
import { catalogRepository } from './repository';
import {
  type Ancestor,
  type BrowseQuery,
  CreditsCursor,
  type DuplicatesQuery,
  type EntityView,
  PartsCursor,
  RELATED_LIMIT,
  SearchCursor,
  type SearchQuery,
  type Summary,
} from './schemas';

/** Columns derived from others, not shown as fields. */
const DERIVED = new Set([
  'entityId',
  'titleNorm',
  'nameNorm',
  'search',
  'alternateTitlesNorm',
  'alternateNamesNorm',
  'altSearch',
]);

const position = (p: number | null) => (p === null ? {} : { position: p });

const byPosition = <T extends { position?: number }>(items: T[]) =>
  items.toSorted((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));

/** The deepest ancestor walk; a guard against corrupt data, far above any real tree. */
const MAX_DEPTH = 8;

/** Every known role, in the order a credit lists them. */
const ROLE_ORDER: readonly string[] = [...CreatorRole.film_tv.options, ...CreatorRole.book.options];

/** `roles` once each, known roles in `ROLE_ORDER`, then any other alphabetically. */
function byRoleOrder(roles: string[]): string[] {
  const rank = (r: string) => (ROLE_ORDER.includes(r) ? ROLE_ORDER.indexOf(r) : ROLE_ORDER.length);
  return [...new Set(roles)].toSorted((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** A work's live link to its parent. */
interface ParentLink {
  relationId: string;
  parentId: string;
  position: number | null;
}

type SubtreeRow = Awaited<ReturnType<ReturnType<typeof catalogRepository>['subtree']>>[number];

/**
 * Orders sibling parts: seasons first, then as `repository.parts` does (numbered by number, then
 * unnumbered, then a zero-last subtype numbered 0; ties by release date, title and id).
 */
function bySiblingOrder(a: SubtreeRow, b: SubtreeRow): number {
  const key = (w: SubtreeRow) => [
    w.subtype === 'season' ? 0 : 1,
    w.position === null ? 1 : w.position === 0 && w.subtype && ZERO_LAST_SUBTYPES.includes(w.subtype) ? 2 : 0,
    w.position ?? 0,
    w.releaseYear ?? 10000,
    w.releaseMonth ?? 13,
    w.releaseDay ?? 32,
  ];
  const [ka, kb] = [key(a), key(b)];
  const i = ka.findIndex((x, n) => x !== kb[n]);
  if (i >= 0) return (ka[i] ?? 0) - (kb[i] ?? 0);
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return cmp(a.title, b.title) || cmp(a.id, b.id);
}

/** The most existing matches, and the most pending ones, a duplicate check lists. */
const DUPLICATE_LIMIT = 20;

interface SummaryRow {
  id: string;
  kind: EntityKind;
  title: string;
  mediaType: MediaType | null;
  releaseYear: number | null;
  /** Search only: 1 for a match through alternate names alone. Browse rows have none. */
  rank?: number;
}

/** One page of summaries from `limit` + 1 rows, with a cursor when another page exists. */
function pageOf(rows: SummaryRow[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(toSummary),
    nextCursor:
      rows.length > limit && last ? encodeKeyCursor({ rank: last.rank ?? 0, title: last.title, id: last.id }) : null,
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

  /** The live entity `id`, or `{ redirectTo }` its winner if merged; 410 `removed` once taken down, 404 if unknown or retracted. */
  async function resolveLive(
    id: string,
  ): Promise<{ entity: NonNullable<Awaited<ReturnType<typeof repo.findEntity>>> } | { redirectTo: string }> {
    const entity = await repo.findEntity(id);
    // A removed entity (legal or abuse removal) says so, even if it was merged away first.
    if (entity?.removedAt) throw gone('removed', 'This entity was removed');
    const winnerId = await resolveWinner(db, id);
    if (winnerId !== id) return { redirectTo: winnerId };
    // A retracted entity is unknown.
    if (!entity || entity.retractedByChange) throw notFound();
    return { entity };
  }

  /**
   * For each of `workIds`, its own parent link and its ancestors, root first and parent last.
   * Walks up a level at a time, one `parentLinks` and one `workRows` query per level for the whole
   * batch, at most `MAX_DEPTH` levels. Removed ancestors are kept and marked.
   */
  async function ancestry(workIds: string[]) {
    const linkOf = new Map<string, ParentLink>();
    const rowOf = new Map<string, Awaited<ReturnType<typeof repo.workRows>>[number]>();
    const asked = new Set<string>();
    let frontier = [...new Set(workIds)];
    for (let level = 0; level < MAX_DEPTH && frontier.length; level++) {
      for (const x of frontier) asked.add(x);
      const links = await repo.parentLinks(frontier);
      for (const l of links)
        linkOf.set(l.childId, { relationId: l.relationId, parentId: l.parentId, position: l.position });
      const parentIds = [...new Set(links.map((l) => l.parentId))];
      for (const r of await repo.workRows(parentIds.filter((x) => !rowOf.has(x)))) rowOf.set(r.id, r);
      frontier = parentIds.filter((x) => !asked.has(x));
    }
    return new Map(
      workIds.map((id) => {
        const ancestors: Ancestor[] = [];
        const seen = new Set([id]);
        for (let up = linkOf.get(id); up && !seen.has(up.parentId); up = linkOf.get(up.parentId)) {
          seen.add(up.parentId);
          const row = rowOf.get(up.parentId);
          if (!row) break;
          const own = linkOf.get(row.id);
          ancestors.push({
            id: row.id,
            title: row.title,
            subtype: row.subtype,
            ...(own && own.position !== null ? { position: own.position } : {}),
            removed: row.removed,
          });
        }
        return [id, { link: linkOf.get(id) ?? null, ancestors: ancestors.reverse() }];
      }),
    );
  }

  /** A creator's credits, one row per root work, each root's summary from its stored row. */
  async function credits(creatorId: string): Promise<NonNullable<EntityView['relations']['credits']>> {
    const roots = await repo.creditRoots(creatorId, MAX_DEPTH);
    const rowOf = new Map((await repo.workRows(roots.map((r) => r.rootId))).map((w) => [w.id, w]));
    return roots.map((r) => {
      const row = rowOf.get(r.rootId);
      if (!row) throw new Error(`credit root ${r.rootId} has no work row`);
      return {
        work: toSummary({ ...row, kind: 'work' }),
        removed: !r.rootListed,
        roles: byRoleOrder(r.roles),
        parts: Object.fromEntries(
          PART_SUBTYPES.flatMap((s) => r.parts.filter((p) => p.subtype === s).map((p) => [s, p.n])),
        ),
      };
    });
  }

  return {
    /** Current state of a live entity (410 `removed` once taken down); a merged id answers `{ redirectTo }` with its winner. A reserved id whose create isn't live yet is unknown: 404. */
    async getEntity(id: string): Promise<EntityView | { redirectTo: string }> {
      const live = await resolveLive(id);
      if ('redirectTo' in live) return live;
      const { entity } = live;
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
          {
            const { link, ancestors } = (await ancestry([id])).get(id) ?? { link: null, ancestors: [] };
            const [parent] = link ? await repo.workRows([link.parentId]) : [];
            if (link && !parent) throw new Error(`parent ${link.parentId} of ${id} has no work row`);
            relations.parent =
              link && parent
                ? {
                    relationId: link.relationId,
                    work: toSummary({ ...parent, kind: 'work' }),
                    ...position(link.position),
                    removed: parent.removed,
                  }
                : null;
            relations.ancestors = ancestors;
          }
          relations.partCount = await repo.partCount(id);
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
          relations.credits = await credits(id);
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

    /**
     * One page of a work's listed parts, in parts order; `{ redirectTo }` for a merged id, and the
     * same 404 and 410 as `getEntity`. Anything but a work has none.
     */
    async parts(id: string, query: { cursor?: string; limit: number }) {
      const live = await resolveLive(id);
      if ('redirectTo' in live) return live;
      if (live.entity.kind !== 'work') return { items: [], nextCursor: null };
      const rows = await repo.parts(id, decodeKeyCursor(query.cursor, PartsCursor), query.limit);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          relationId: r.relationId,
          work: toSummary({ ...r, kind: 'work' }),
          subtype: r.subtype,
          ...position(r.position),
        })),
        nextCursor:
          rows.length > query.limit && last
            ? encodeKeyCursor({ b: last.b, p: last.p, y: last.y, m: last.m, d: last.d, t: last.title, id: last.id })
            : null,
      };
    },

    /**
     * One page of creator `id`'s credits at or under work `workId`: `workId`'s own credit first,
     * then its credited parts depth-first, each parent directly before its descendants and
     * siblings by `bySiblingOrder`. An uncredited part has no item, but its credited parts keep
     * their place. `id` answers like `parts` (404, 410, `{ redirectTo }`); `workId` is 404 unless
     * a work, follows merges, and may be removed. Anything but a creator has no credits.
     */
    async creditsUnder(id: string, workId: string, query: { cursor?: string; limit: number }) {
      const live = await resolveLive(id);
      if ('redirectTo' in live) return live;
      const offset = decodeKeyCursor(query.cursor, CreditsCursor)?.o ?? 0;
      const rootId = await resolveWinner(db, workId);
      const root = await repo.findEntity(rootId);
      // A retracted work is unknown, as in `resolveLive`.
      if (!root || root.kind !== 'work' || root.retractedByChange) throw notFound();
      const [rootRow] = await repo.workRows([rootId]);
      if (!rootRow) throw new Error(`work ${rootId} has no work row`);
      const under = { work: toSummary({ ...rootRow, kind: 'work' }), removed: rootRow.removed };
      if (live.entity.kind !== 'creator') return { under, items: [], nextCursor: null };

      // The whole subtree is read and ordered here; one show bounds it (spec, Production Annotations).
      const tree = await repo.subtree(rootId, MAX_DEPTH);
      const rolesOf = new Map<string, string[]>();
      for (const c of await repo.creditsAmong(id, [rootId, ...tree.map((w) => w.id)]))
        rolesOf.set(c.workId, [...(rolesOf.get(c.workId) ?? []), c.role]);
      const childrenOf = new Map<string, SubtreeRow[]>();
      for (const w of tree) childrenOf.set(w.parentId, [...(childrenOf.get(w.parentId) ?? []), w]);
      // `subtree` puts each work under its nearest link, so this walk is a tree and visits each once.
      const walk = (parentId: string): string[] =>
        (childrenOf.get(parentId) ?? []).toSorted(bySiblingOrder).flatMap((w) => [w.id, ...walk(w.id)]);
      const ordered = [rootId, ...walk(rootId)].filter((x) => rolesOf.has(x));

      const pageIds = ordered.slice(offset, offset + query.limit);
      const rowOf = new Map((await repo.workRows(pageIds)).map((w) => [w.id, w]));
      const trees = await ancestry(pageIds.filter((x) => x !== rootId));
      return {
        under,
        items: pageIds.map((itemId) => {
          const row = rowOf.get(itemId);
          if (!row) throw new Error(`credited work ${itemId} has no work row`);
          const work = toSummary({ ...row, kind: 'work' });
          const t = trees.get(itemId);
          return {
            // Every work below the root has a live link; one with no subtype has no part data, as in search.
            work:
              t?.link && row.subtype
                ? { ...work, part: { subtype: row.subtype, ...position(t.link.position), ancestors: t.ancestors } }
                : work,
            roles: byRoleOrder(rolesOf.get(itemId) ?? []),
          };
        }),
        nextCursor: offset + query.limit < ordered.length ? encodeKeyCursor({ o: offset + query.limit }) : null,
      };
    },

    /**
     * Listed entities matching the query, alphabetical by title. Excludes removed, retracted and
     * merged ones, and parts unless `includeParts=true`; then a part with a live parent carries its
     * context, from one `ancestry` walk for the whole page.
     */
    async search(query: SearchQuery) {
      const includeParts = query.includeParts === 'true';
      const rows = await repo.search(
        normalizeTitle(query.q),
        { kind: query.kind, mediaType: query.mediaType, includeParts },
        decodeKeyCursor(query.cursor, SearchCursor),
        query.limit,
      );
      const page = pageOf(rows, query.limit);
      if (!includeParts) return page;
      const subtypeOf = new Map(rows.map((r) => [r.id, r.subtype]));
      const trees = await ancestry(page.items.filter((i) => i.kind === 'work').map((i) => i.id));
      return {
        ...page,
        items: page.items.map((item): Summary => {
          const tree = trees.get(item.id);
          const subtype = subtypeOf.get(item.id);
          // The tree list gives a parent only to a part, so a linked work has a subtype; the check only narrows it.
          if (!tree?.link || !subtype) return item;
          return { ...item, part: { subtype, ...position(tree.link.position), ancestors: tree.ancestors } };
        }),
      };
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
     * Existing matches leave parts out, or with `parentId` are only that work's parts.
     */
    async duplicates(query: DuplicatesQuery) {
      const norm = normalizeTitle(query.title);
      const parentId = query.parentId ? await resolveWinner(db, query.parentId) : undefined;
      const existing = await repo.existingMatching(
        norm,
        { kind: query.kind, mediaType: query.mediaType, parentId },
        DUPLICATE_LIMIT,
      );
      // Never filtered by parent: that would reveal which parent a pending part sits under (constitution I).
      const pending = (
        await repo.pendingMatching(norm, { kind: query.kind, mediaType: query.mediaType }, DUPLICATE_LIMIT)
      ).map(({ payload }) => {
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
