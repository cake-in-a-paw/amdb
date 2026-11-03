import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema';

/** Works for both the PGlite (tests, local dev) and node-postgres (production) drivers. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;
