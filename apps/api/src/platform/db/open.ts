import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import * as schema from './schema';
import type { Db } from './types';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));

export interface OpenedDb {
  db: Db;
  close: () => Promise<void>;
}

/**
 * `pglite:memory` opens a throwaway in-memory database, `pglite:<dir>` an embedded one stored in
 * <dir> (local dev without Postgres). Anything else is a Postgres connection string.
 * Pending migrations run before this returns.
 */
export async function openDb(url: string): Promise<OpenedDb> {
  if (url.startsWith('pglite:')) {
    const dir = url.slice('pglite:'.length);
    const client =
      dir === 'memory' ? new PGlite({ extensions: { citext } }) : new PGlite(dir, { extensions: { citext } });
    const db = drizzlePglite({ client, schema });
    await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
    // The PGlite and node-postgres drizzle types differ but expose the same query API that `Db` models.
    return { db: db as unknown as Db, close: () => client.close() };
  }
  const pool = new pg.Pool({ connectionString: url });
  // An idle client erroring (e.g. server restart) would otherwise crash the process.
  pool.on('error', (err) => console.error('Postgres pool error', err));
  const db = drizzlePg({ client: pool, schema });
  await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, close: () => pool.end() };
}
