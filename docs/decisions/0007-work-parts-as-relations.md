# 0007. Model work parts as a relation, not a column

- **Status:** accepted
- **Date:** 2026-11-12

## Context

TV seasons and episodes (and later tracks, expansions and DLC) need to be works under a parent
work. The design spec (§11) left open whether they are works at all. Every catalog write is a
revision (constitution III), and relations already carry revisions, history, revert and merge.

## Decision

A part is a work whose subtype is a part subtype (`season`, `episode`), attached to its parent by a
`work_part` relation: `from_id` is the parent, `to_id` the part, `position` an optional whole
number. The tree rules (which subtype may sit under which) live once in `@amdb/shared` (`PART_OF`).
The database enforces one live parent per part with the unique index `relations_one_parent`, and
the `relations_type_columns` check gains a `work_part` arm.

## Alternatives considered

- **`parent_id` and `root_id` columns on works, as in rmd** — rejected. A column change would
  bypass the relation revision log, so attaching, moving and retiring a part would need its own
  history, revert and merge handling; `root_id` is denormalized state that must be kept in step.
  A relation gets all of that from the existing machinery.
- **Seasons and episodes as series entries** — rejected. A series is an ordered set of peers;
  episodes need a nested tree, and each part is itself a work with its own credits and ids.

## Consequences

Parts reuse revisions, history and revert. Walking a tree takes a recursive query over live
`work_part` rows, which the partial indexes serve. Parts are told apart from roots by subtype, so
orphans stay out of default listings. New media types add rows to `PART_OF`. Revisit if trees
deepen enough that the recursive read is slow.
