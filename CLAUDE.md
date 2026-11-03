# AMDB — Constitution

Durable rules for how code is written here, for contributors and AI sessions alike. What the
product does lives in `docs/superpowers/specs/`; why a technical choice was made lives in
`docs/decisions/` (ADRs). This file holds only rules that outlast any one feature, and it wins
where a skill or habit disagrees. `AGENTS.md` links here.

Agent sessions use superpowers for all code changes.

## Principles

### I. Privacy Rules Are Tested from the Outside

Who may see what is defined in the specs.

- Pending and rejected submissions (beyond the duplicate-check fields), contributor emails and
  API usage each have a test that calls the API as someone who shouldn't see them and asserts
  the response.
- A caller who can't see a resource gets 404, not 403, so its existence doesn't leak. A 403 is
  for a caller who can see it but can't take that action.

### II. Everything Is CC0

- Every field records where it came from.
- Importers only read CC0 sources, with the license evidence in their spec. Nothing goes in
  unless its origin can be shown to be CC0.
- Every submission carries `cc0: true`; one without it is a 400.
- Every importer call has a timeout and a rate limit, and honors `Retry-After`. A failing
  upstream degrades to an explicit "unavailable", never a 500, a hang, or an empty result that
  looks like "no matches".

### III. Every Change Is a Recorded Revision

- No write bypasses the revision log, imports and moderator fixes included.
- History is append-only; a revert is a new revision.
- The one exception is legal or abuse removal (redaction): it erases a revision's content
  (`payload`, `inverse`) but keeps the revision as a stub.

### IV. Contributors' Work Is Never Discarded

- Rejection returns the work with a reason and keeps the change and its payload.
- Nothing a contributor submitted is hard-deleted, except by redaction (III).

### V. One Dataset, Three Views

The browser, the API and the dumps serve the same data. A dump is a snapshot of what the API
served, never a separate pipeline.

### VI. Tests Run Against Real Postgres

- Tests drive the HTTP API against PGlite with the real migrations.
- Only external services (data sources, OAuth providers) are faked, through injected
  dependencies. Modules are never mocked.
- A failing test is fixed by fixing the code, or by changing the expectation with the reason in
  the commit. Never skip, delete or loosen an assertion to reach green.

### VII. Simple by Default, Uniform by Rule

Add an abstraction once three real cases need it. When two options are equally simple, pick the
one that won't need ripping out for the next media type or source in the specs. That only breaks
ties; it never justifies speculative abstraction. Uniform layering (VIII) is the one sanctioned
exception.

### VIII. Feature Folders, Three Layers

`apps/api/src/features/<feature>/` holds at least:

- `routes.ts` — HTTP only;
- `service.ts` — the rules;
- `repository.ts` — Drizzle queries only;
- `schemas.ts` — zod/OpenAPI shapes.

A feature may add more files as long as each one keeps to these layers' rules.

How the layers connect:

- Routes always call a service, even a pass-through. Don't remove pass-throughs as
  simplification.
- Features change each other's data only through services. A repository may join another
  feature's tables to read display fields, but never writes them or re-implements their rules.
- Every write to catalog tables happens in `features/changes/apply.ts`.
- Shared infrastructure lives in `src/platform/` and knows nothing about features.
- `createApp(deps)` wires everything, and entry files only wire.

### IX. Types and Schemas Are the Contract

- TypeScript strict with `noUncheckedIndexedAccess`. Every `any`, cast or `@ts-expect-error`, and
  every non-null `!` outside tests, carries a comment saying why.
- The zod schemas generate the OpenAPI document, and clients use types generated from it, never
  hand-written ones.
- Value lists live once in `@amdb/shared`.

### X. The Database Guards Its Invariants

- Every schema change is a committed Drizzle migration. An applied migration is never edited.
- Cross-column rules and ranges are `CHECK`s. Value lists are `text`, never Postgres `ENUM`s.
- Uniqueness that matters is a unique index, and a violation becomes a 409 or an idempotent
  result, never a 500.
- Writes that must agree share a transaction.

### XI. One Error Shape

Every API error is `{ "error": { "code", "message", "details"? } }` with the right status.
Don't catch and continue. Clients render explicit loading, error and empty states.

### XII. Dependencies Are Decisions

- Check whether an existing dependency already does the job before building a mechanism by hand.
- A new dependency is named in the spec or plan with its purpose. A significant one gets an ADR.
- Versions are pinned exactly.

### XIII. No Dead Architecture

A replaced approach is deleted in the same change: no `_v2` names, shims or commented-out code.
Docs describe what's true now. A superseded ADR is marked `superseded by NNNN`, not rewritten.

## Standards

- **Gates.**
  - The pre-commit hook formats and lints staged files (Prettier, oxlint) and typechecks the
    working tree. The commit-msg hook checks the message.
  - `pnpm test` passes before every commit.
  - `pnpm check` passes before every push.
  - CI runs `pnpm check` and is the gate of record.
- **Pull requests.** Everything lands through a PR with one reviewer's approval and green CI.
  _Relaxed for now:_ until other contributors start committing here, changes may land directly
  on `main`, without a PR, as long as `pnpm check` passes.
- **Commits.** Conventional Commits, `type(scope): subject`. Scopes are `api`, `web`, `shared`,
  `db`, `adr` and `ci`.
- **Spelling.** American English everywhere.
- **Shortcuts.** A shortcut that would be wrong at scale is recorded under
  `## Production Annotations` in its spec.
- **Decisions.** A non-trivial technical or process choice gets an ADR (template `0000`), with
  the rejected alternatives.

Commands and setup are in `README.md`.

## Governance

An amendment is a PR approved by a second maintainer, with an ADR unless it only fixes wording.
While the pull-request rule is relaxed, an amendment still needs its ADR and version bump, but
not the approval. The version bump is MAJOR to remove or redefine a principle, MINOR to add one,
PATCH to clarify.

**Version**: 0.1.0 (proposed) | **Ratified**: — | **Last Amended**: —
