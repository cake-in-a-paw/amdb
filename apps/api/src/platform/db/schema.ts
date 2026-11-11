import type {
  ChangeOp,
  ChangeStatus,
  CreatorKind,
  EntityKind,
  IdScheme,
  ImportRunStatus,
  ImportSource,
  Lifecycle,
  MediaType,
  RelationType,
  Role,
  Subtype,
  TagKind,
  WorkLinkType,
} from '@amdb/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
/** timestamptz with millisecond precision so cursors round-trip through JS Dates. */
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

// --- Users & auth (Better Auth core schema mapped onto our names) ---

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  /** Null until the user gives one; an email-code sign-up has none. */
  name: text('name'),
  image: text('image'),
  /** Opt-in public attribution; null shows as "contributor". Unique ignoring case (citext). */
  handle: citext('handle').unique(),
  role: text('role').$type<Role>().notNull().default('contributor'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    scope: text('scope'),
    idToken: text('id_token'),
    password: text('password'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_accounts_provider_account_key').on(t.providerId, t.accountId),
    index('auth_accounts_user_idx').on(t.userId),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
);

/** Property names match the @better-auth/passkey plugin's field names; the drizzle adapter looks them up by name. */
export const authPasskeys = pgTable(
  'auth_passkeys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    createdAt: ts('created_at').defaultNow(),
    aaguid: text('aaguid'),
  },
  (t) => [index('auth_passkeys_user_idx').on(t.userId), index('auth_passkeys_credential_idx').on(t.credentialID)],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('auth_verifications_identifier_idx').on(t.identifier)],
);

// --- Catalog ---

