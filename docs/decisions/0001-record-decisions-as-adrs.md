# 0001. Record decisions as ADRs

- **Status:** proposed
- **Date:** 2026-11-03

## Context

AMDB is meant to outlive its first author and take contributions from people and AI sessions
who weren't there when choices were made. Reasons for technical and process choices are lost
unless they are written down where the code is.

## Decision

Each non-trivial technical or process choice gets a short Architecture Decision Record in
`docs/decisions/`, numbered in order, from the template in `0000-template.md`: context,
decision, rejected alternatives, consequences. An ADR is never rewritten after acceptance; a
replacement is a new ADR, and the old one is marked `superseded by NNNN`.

## Alternatives considered

- **Reasons in commit messages only.** They are hard to find and aren't reviewed as documents.
- **Reasons inside the specs.** Specs describe what the product does and change with it. An ADR
  records why a choice was made at one point in time.
- **A wiki.** It drifts from the code and isn't versioned with it.

## Consequences

Choices and their rejected alternatives are findable and reviewable in the repo. Writing an ADR
costs a few minutes per decision, so only non-trivial choices get one.
