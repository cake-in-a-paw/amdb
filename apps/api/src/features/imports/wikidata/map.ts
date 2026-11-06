// Pure mapping from a Wikidata entity to an AMDB work record. No I/O; the importer writes the result.
import type { CreatorRole, IdScheme, Lifecycle, MediaType, Subtype } from '@amdb/shared';
import type { Claim, Snak, WikidataEntity } from './client.js';
import type { Candidate } from './discover.js';

type FilmTvRole = (typeof CreatorRole.film_tv.options)[number];
type BookRole = (typeof CreatorRole.book.options)[number];

export interface WorkRecord {
  qid: string;
  fields: {
    mediaType: MediaType;
    subtype: Subtype | null;
    title: string;
    originalTitle?: string;
    description?: string;
    releaseYear?: number;
    releaseMonth?: number;
    releaseDay?: number;
    lifecycle: Lifecycle;
    attributes?: { runtimeMin?: number; episodes?: number; pageCount?: number };
  };
  creators: { qid: string; role: FilmTvRole | BookRole }[];
  series: { qid: string; position: number }[];
  franchises: string[];
  genres: string[];
  links: { qid: string; linkType: 'adapted_from' | 'sequel_of' }[];
  externalIds: { scheme: IdScheme; value: string }[];
}

const MAX_TITLE = 500;
const MAX_DESCRIPTION = 5000;