export const entities = pgTable('entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').$type<EntityKind>().notNull(),
  mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => entities.id),
  removedAt: ts('removed_at'),
  /** Set when the create that made this entity is rejected or reverted: a tombstone, read as unknown. */
  retractedByChange: uuid('retracted_by_change').references((): AnyPgColumn => changes.id),
  /** Maps a field name to the id of the change that last set it. */
  fieldSources: jsonb('field_sources').$type<Record<string, string>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const works = pgTable(
  'works',
  {
    entityId: uuid('entity_id')
      .primaryKey()
      .references(() => entities.id),
    mediaType: text('media_type').$type<MediaType>().notNull(),
    subtype: text('subtype').$type<Subtype>(),
    title: text('title').notNull(),
    titleNorm: text('title_norm').notNull(),
    originalTitle: text('original_title'),
    originalTitleNorm: text('original_title_norm'),
    description: text('description'),
    // A partial date: whatever the source knows. Null year = no date announced yet.
    releaseYear: smallint('release_year'),
    releaseMonth: smallint('release_month'),
    releaseDay: smallint('release_day'),
    lifecycle: text('lifecycle').$type<Lifecycle>().notNull().default('unknown'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    alternateTitles: text('alternate_titles')
      .array()
      .notNull()
      .default(sql`'{}'`),
    alternateTitlesNorm: text('alternate_titles_norm').notNull().default(''),
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title_norm, '') || ' ' || coalesce(original_title_norm, ''))`,
    ),
    altSearch: tsvector('alt_search').generatedAlwaysAs(sql`to_tsvector('simple', alternate_titles_norm)`),
  },
  (t) => [
    index('works_search_idx').using('gin', t.search),
    index('works_alt_search_idx').using('gin', t.altSearch),
    check('works_subtype', sql`(${t.mediaType} = 'film_tv') = (${t.subtype} IS NOT NULL)`),
    check('works_release_month_needs_year', sql`${t.releaseMonth} IS NULL OR ${t.releaseYear} IS NOT NULL`),
    check('works_release_day_needs_month', sql`${t.releaseDay} IS NULL OR ${t.releaseMonth} IS NOT NULL`),
    check('works_release_year_range', sql`${t.releaseYear} BETWEEN 1 AND 9999`),
    check('works_release_month_range', sql`${t.releaseMonth} BETWEEN 1 AND 12`),
    // CASE keeps make_date from running on out-of-range parts, which would raise instead of failing the check.
    check(
      'works_release_day_valid',
      sql`CASE WHEN ${t.releaseDay} IS NULL THEN true
        WHEN ${t.releaseYear} NOT BETWEEN 1 AND 9999 OR ${t.releaseMonth} NOT BETWEEN 1 AND 12 THEN false
        ELSE ${t.releaseDay} BETWEEN 1 AND extract(day FROM make_date(${t.releaseYear}, ${t.releaseMonth}, 1) + interval '1 month - 1 day') END`,
    ),
  ],
);

export const creators = pgTable('creators', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entities.id),
  name: text('name').notNull(),
  nameNorm: text('name_norm').notNull(),
  kind: text('kind').$type<CreatorKind>().notNull(),
  description: text('description'),
  alternateNames: text('alternate_names')
    .array()
    .notNull()
    .default(sql`'{}'`),
  alternateNamesNorm: text('alternate_names_norm').notNull().default(''),
});

export const series = pgTable('series', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entities.id),
  title: text('title').notNull(),
  titleNorm: text('title_norm').notNull(),
  description: text('description'),
});

export const properties = pgTable('properties', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entities.id),
  title: text('title').notNull(),
  titleNorm: text('title_norm').notNull(),
  description: text('description'),
});

export const tags = pgTable('tags', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entities.id),
  kind: text('kind').$type<TagKind>().notNull(),
  name: text('name').notNull(),
  nameNorm: text('name_norm').notNull(),
  slug: text('slug').notNull().unique(),
});

// --- History ---

/** One run of an importer: what it read, under which license, and how it ended. */
export const importRuns = pgTable(
  'import_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').$type<ImportSource>().notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),
    /** The evidence that the source is CC0. */
    licenseUrl: text('license_url').notNull(),
    /** The day someone last confirmed `licenseUrl` still says CC0. */
    licenseCheckedOn: date('license_checked_on', { mode: 'string' }).notNull(),
    status: text('status').$type<ImportRunStatus>().notNull(),
    stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error'),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    check('import_runs_status', sql`${t.status} IN ('running', 'finished', 'failed', 'capped')`),
    check('import_runs_finished', sql`(${t.status} = 'running') = (${t.finishedAt} IS NULL)`),
    // One run at a time: two concurrent runs would race on the same QIDs.
    uniqueIndex('import_runs_one_running')
      .on(t.status)
      .where(sql`${t.status} = 'running'`),
  ],
);

export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorUserId: uuid('author_user_id').references(() => users.id),
    anonHash: text('anon_hash'),
    /** Set when an import run wrote the submission. */
    importRunId: uuid('import_run_id').references(() => importRuns.id),
    note: text('note'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [check('submissions_one_author', sql`num_nonnulls(${t.authorUserId}, ${t.anonHash}, ${t.importRunId}) = 1`)],
);

export const changes = pgTable(
  'changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id),
    seq: integer('seq').notNull(),
    op: text('op').$type<ChangeOp>().notNull(),
    kind: text('kind').$type<EntityKind>().notNull(),
    /** Not a foreign key: a create reserves its id before the entities row exists. */
    entityId: uuid('entity_id'),
    relationId: uuid('relation_id').references((): AnyPgColumn => relations.id),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    base: jsonb('base').$type<Record<string, unknown>>(),
    inverse: jsonb('inverse').$type<Record<string, unknown>>(),
    status: text('status').$type<ChangeStatus>().notNull(),
    reason: text('reason'),
    dependsOn: uuid('depends_on')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    resubmitOf: uuid('resubmit_of').references((): AnyPgColumn => changes.id),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: ts('reviewed_at'),
    appliedAt: ts('applied_at'),
    redactedAt: ts('redacted_at'),
    redactionReason: text('redaction_reason'),
    /** A create's normalized title or name, so the duplicate check can find pending creates. */
    titleNorm: text('title_norm'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('changes_status_created_idx').on(t.status, t.createdAt),
    index('changes_pending_create_idx')
      .on(t.kind, t.titleNorm)
      .where(sql`${t.op} = 'create' AND ${t.status} = 'pending'`),
    index('changes_entity_id_idx').on(t.entityId),
    // A merge's `into`, as submitted and as resolved when it applied: how merges into an entity are found.
    index('changes_merge_into_idx')
      .on(sql`(${t.payload}->>'into')`)
      .where(sql`${t.op} = 'merge'`),
    index('changes_merge_inverse_into_idx')
      .on(sql`(${t.inverse}->>'into')`)
      .where(sql`${t.op} = 'merge'`),
  ],
);

export const relations = pgTable(
  'relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').$type<RelationType>().notNull(),
    fromId: uuid('from_id')
      .notNull()
      .references(() => entities.id),
    toId: uuid('to_id').references(() => entities.id),
    role: text('role'),
    position: integer('position'),
    linkType: text('link_type').$type<WorkLinkType>(),
    scheme: text('scheme').$type<IdScheme>(),
    value: text('value'),
    createdByChange: uuid('created_by_change')
      .notNull()
      .references((): AnyPgColumn => changes.id),
    removedByChange: uuid('removed_by_change').references((): AnyPgColumn => changes.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('relations_from_idx')
      .on(t.fromId)
      .where(sql`${t.removedByChange} IS NULL`),
    index('relations_to_idx')
      .on(t.toId)
      .where(sql`${t.removedByChange} IS NULL`),
    uniqueIndex('relations_external_id_key')
      .on(t.scheme, t.value)
      .where(sql`${t.type} = 'external_id' AND ${t.removedByChange} IS NULL`),
  ],
);
