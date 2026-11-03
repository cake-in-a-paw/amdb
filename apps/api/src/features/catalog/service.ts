import type { Db } from '../../platform/db/types';
import { notFound } from '../../platform/http/errors';
import { catalogRepository } from './repository';
import type { EntityView, Summary } from './schemas';

/** Columns derived from others, not shown as fields. */
const DERIVED = new Set(['entityId', 'titleNorm', 'nameNorm', 'search']);

const byPosition = <T extends { position?: number }>(items: T[]) =>
  items.toSorted((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));

export function createCatalogService(db: Db) {
  const repo = catalogRepository(db);

  return {
    /** Current state of a live entity. A reserved id whose create isn't live yet is unknown: 404. */
    async getEntity(id: string): Promise<EntityView> {
      const entity = await repo.findEntity(id);
      // Merged and removed entities get their own answers in later tasks; until then they are not found.
      if (!entity || entity.removedAt || entity.mergedIntoId) throw notFound();
      const row = await repo.kindRow(entity.kind, id);
      if (!row) throw new Error(`entity ${id} has no ${entity.kind} row`);
      const fields = Object.fromEntries(Object.entries(row).filter(([k]) => !DERIVED.has(k)));

      const rels = await repo.activeRelations(id);
      const others = rels.flatMap((r) => [r.fromId, r.toId]).filter((x): x is string => !!x && x !== id);
      const summaries = new Map(
        (await repo.summaries([...new Set(others)])).map((s): [string, Summary] => [
          s.id,
          {
            id: s.id,
            kind: s.kind,
            title: s.title,
            ...(s.mediaType ? { mediaType: s.mediaType } : {}),
            ...(s.releaseYear !== null ? { releaseYear: s.releaseYear } : {}),
          },
        ]),
      );
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
      return { id, kind: entity.kind, fields, relations };
    },
  };
}
export type CatalogService = ReturnType<typeof createCatalogService>;
