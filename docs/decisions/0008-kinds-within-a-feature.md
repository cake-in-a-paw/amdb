# 0008. A feature's parallel kinds each get a module of the same shape

- **Status:** accepted
- **Date:** 2026-11-13

## Context

Principle VIII says which files a feature folder holds, but not what happens when a feature's
rules start to differ by a value from a shared value list, such as a media type. Without a rule,
each new value adds inline checks to the existing service.

rmd, which AMDB's constitution is modeled on (ADR 0003), shows where that leads (rmd ADR 0014).
Its catalogue service grew to about 2,130 lines across five categories. Every function branched
on category, subtype and source at once, a half-built per-category table sat beside the inline
checks, and a size-driven split (`music.ts`) produced a file shaped like nothing else. Every new
category touched every function, and the restructure now takes a 12-task plan.

AMDB is on the same path, two values in. On 2026-11-13 it had about 15 literal checks on media
type (`film_tv`, `book`), mostly in the web edit form, the submission builder and the Wikidata
importer. The specs already name games and music as later media types.

AMDB's entity kinds (work, creator, series, property, tag) also have five values. But each kind
has its own table, and the switches on them in `changes/apply.ts` and the catalog entity view
choose the table and its columns. They don't hold rules that vary by kind.

## Decision

Principle VIII gains a **Kinds** rule (constitution 0.2.0 → 0.3.0, MINOR):

- When a feature's rules vary by a value from a shared value list (a media type, an import
  source), and three or more values have rules of their own (VII), each such value is a kind.
- Each kind lives in `features/<feature>/kinds/<kind>/` and implements one interface the feature
  declares. The core reaches a kind through one table keyed by the value list
  (`Record<MediaType, …>`) and never compares against a kind's value. `mediaType === 'book'`
  outside its kind is a defect, in any feature. Another feature that needs a kind's rule asks the
  owning feature's service.
- Subtypes belong to their kind (season and episode to film and TV). What all kinds share lives
  once in the core, and a helper some kinds share is a module beside them, never a copy.
- Below three, inline checks are allowed. The change that adds the third value first moves the
  existing checks into kinds.
- An entity kind's switch that only picks its table and columns isn't a kind's rule. Once one
  holds rules that differ by entity kind, the rule applies to it.
- The web app mirrors the split: one module per kind, behind the same keyed table.

An automated check, a test that fails on a literal comparison against a value-list value outside
`kinds/`, comes with the change that introduces the first kinds. Today it would only flag the
allowed media-type checks.

## Alternatives considered

- **Wait until the third media type, as rmd did.** rmd adopted its rule after five categories
  had grown into one service, and is paying for a restructure. Writing the rule now costs a few
  lines and makes the third media type start as a module.
- **Split by file size** (a service splits past about 1,000 lines). It catches the symptom late
  and says nothing about shape, so each split file grows its own structure, as rmd's `music.ts`
  did.
- **One feature per media type** (`features/books/`, `features/games/`). Every media type writes
  `works` and its relations, and all catalog writes must go through `features/changes/apply.ts`
  (VIII), so a media-type feature couldn't own its writes.
- **Count entity kinds now.** It would make `apply.ts`'s table-mapping switches defects the day
  the rule lands, when they are a lookup of where each kind is stored, not differing rules.
- **A new principle instead of a rule in VIII.** The rule is about how a feature folder is laid
  out, which is VIII's subject, and a new principle would invite renumbering.

## Consequences

- The third media type is a new folder implementing a known interface, and reviewers can compare
  kinds side by side.
- The change that adds it is larger: it first moves the existing film/TV and book checks into
  kinds, across API and web.
- The interface must fit every kind, so some members will be optional. A need only one kind has
  may push a change to the interface rather than a local branch.
- Revisit if a value list's values turn out to share nearly all their rules, so that a keyed
  table of settings fits better than per-kind modules.
