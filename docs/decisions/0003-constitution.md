# 0003. Adopt a constitution in CLAUDE.md

- **Status:** proposed
- **Date:** 2026-11-03

## Context

AMDB is an open, CC0, crowd-sourced database. Contributors and their AI sessions need one
shared, checkable definition of good code before any code exists.

## Decision

`CLAUDE.md` is the constitution, in the same form, length and governance as rmd's
(rmd ADR 0003), trimmed to rules that outlast any one feature:

- **Scope, features and leniencies live in specs.**
- **Process lives in superpowers**, and default agent behavior isn't restated.
- **Commands and layout details live in README.md.**

Carried over from rmd, adapted only where AMDB differs: tests against real Postgres and never
weakened; simple by default, uniform by rule; feature folders with three layers; types and
schemas as the contract; the database guarding its invariants; one error shape; dependencies as
decisions; no dead architecture; the standards and the governance (amendments by ADR, semver).
The pull-request rule is stated already relaxed, as rmd's ADR 0006 relaxed it: changes may
land on `main` when `pnpm check` passes, until other contributors commit here.

Replacing rmd's principles I and II, and added around them:

- **Privacy is tested from the outside** adapts rmd's "visibility rules" to AMDB's private
  data: pending and rejected submissions, contributor emails and API usage.
- **Everything is CC0** replaces "upstream sources are origins, not dependencies". Provenance
  and license evidence matter more than caching terms, and rmd's timeout, rate-limit and
  `Retry-After` rules still apply to importers.
- **Every change is a recorded revision**, with redaction as the one exception.
- **Contributors' work is never discarded.**
- **One dataset, three views.**

Rmd's catalogue-sources adapter rule and its `catalogue` spelling exception are dropped.

## Alternatives considered

- **Copy rmd's constitution unchanged.** Its upstream-sources principle doesn't fit a CC0
  dataset, and it has nothing on revisions or contributor work.
- **No constitution until the code exists.** The first commits would set habits that are
  then argued over.
- **A long-form constitution.** rmd drafted one at about 250 lines and trimmed it, because it
  duplicated the specs and skills.

## Consequences

Agents and contributors have bright-line rules to check work against. Most of the architecture
rules can be enforced by tests (for example, an architecture test that catalog writes happen
only in `features/changes/apply.ts`) as the code lands.
