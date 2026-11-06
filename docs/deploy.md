# Deploying AMDB to Railway

The first-time runbook for `https://amdb.ty-pe.com` (ADR 0005). Each step ends with how to know
it worked. Do not move on until it did. Steps 2, 3, 6 and 7 write to outside services, so each
needs the owner's go-ahead at that moment.

The Railway project is defined in `.railway/railway.ts`. Secrets are never in git: the file marks
them `preserve()`, and you set them in Railway.

## 1. Check the Railway plan has a custom-domain slot

A trial account hit its limit before. In the Railway dashboard, open the workspace's plan and
confirm it allows a custom domain.

Verify: the plan page lists custom domains with at least one free. If not, upgrade first.

## 2. Create the repo and push `main`

Check first that every commit on `main` is signed:

```bash
git log --format='%h %G? %s' main | rg -v '^\S+ G '   # prints nothing when all are signed
```

Create the public `cake-in-a-paw/amdb` repo on GitHub and push `main`. Then install the Railway
GitHub app on that repo (GitHub, Settings, Applications, Railway, Repository access).

Verify: GitHub shows every commit as Verified, CI runs and passes on `main`, and the Railway app
lists `amdb` as an accessible repository.

## 3. Create the Railway project and plan it

```bash
railway init            # create the project "amdb"; the environment is "production"
railway link            # if init did not already link this directory
railway config plan     # read it before applying anything
```

`.railway/railway.ts` lists `amdb.ty-pe.com` under `domains`, but Railway's config can't register
a custom domain (CLI 5.71: "Custom-domain registration is not supported by Railway
configuration"), and `railway domain` needs the `app` service to exist. So the first apply runs
without the domain:

```bash
# temporarily set domains: [] in .railway/railway.ts
railway config plan     # 2 to add: postgres and app; nothing else
railway config apply
railway domain amdb.ty-pe.com --service app   # prints the CNAME and _railway-verify TXT for step 7
git checkout .railway/railway.ts              # restore domains: [domain]
railway config plan     # no domain error
railway config apply    # if the plan still shows a change (the first apply left checkSuites unset)
railway config plan     # "already up to date"
```

Verify: the final `railway config plan` reports the configuration is up to date. The project has a
`postgres` and an `app` service. `app`'s first deploy fails until the secrets (step 6) exist; that
is expected. Step 6 ends with an explicit redeploy.

## 4. Create the OAuth clients

Callbacks are on the production origin; Better Auth builds its sign-in `callbackURL` from the
app's origin, so `https://amdb.ty-pe.com` must be a trusted origin. It is: `WEB_ORIGIN` feeds
`trustedOrigins` in `platform/auth/auth.ts`.

- Google (Cloud Console, APIs and Services, Credentials, OAuth client ID, Web application):
  authorized redirect URI `https://amdb.ty-pe.com/api/auth/callback/google`. No JavaScript
  origin is needed: the sign-in is a server-side redirect.
- GitHub (Settings, Developer settings, OAuth Apps): homepage `https://amdb.ty-pe.com`,
  callback `https://amdb.ty-pe.com/api/auth/callback/github`. A GitHub OAuth app allows one
  callback URL, so this app is for production only; local development uses its own.

Verify: each provider shows the exact callback above. Keep the client id and secret for step 6.

## 5. Verify a Resend sending domain

In Resend, add a sending domain (for example `amdb.ty-pe.com`), write the DNS records it gives
you in Cloudflare (DNS-only), and create an API key. Choose the `EMAIL_FROM` value, such as
`AMDB <code@amdb.ty-pe.com>`.

Verify: Resend shows the domain as Verified.

## 6. Set the secrets

In Railway, on the `app` service, production environment, set:

`BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `EMAIL_API_KEY`, `EMAIL_FROM` and `ADMIN_EMAILS`
(comma-separated addresses that become admins on sign-up).

Then redeploy explicitly, since the first deploy already failed and setting variables may not
trigger another:

```bash
railway redeploy --service app
```

Verify: `railway config plan` shows no changes to these variables (they are `preserve()`d), and
the redeploy goes healthy. A missing variable fails boot with `Invalid environment:` and the
variable's name in the deploy log. The build log shows Node 24, the major CI runs: `.node-version`
says `24` and `engines.node` in `package.json` says `24.x`. Any other major means the pin was
ignored; stop and fix it before going on.

## 7. Write the DNS records

The domain was registered in step 3 (`railway domain amdb.ty-pe.com`, on the linked `app`
service). If it was not, run that now.

Railway prints a CNAME target and a `_railway-verify` TXT value. In Cloudflare, create
`CNAME amdb` pointing at the target and a TXT `_railway-verify.amdb` with the value. Both must
be **DNS-only (gray cloud)**. A proxied record adds a hop to `X-Forwarded-For` and breaks the
rate limiter's client address (ADR 0005).

Verify: `dig +short CNAME amdb.ty-pe.com` shows Railway's target (a proxied record would show
Cloudflare IPs instead), and Railway shows the domain as verified with a certificate issued.

## 8. Smoke test

On `https://amdb.ty-pe.com`:

- `curl -s https://amdb.ty-pe.com/api/health` returns `{"ok":true}`.
- The home page renders.
- Sign in by email code with an `ADMIN_EMAILS` address; the code email arrives, and the account
  has the `admin` role (the moderation queue is reachable).
- Sign in with Google and sign in with GitHub, each a full round trip back to the site. This
  proves the callbacks, the trusted origin and the secrets. Use accounts that are not admins.
- Submit an entry anonymously, approve it as admin, and see it on its page.
- Requests from two different networks (say, home Wi-Fi and a phone on cellular) get separate
  anonymous rate-limit buckets: exhaust the limit from one and confirm the other is not
  throttled. If both share a bucket, the record is proxied or `TRUSTED_PROXY_HOPS` is wrong.

Verify: every item above passes. Then record the live site in the owner's hosting notes.
