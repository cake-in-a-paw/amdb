import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';
import type { Db } from './types';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));

export interface OpenedDb {
  db: Db;
  close: () => Promise<void>;
}

/** A Postgres connection string. Pending migrations run before this returns. */
export async function openDb(url: string): Promise<OpenedDb> {
  const pool = new pg.Pool({ connectionString: url });
  // An idle client erroring (e.g. server restart) would otherwise crash the process.
  pool.on('error', (err) => console.error('Postgres pool error', err));
  const db = drizzle({ client: pool, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, close: () => pool.end() };
}
