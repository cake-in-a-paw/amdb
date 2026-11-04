import type { EntityView } from '@/lib/entity';
import { emptyForm, toInputs, type EntryForm } from '@/lib/submission';

/**
 * An existing entry as the entry form: its fields as typed-in inputs and, for a work, one row per
 * relation it holds, each keeping its `relationId` so a removal can be sent as an `unrelate`. Only
 * the relations this work is the subject of: a link another work points at is that work's to edit.
 */
export function formFromEntity(entity: EntityView): EntryForm {
  const form: EntryForm = { ...emptyForm(), kind: entity.kind, fields: toInputs(entity.kind, entity.fields) };
  if (entity.kind !== 'work') return form;
  const { creators, series, properties, tags, links, externalIds } = entity.relations;
  return {
    ...form,
    credits: (creators ?? []).map((c) => ({ entity: c.creator, role: c.role, relationId: c.relationId })),
    series: (series ?? []).map((s) => ({ entity: s.series, position: String(s.position), relationId: s.relationId })),
    properties: (properties ?? []).map((p) => ({ entity: p.property, relationId: p.relationId })),
    tags: (tags ?? []).map((t) => ({ entity: t.tag, relationId: t.relationId })),
    links: (links ?? [])
      .filter((l) => l.direction === 'outgoing')
      .map((l) => ({ entity: l.work, linkType: l.type, relationId: l.relationId })),
    externalIds: (externalIds ?? []).map((x) => ({ scheme: x.scheme, value: x.value, relationId: x.relationId })),
  };
}
