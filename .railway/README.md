# Railway configuration

The Railway project is defined in code in `.railway/railway.ts` (ADR 0005). The `railway` package
is a root devDependency, so `pnpm install` provides the SDK; the CLI is installed separately.

```bash
railway config plan     # preview what would change; safe
railway config apply    # apply it (asks first)
railway config pull     # import the live project into code
```

First-time setup is in `docs/deploy.md`.

- Secrets and `ADMIN_EMAILS` are `preserve()`d: set them in Railway, never in this file. The repo
  is public.
- Railway's config can't register a custom domain. Use `railway domain` on the linked `app`
  service (see `docs/deploy.md` step 3).
- Destructive changes in non-interactive sessions need `--confirm-destructive` after reviewing
  the plan.
