import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import pg, { type QueryResultRow } from 'pg';
import { expect, inject, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/platform/db/open';
import { users } from '../src/platform/db/schema';
import { openTestDb } from './helpers/test-db';

type TestDb = Awaited<ReturnType<typeof openTestDb>>['db'];

async function rows<T extends QueryResultRow>(db: TestDb, query: ReturnType<typeof sql>) {
  return (await db.execute<T>(query)).rows;
}

async function currentDatabase(db: TestDb) {
  const [row] = await rows<{ name: string }>(db, sql`select current_database() as name`);
  return row!.name;
}

async function databaseExists(name: string) {
  const client = new pg.Client({ connectionString: `${inject('testDatabaseUrl')}/postgres` });
  await client.connect();
  try {
    const { rows } = await client.query('select 1 from pg_database where datname = $1', [name]);
    return rows.length > 0;
  } finally {
    await client.end();
  }
}

it('gives each test its own database', async () => {
  const a = await openTestDb();
  const b = await openTestDb();
  try {
    await a.db.insert(users).values({ email: 'only-in-a@example.com', name: 'A' });
    expect(await b.db.select().from(users).where(eq(users.email, 'only-in-a@example.com'))).toEqual([]);
  } finally {
    await a.close();
    await b.close();
  }
});

it('drops the database on close, even with a connection left open', async () => {
  const opened = await openTestDb();
  const name = await currentDatabase(opened.db);
  expect(name).toContain(inject('testRunId'));
  const straggler = new pg.Client({ connectionString: `${inject('testDatabaseUrl')}/${name}` });
  // The forced drop terminates this idle connection, which pg reports as an 'error' event. Without a
  // listener, that event would surface as an unhandled error and fail the run.
  straggler.on('error', () => {});
  await straggler.connect();
  await opened.close();
  expect(await databaseExists(name)).toBe(false);
  await straggler.end().catch(() => {}); // the server already closed it
});

it('starts from a template with every migration applied', async () => {
  const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as {
    entries: unknown[];
  };
  const opened = await openTestDb();
  try {
    const [row] = await rows(opened.db, sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(row).toEqual({ n: journal.entries.length });
  } finally {
    await opened.close();
  }
});

it('runs Postgres 18 and sorts text like production (en_US.utf8)', async () => {
  const opened = await openTestDb();
  try {
    const [version] = await rows<{ v: number }>(opened.db, sql`select current_setting('server_version_num')::int as v`);
    expect(Math.floor(version!.v / 10000)).toBe(18);
    const sorted = (
      await rows<{ t: string }>(opened.db, sql`select t from (values ('Zebra'), ('apple'), ('Apple')) v(t) order by t`)
    ).map((r) => r.t);
    // en_US.utf8 puts 'apple' before 'Apple' before 'Zebra'; character (C) order would not.
    expect(sorted).toEqual(['apple', 'Apple', 'Zebra']);
  } finally {
    await opened.close();
  }
});
