import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { MIGRATIONS_FOLDER } from '../src/platform/db/open';

const COMPOSE_FILE = fileURLToPath(new URL('../../../compose.yaml', import.meta.url));
const COMPOSE_URL = 'postgres://postgres:postgres@localhost:55442';
const COMPOSE_ATTEMPTS = 3;

/**
 * Runs `fn`, rethrowing any failure as an error with no stack frames. Vitest 5.0.5 crashes while
 * source-mapping a frame from a global setup file (`code.charCodeAt is not a function`) and never
 * prints the message, so the frames go. Drizzle keeps the Postgres error in `cause`, so its message
 * is kept too.
 */
async function withPrintableErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const { message, cause } = err as { message?: string; cause?: { message?: string } }; // cast: whatever was thrown, read only its messages
    const text = [message ?? String(err), cause?.message].filter(Boolean).join('\n');
    const error = new Error(text);
    error.stack = `Error: ${text}`;
    throw error;
  }
}

/** Starts the compose test container (or reuses it if it's running) and returns its URL. */
async function startComposeServer(): Promise<string> {
  const run = promisify(execFile);
  const output = (err: unknown) => {
    const { stderr, message } = err as { stderr?: string; message: string }; // cast: execFile rejects with an Error carrying stderr
    return stderr || message;
  };
  // Asking the daemon for its version first separates "Docker isn't running" (or isn't installed)
  // from a compose failure such as a port conflict or a failed pull.
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}']);
  } catch (err) {
    throw new Error(
      `Start Docker to run the tests (the docker command is missing or can't reach the Docker daemon).\n${output(err)}`,
    );
  }
  // --no-recreate: every checkout shares this container, so a compose.yaml that differs in
  // another worktree mustn't recreate it (wiping the tmpfs) under a run in progress. A stale
  // container is still caught by checkServer. --wait-timeout makes a stalled pull fail. Two
  // checkouts starting the container at once can make one `up` fail, so it is retried.
  let lastError: unknown;
  for (let attempt = 1; attempt <= COMPOSE_ATTEMPTS; attempt++) {
    try {
      await run('docker', [
        'compose',
        '-f',
        COMPOSE_FILE,
        'up',
        '-d',
        '--no-recreate',
        '--wait',
        '--wait-timeout',
        '180',
        'postgres-test',
      ]);
      return COMPOSE_URL;
    } catch (err) {
      lastError = err;
      if (attempt < COMPOSE_ATTEMPTS) await sleep(2000);
    }
  }
  throw new Error(`docker compose up postgres-test failed.\n${output(lastError)}`);
}

/** Checks that `TEST_DATABASE_URL` names a server, since the setup appends a database name to it. */
function serverUrl(raw: string): string {
  const { pathname } = new URL(raw);
  if (pathname !== '' && pathname !== '/') {
    throw new Error('TEST_DATABASE_URL must name a server, not a database (drop the path after the host).');
  }
  return raw.replace(/\/$/, '');
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Fails unless the server sorts and behaves like production: Postgres 18 with libc en_US.utf8. */
async function checkServer(url: string) {
  await withClient(`${url}/postgres`, async (client) => {
    // template1, because CREATE DATABASE without a TEMPLATE copies it, locale included.
    const { rows } = await client.query<{ version: number; collate: string; provider: string }>(
      `select current_setting('server_version_num')::int as version, datcollate as collate,
         datlocprovider as provider
       from pg_database where datname = 'template1'`,
    );
    const [server] = rows;
    if (!server) throw new Error('The test server has no template1 database.');
    if (Math.floor(server.version / 10000) !== 18) {
      throw new Error(`The test server must run Postgres 18, but server_version_num is ${server.version}.`);
    }
    if (server.collate !== 'en_US.utf8') {
      throw new Error(`The test server must sort with en_US.utf8, but template1 uses ${server.collate}.`);
    }
    // 'c' is libc, as on Railway; 'i' (ICU) or 'b' (builtin) would sort differently.
    if (server.provider !== 'c') {
      throw new Error(
        `The test server must use the libc locale provider ('c'), but template1 uses '${server.provider}'.`,
      );
    }
  });
}

async function prepare({ provide }: Pick<TestProject, 'provide'>) {
  const url = process.env.TEST_DATABASE_URL ? serverUrl(process.env.TEST_DATABASE_URL) : await startComposeServer();
  await checkServer(url);

  const runId = randomBytes(4).toString('hex');
  const template = `amdb_tpl_${runId}`;
  await withClient(`${url}/postgres`, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${template}"`);
    await client.query(`CREATE DATABASE "${template}"`);
  });
  // Ending the pool closes every connection to the template, which CREATE DATABASE … TEMPLATE requires.
  const pool = new pg.Pool({ connectionString: `${url}/${template}` });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_FOLDER });
  } catch (err) {
    // No teardown runs when the setup fails, so a template that didn't migrate is dropped here.
    await pool.end();
    await withClient(`${url}/postgres`, (client) => client.query(`DROP DATABASE "${template}" WITH (FORCE)`));
    throw err;
  }
  await pool.end();

  provide('testDatabaseUrl', url);
  provide('testRunId', runId);

  return () =>
    withClient(`${url}/postgres`, async (client) => {
      // Copies a test failed to close; starts_with, because LIKE would read each `_` as a wildcard.
      const { rows } = await client.query<{ datname: string }>(
        `select datname from pg_database where starts_with(datname, $1)`,
        [`amdb_t_${runId}_`],
      );
      for (const { datname } of rows) await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      await client.query(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
    });
}

export default async function setup(project: Pick<TestProject, 'provide'>) {
  const teardown = await withPrintableErrors(() => prepare(project));
  return () => withPrintableErrors(teardown);
}
