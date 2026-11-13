import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema';

/** The node-postgres driver's database, used everywhere. */
export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;
