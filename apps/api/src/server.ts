import { serve } from '@hono/node-server';
import { createApp } from './app';
import { parseEnv } from './env';
import { createBeforeUserCreate, createSignInCodeSender } from './features/users/auth-hooks';
import { createAuth, getSessionFromAuth } from './platform/auth/auth';
import { openDb } from './platform/db/open';
import { createResendClient } from './platform/email/resend';

const env = parseEnv();
const { db } = await openDb(env.DATABASE_URL);
const email = createResendClient({ apiKey: env.EMAIL_API_KEY, from: env.EMAIL_FROM });
const auth = createAuth(db, env, {
  beforeUserCreate: createBeforeUserCreate({ adminEmails: env.ADMIN_EMAILS }),
  sendSignInCode: createSignInCodeSender(email),
});

const app = createApp({
  db,
  getSession: (headers) => getSessionFromAuth(auth, headers),
  authHandler: (request) => auth.handler(request),
  webOrigin: env.WEB_ORIGIN,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
