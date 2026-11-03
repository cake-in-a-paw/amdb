import { serve } from '@hono/node-server';
import { createApp } from './app';
import { parseEnv } from './env';
import { openDb } from './platform/db/open';

const env = parseEnv();
const { db } = await openDb(env.DATABASE_URL);

// Sessions come from Better Auth once it is wired; until then no caller is signed in.
const app = createApp({ db, getSession: async () => null, webOrigin: env.WEB_ORIGIN });

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
