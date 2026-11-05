import { defineRailway, github, postgres, preserve, project, service } from 'railway/iac';

// One environment, `production`, deploys `main` once the commit's GitHub checks pass (ADR 0005).
// One service serves the API and the built SPA from a single origin (ADR 0004).
export default defineRailway(() => {
  const domain = 'amdb.ty-pe.com';

  const db = postgres('postgres');

  const app = service('app', {
    // checkSuites holds a deploy until the commit's GitHub checks (CI) pass.
    source: github('cake-in-a-paw/amdb', { branch: 'main', checkSuites: true }),
    build: 'pnpm --filter @amdb/web build',
    // The API applies Drizzle migrations at boot (platform/db/open.ts), so there is no preDeploy.
    start: 'pnpm --filter @amdb/api start',
    healthcheck: '/api/health',
    // Railway's config can't register a custom domain: `railway domain` does, on the linked `app`
    // service, so docs/deploy.md step 3 applies once without it, registers it, then restores it.
    domains: [domain],
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      // `pnpm --filter` runs the start script from apps/api.
      WEB_DIST_DIR: '../web/dist',
      BETTER_AUTH_URL: `https://${domain}`,
      WEB_ORIGIN: `https://${domain}`,
      // Railway's edge is one proxy; the Cloudflare record must stay DNS-only (ADR 0005).
      TRUSTED_PROXY_HOPS: '1',
      // Secrets are set in Railway. The repo is public, so not even the admin addresses live here.
      BETTER_AUTH_SECRET: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      GITHUB_CLIENT_ID: preserve(),
      GITHUB_CLIENT_SECRET: preserve(),
      EMAIL_API_KEY: preserve(),
      EMAIL_FROM: preserve(),
      ADMIN_EMAILS: preserve(),
    },
  });

  return project('amdb', {
    resources: [db, app],
  });
});
