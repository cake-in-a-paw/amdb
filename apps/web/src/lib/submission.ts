import { CreatorRole, EntityKind, FieldsFor, IdScheme, WorkLinkType, type MediaType } from '@amdb/shared';
import type { paths } from '@amdb/shared/api';

export type SubmissionInput = paths['/api/submissions']['post']['requestBody']['content']['application/json'];
export type SubmissionCreated = paths['/api/submissions']['post']['responses'][201]['content']['application/json'];
export type ChangeInput = SubmissionInput['changes'][number];

/**
 * An entry a relation points at: one already in the catalog (by id), or one made inline with
 * "Add new…", which is created in the same submission under its `ref`.
 */
export type Picked =
  { id: string; title: string } | { ref: string; title: string; kind: EntityKind; fields: Record<string, unknown> };

/** A relation row's `relationId` is set on a row loaded from an existing entry, and only then. */
interface Row {
  relationId?: string | undefined;
}

/**
 * Everything the entry form holds, as plain JSON so it can be saved as a draft. Field inputs are
 * kept as typed (strings, keyed by the API's field names, a work's attributes flattened in) and
 * only become API values in `buildSubmission`. Relation rows are a work's; other kinds have none.
 */
export interface EntryForm {
  kind: EntityKind;
  fields: Record<string, string>;
  credits: (Row & { entity: Picked; role: string })[];
  series: (Row & { entity: Picked; position: string })[];
  properties: (Row & { entity: Picked })[];
  tags: (Row & { entity: Picked })[];
  links: (Row & { entity: Picked; linkType: WorkLinkType })[];
  externalIds: (Row & { scheme: IdScheme | ''; value: string })[];
  note: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string';
const rowsOf = (v: unknown, ok: (row: Record<string, unknown>) => boolean) =>
  Array.isArray(v) &&
  v.every((row) => isRecord(row) && (row.relationId === undefined || isText(row.relationId)) && ok(row));

function isPicked(v: unknown): v is Picked {
  if (!isRecord(v) || !isText(v.title)) return false;
  if (isText(v.id)) return true;
  return isText(v.ref) && EntityKind.safeParse(v.kind).success && isRecord(v.fields);
}

/**
 * Whether `v` is a form this version can show. A draft is JSON a person's browser kept, possibly
 * from an older version or damaged (`null`, a changed nested shape); one that fails this is dropped
 * for a fresh form instead of crashing the page.
 */
export function isEntryForm(v: unknown): v is EntryForm {
  return (
    isRecord(v) &&
    EntityKind.safeParse(v.kind).success &&
    isRecord(v.fields) &&
    Object.values(v.fields).every(isText) &&
    isText(v.note) &&
    rowsOf(v.credits, (r) => isPicked(r.entity) && isText(r.role)) &&
    rowsOf(v.series, (r) => isPicked(r.entity) && isText(r.position)) &&
    rowsOf(v.properties, (r) => isPicked(r.entity)) &&
    rowsOf(v.tags, (r) => isPicked(r.entity)) &&
    rowsOf(v.links, (r) => isPicked(r.entity) && WorkLinkType.safeParse(r.linkType).success) &&
    rowsOf(v.externalIds, (r) => (r.scheme === '' || IdScheme.safeParse(r.scheme).success) && isText(r.value))
  );
}

export const emptyForm = (): EntryForm => ({
  kind: 'work',
  fields: {},
  credits: [],
  series: [],
  properties: [],
  tags: [],
  links: [],
  externalIds: [],
  note: '',
});

/** The ref of the entry being added; inline "Add new…" entries get their own. */
export const ENTRY_REF = 'entry';

const stringKeys: Record<EntityKind, string[]> = {
  work: ['mediaType', 'subtype', 'title', 'originalTitle', 'description', 'lifecycle'],
  creator: ['name', 'kind', 'description'],
  series: ['title', 'description'],
  property: ['title', 'description'],
  tag: ['kind', 'name', 'slug'],
};
const workNumberKeys = ['releaseYear', 'releaseMonth', 'releaseDay'];

/** A work's attributes by media type: which inputs belong in `attributes`, and which are numbers. */
export const attributeKeys: Record<MediaType, { key: string; number: boolean }[]> = {
  film_tv: [
    { key: 'runtimeMin', number: true },
    { key: 'episodes', number: true },
    { key: 'originalLanguage', number: false },
  ],
  book: [
    { key: 'pageCount', number: true },
    { key: 'originalLanguage', number: false },
  ],
};

/** An input as an API value: trimmed text, a number, or left out when empty. */
function value(raw: string | undefined, number: boolean): string | number | undefined {
  const text = raw?.trim() ?? '';
  if (text === '') return undefined;
  return number ? Number(text) : text;
}

/** The form's inputs for `kind` as the API's `create` fields. Empty inputs are left out. */
export function toFields(kind: EntityKind, inputs: Record<string, string>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const put = (key: string, v: unknown) => {
    if (v !== undefined) fields[key] = v;
  };
  for (const key of stringKeys[kind]) put(key, value(inputs[key], false));
  if (kind !== 'work') return fields;

  for (const key of workNumberKeys) put(key, value(inputs[key], true));
  // A book has no subtype: the API wants an explicit null, not a missing key.
  if (fields.mediaType === 'book') fields.subtype = null;
  const media = fields.mediaType === 'book' || fields.mediaType === 'film_tv' ? fields.mediaType : null;
  if (media) {
    const attributes: Record<string, unknown> = {};
    for (const { key, number } of attributeKeys[media]) {
      const v = value(inputs[key], number);
      if (v !== undefined) attributes[key] = v;
    }
    if (Object.keys(attributes).length > 0) fields.attributes = attributes;
  }
  return fields;
}

/** The inverse of `toFields`: an entry's API fields as the form's typed-in inputs. */
export function toInputs(kind: EntityKind, fields: Record<string, unknown>): Record<string, string> {
  const inputs: Record<string, string> = {};
  const take = (source: Record<string, unknown>, key: string) => {
    const v = source[key];
    if (typeof v === 'string' || typeof v === 'number') inputs[key] = String(v);
  };
  for (const key of stringKeys[kind]) take(fields, key);
  if (kind !== 'work') return inputs;
  for (const key of workNumberKeys) take(fields, key);
  const attributes = fields.attributes;
  if (typeof attributes === 'object' && attributes !== null) {
    for (const { key } of [...attributeKeys.film_tv, ...attributeKeys.book])
      take(attributes as Record<string, unknown>, key); // narrowed to an object just above
  }
  return inputs;
}

const endpoint = (picked: Picked) => ('id' in picked ? { id: picked.id } : { ref: picked.ref });

/** Every entry the form names, in order: what each relation points at. */
function pickedEntries(form: EntryForm): Picked[] {
  return [form.credits, form.series, form.properties, form.tags, form.links].flatMap((rows) =>
    rows.map((row) => row.entity),
  );
}

/**
 * The changes for the relations the form holds, for the entry named `entry`: a `create` for each
 * entry made inline (once, however many rows name it), then the `relate`s, so every ref names an
 * earlier create. A work's only; other kinds have no relation rows.
 */
export function relationChanges(form: EntryForm, entry: { id: string } | { ref: string }): ChangeInput[] {
  const changes: ChangeInput[] = [];
  const made = new Set<string>();
  for (const picked of pickedEntries(form)) {
    if ('id' in picked || made.has(picked.ref)) continue;
    made.add(picked.ref);
    changes.push({ op: 'create', kind: picked.kind, ref: picked.ref, fields: picked.fields });
  }
  const relate = (
    type: Extract<ChangeInput, { op: 'relate' }>['type'],
    from: { id: string } | { ref: string },
    to: { id: string } | { ref: string } | undefined,
    data: Extract<ChangeInput, { op: 'relate' }>['data'] = {},
  ) => changes.push({ op: 'relate', type, from, ...(to ? { to } : {}), data });

  for (const c of form.credits) relate('work_creator', entry, endpoint(c.entity), { role: c.role });
  for (const s of form.series) {
    relate('series_work', endpoint(s.entity), entry, { position: Number(s.position.trim()) });
  }
  for (const p of form.properties) relate('property_work', endpoint(p.entity), entry);
  for (const tag of form.tags) relate('work_tag', entry, endpoint(tag.entity));
  for (const l of form.links) relate('work_link', entry, endpoint(l.entity), { linkType: l.linkType });
  for (const x of form.externalIds) {
    // An unchosen scheme never gets here: `validateForm` stops the submission first.
    if (x.scheme) relate('external_id', entry, undefined, { scheme: x.scheme, value: x.value.trim() });
  }
  return changes;
}

/** The form as one submission: the entry's `create`, then `relationChanges` for a work. */
export function buildSubmission(form: EntryForm): SubmissionInput {
  const entry = { ref: ENTRY_REF };
  const note = form.note.trim();
  const changes: ChangeInput[] = [
    { op: 'create', kind: form.kind, ref: ENTRY_REF, fields: toFields(form.kind, form.fields) },
    ...(form.kind === 'work' ? relationChanges(form, entry) : []),
  ];
  return { cc0: true, ...(note ? { note } : {}), changes };
}

/** Field errors in plain words, keyed by the input they belong to ("title", "series.0.position"). */
export type FormErrors = Record<string, string>;

/** A schema issue as words a person can act on, next to the field it names. */
function plainWords(field: string, message: string): string {
  switch (field) {
    case 'mediaType':
      return 'Choose a media type.';
    case 'subtype':
      return 'Choose a type.';
    case 'kind':
      return 'Choose a kind.';
    case 'title':
    case 'name':
    case 'originalTitle':
      return 'Enter 1 to 500 characters.';
    case 'description':
      return 'Keep it under 5,000 characters.';
    case 'slug':
      return 'Use lowercase letters, digits and hyphens.';
    case 'releaseYear':
      return 'Use a year from 1 to 9999.';
    case 'releaseMonth':
      return message.includes('needs releaseYear') ? 'Add a year to go with the month.' : 'Choose a month.';
    case 'releaseDay':
      if (message.includes('needs releaseMonth')) return 'Add a month to go with the day.';
      if (message.includes('not valid for that month')) return "That day isn't in that month.";
      return 'Use a day from 1 to 31.';
    case 'originalLanguage':
      return 'Enter 1 to 35 characters.';
    default:
      return 'Use a whole number above 0.';
  }
}

/** The fields' schema issues, by input; a work's attributes are named by their own input. */
export function fieldErrors(kind: EntityKind, inputs: Record<string, string>): FormErrors {
  const parsed = FieldsFor[kind].safeParse(toFields(kind, inputs));
  const errors: FormErrors = {};
  if (parsed.success) return errors;
  for (const issue of parsed.error.issues) {
    const [first, second] = issue.path;
    const field = String(first === 'attributes' && second !== undefined ? second : first);
    errors[field] ??= plainWords(field, issue.message);
  }
  return errors;
}

const positiveInteger = (raw: string) => /^\d+$/.test(raw.trim()) && Number(raw.trim()) >= 1;

/**
 * Checks the form with the same field schemas the API uses (from `@amdb/shared`), plus the rules
 * the API applies to each relation, so the form and the API agree. Empty means it can be sent.
 */
export function validateForm(form: EntryForm): FormErrors {
  const errors = fieldErrors(form.kind, form.fields);
  if (form.kind !== 'work') return errors;
  const media = form.fields.mediaType;
  form.credits.forEach((c, i) => {
    const roles = media === 'book' || media === 'film_tv' ? CreatorRole[media] : null;
    if (!roles?.safeParse(c.role).success) errors[`credits.${i}.role`] = 'Choose a role.';
  });
  form.series.forEach((s, i) => {
    if (!positiveInteger(s.position)) errors[`series.${i}.position`] = 'Use a whole number from 1.';
  });
  form.externalIds.forEach((x, i) => {
    if (!x.scheme) errors[`externalIds.${i}.scheme`] = 'Choose the type of ID.';
    if (!x.value.trim()) errors[`externalIds.${i}.value`] = 'Enter the ID.';
  });
  return errors;
}
