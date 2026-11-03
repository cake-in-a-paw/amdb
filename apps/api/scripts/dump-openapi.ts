import { createApp } from '../src/app';
import { openDb } from '../src/platform/db/open';
(async () => {
  const { db, close } = await openDb('pglite:memory');
  const app = createApp({ db, getSession: async () => null });
  const doc = await (await app.request('/api/openapi.json')).json();
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  await close();
})();
