import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { inject } from 'vitest';
import type { OpenedDb } from '../../src/platform/db/open';
import * as schema from '../../src/platform/db/schema';

// Declared here rather than in the global setup so the web typecheck sees it through `@amdb/api/testing`.
declare module 'vitest' {
  interface ProvidedContext {
    /** The test server's URL without a database name. */
    testDatabaseUrl: string;
    /** Names this run's template and copies, so the teardown drops only its own. */
    testRunId: string;
  }
}

/**
 * SQLSTATE object_in_use: another session (autovacuum, for example) is briefly connected to the
 * template, and Postgres gives up waiting for it after about 5 s.
 */
const OBJECT_IN_USE = '55006';

async function onServer(fn: (client: pg.Client) => Promise<unknown>) {
  const client = new pg.Client({ connectionString: `${inject('testDatabaseUrl')}/postgres` });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

async function createDatabase(name: string, template: string) {
  await onServer(async (client) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
        return;
      } catch (err) {
        if ((err as { code?: string }).code !== OBJECT_IN_USE || attempt >= 5) throw err; // cast: pg errors carry the SQLSTATE in `code`
        await sleep(20);
      }
    }
  });
}

/** A fresh copy of the run's migrated template; closing it drops the database. */
export async function openTestDb(): Promise<OpenedDb> {
  const runId = inject('testRunId');
  const name = `amdb_t_${runId}_${randomBytes(6).toString('hex')}`;
  await createDatabase(name, `amdb_tpl_${runId}`);
  const pool = new pg.Pool({ connectionString: `${inject('testDatabaseUrl')}/${name}`, max: 4 });
  // An idle client erroring would otherwise crash the worker, as in openDb().
  pool.on('error', (err) => console.error('Postgres pool error', err));
  const db = drizzle({ client: pool, schema });
  const close = async () => {
    try {
      await pool.end();
    } finally {
      await onServer((client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    }
  };
  return { db, close };
}