const FILM_TV_ROLES: Record<string, FilmTvRole> = {
  P57: 'director',
  P58: 'writer',
  P170: 'creator',
  P162: 'producer',
  P86: 'composer',
  P272: 'studio',
};
const BOOK_ROLES: Record<string, BookRole> = {
  P50: 'author',
  P110: 'illustrator',
  P655: 'translator',
  P98: 'editor',
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Claims worth reading: not deprecated, with a real value (not "unknown value" / "no value"). */
function valueSnaks(entity: WikidataEntity, property: string): { claim: Claim; snak: Snak }[] {
  return (entity.claims?.[property] ?? [])
    .filter((c) => c.rank !== 'deprecated' && c.mainsnak.snaktype === 'value' && c.mainsnak.datavalue !== undefined)
    .map((claim) => ({ claim, snak: claim.mainsnak }));
}

function stringValue(snak: Snak): string | null {
  const v = snak.datavalue?.value;
  return typeof v === 'string' ? v : null;
}

function entityId(snak: Snak): string | null {
  const v = snak.datavalue?.value;
  return isObject(v) && typeof v.id === 'string' && /^Q\d+$/.test(v.id) ? v.id : null;
}

function quantity(snak: Snak): { amount: number; unit: string | null } | null {
  const v = snak.datavalue?.value;
  if (!isObject(v) || typeof v.amount !== 'string') return null;
  const amount = Number(v.amount);
  if (!Number.isFinite(amount)) return null;
  const unit = typeof v.unit === 'string' ? (v.unit.split('/').pop() ?? null) : null;
  return { amount, unit };
}

const positiveInt = (n: number): number | null => (Number.isInteger(n) && n > 0 ? n : null);

function qids(entity: WikidataEntity, property: string): string[] {
  const out: string[] = [];
  for (const { snak } of valueSnaks(entity, property)) {
    const id = entityId(snak);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

interface ParsedDate {
  year: number;
  month?: number;
  day?: number;
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function parseTime(snak: Snak): ParsedDate | null {
  const v = snak.datavalue?.value;
  if (!isObject(v) || typeof v.time !== 'string' || typeof v.precision !== 'number') return null;
  if (v.precision < 9) return null;
  const m = /^\+(\d+)-(\d{2})-(\d{2})T/.exec(v.time); // a leading "-" (BCE) never matches
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 1 || year > 9999) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (v.precision === 9 || month < 1 || month > 12) return { year };
  if (v.precision === 10 || day < 1 || day > daysInMonth(year, month)) return { year, month };
  return { year, month, day };
}

const dateKey = (d: ParsedDate) => d.year * 10000 + (d.month ?? 0) * 100 + (d.day ?? 0);

function earliestDate(entity: WikidataEntity): ParsedDate | null {
  let best: ParsedDate | null = null;
  for (const { snak } of valueSnaks(entity, 'P577')) {
    const d = parseTime(snak);
    if (d && (!best || dateKey(d) < dateKey(best))) best = d;
  }
  return best;
}

/** Compares the date's whole precision period with today (UTC): wholly before → released, wholly after → upcoming. */
function lifecycleFor(date: ParsedDate | null, today: Date): Lifecycle {
  if (!date) return 'unknown';
  const start = Date.UTC(date.year, (date.month ?? 1) - 1, date.day ?? 1);
  const end = date.day
    ? Date.UTC(date.year, date.month! - 1, date.day + 1) // non-null: a day implies a month
    : Date.UTC(date.year + (date.month ? 0 : 1), date.month ?? 0, 1);
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (end <= t) return 'released';
  if (start > t) return 'upcoming';
  return 'unknown';
}

function runtimeMinutes(entity: WikidataEntity): number | null {
  const perUnit: Record<string, number> = { Q7727: 1, Q11574: 1 / 60, Q25235: 60 };
  for (const { snak } of valueSnaks(entity, 'P2047')) {
    const q = quantity(snak);
    const factor = q?.unit ? perUnit[q.unit] : undefined;
    if (!q || factor === undefined) continue;
    const minutes = positiveInt(Math.round(q.amount * factor));
    if (minutes) return minutes;
  }
  return null;
}

function firstPositiveInt(entity: WikidataEntity, property: string): number | null {
  for (const { snak } of valueSnaks(entity, property)) {
    const q = quantity(snak);
    const n = q ? positiveInt(q.amount) : null;
    if (n) return n;
  }
  return null;
}

function originalTitle(entity: WikidataEntity, title: string): string | null {
  for (const { snak } of valueSnaks(entity, 'P1476')) {
    const v = snak.datavalue?.value;
    if (!isObject(v) || typeof v.text !== 'string' || typeof v.language !== 'string') continue;
    const text = v.text.trim();
    if (v.language === 'en' || text === title || text.length < 1 || text.length > MAX_TITLE) continue;
    return text;
  }
  return null;
}

function externalIds(entity: WikidataEntity): { scheme: IdScheme; value: string }[] {
  const out: { scheme: IdScheme; value: string }[] = [{ scheme: 'wikidata', value: entity.id }];
  const add = (scheme: IdScheme, value: string) => {
    if (!out.some((e) => e.scheme === scheme && e.value === value)) out.push({ scheme, value });
  };
  for (const { snak } of valueSnaks(entity, 'P345')) {
    const v = stringValue(snak)?.trim();
    if (v && /^tt\d+$/.test(v)) add('imdb', v);
  }
  for (const { snak } of valueSnaks(entity, 'P648')) {
    const v = stringValue(snak)?.trim();
    if (v) add('openlibrary', v);
  }
  for (const { snak } of valueSnaks(entity, 'P212')) {
    const v = stringValue(snak)?.replace(/[-\s]/g, '');
    if (v && /^\d{13}$/.test(v)) add('isbn13', v);
  }
  return out;
}

function seriesLinks(entity: WikidataEntity): { qid: string; position: number }[] {
  const out: { qid: string; position: number }[] = [];
  for (const { claim, snak } of valueSnaks(entity, 'P179')) {
    const qid = entityId(snak);
    if (!qid || out.some((s) => s.qid === qid)) continue;
    const ordinal = (claim.qualifiers?.P1545 ?? [])
      .filter((q) => q.snaktype === 'value')
      .map(stringValue)
      .find((s): s is string => s !== null && /^\d+$/.test(s));
    const position = ordinal ? Number(ordinal) : 0;
    if (position > 0) out.push({ qid, position });
  }
  return out;
}

export function mapWork(entity: WikidataEntity, candidate: Candidate, today: Date): WorkRecord | { skip: 'no_title' } {
  const title = entity.labels?.en?.value.trim() ?? '';
  if (title.length < 1 || title.length > MAX_TITLE) return { skip: 'no_title' };

  const isFilm = candidate.mediaType === 'film_tv';
  const date = earliestDate(entity);
  const fields: WorkRecord['fields'] = {
    mediaType: candidate.mediaType,
    subtype: candidate.subtype,
    title,
    lifecycle: lifecycleFor(date, today),
  };
  const original = originalTitle(entity, title);
  if (original) fields.originalTitle = original;
  const description = entity.descriptions?.en?.value.trim();
  if (description && description.length <= MAX_DESCRIPTION) fields.description = description;
  if (date) {
    fields.releaseYear = date.year;
    if (date.month) fields.releaseMonth = date.month;
    if (date.day) fields.releaseDay = date.day;
  }

  const attributes: NonNullable<WorkRecord['fields']['attributes']> = {};
  if (isFilm) {
    const runtimeMin = runtimeMinutes(entity);
    if (runtimeMin) attributes.runtimeMin = runtimeMin;
    const episodes = firstPositiveInt(entity, 'P1113');
    if (episodes) attributes.episodes = episodes;
  } else {
    const pageCount = firstPositiveInt(entity, 'P1104');
    if (pageCount) attributes.pageCount = pageCount;
  }
  if (Object.keys(attributes).length > 0) fields.attributes = attributes;

  const creators: WorkRecord['creators'] = [];
  for (const [property, role] of Object.entries(isFilm ? FILM_TV_ROLES : BOOK_ROLES)) {
    for (const qid of qids(entity, property)) {
      if (!creators.some((c) => c.qid === qid && c.role === role)) creators.push({ qid, role });
    }
  }

  const links: WorkRecord['links'] = [
    ...qids(entity, 'P144').map((qid) => ({ qid, linkType: 'adapted_from' as const })),
    ...qids(entity, 'P155').map((qid) => ({ qid, linkType: 'sequel_of' as const })),
  ];

  return {
    qid: entity.id,
    fields,
    creators,
    series: seriesLinks(entity),
    franchises: qids(entity, 'P8345'),
    genres: qids(entity, 'P136'),
    links,
    externalIds: externalIds(entity),
  };
}

/** A creator, series, property or genre stub; null without an English label. */
export function mapRef(entity: WikidataEntity): {
  name: string;
  kind: 'person' | 'organization';
  description?: string;
} | null {
  const name = entity.labels?.en?.value.trim() ?? '';
  if (name.length < 1 || name.length > MAX_TITLE) return null;
  const kind = qids(entity, 'P31').includes('Q5') ? 'person' : 'organization';
  const description = entity.descriptions?.en?.value.trim();
  return description && description.length <= MAX_DESCRIPTION ? { name, kind, description } : { name, kind };
}

const GENRE_SUFFIX = / (film|television series|television program|novel|literature)$/;

/** Null when nothing slug-able is left (e.g. a non-Latin label), so the importer can skip the tag. */
export function genreTag(label: string): { name: string; slug: string } | null {
  const name = label.trim().replace(GENRE_SUFFIX, '');
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? { name, slug } : null;
}
