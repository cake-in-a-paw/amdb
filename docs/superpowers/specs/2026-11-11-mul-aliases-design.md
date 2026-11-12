# Language-neutral aliases: design

Status: draft, 2026-11-11. Amends `2026-11-11-alternate-titles-design.md`.

## Why

Alternate names shipped reading only Wikidata's English (`en`) aliases. Searching "samuel clemens"
still finds nothing: Mark Twain's (Q7245) only English alias is "Thomas Jefferson Snodgrass", while
"Samuel Clemens", "Samuel L. Clemens" and "Samuel Langhorne Clemens" sit under `mul`, Wikidata's
code for names that are the same in every language. Wikidata has been moving names there, and the
importer already falls back to the `mul` *label* for the same reason (`englishLabel` in
`features/imports/wikidata/map.ts`). A `mul` alias applies to English by definition, so reading it
keeps to the owner's "English only" rule rather than breaking it.

Success: "samuel clemens" finds Mark Twain, and every imported work and creator carries its
`mul` aliases as well as its `en` ones.

## Goals

- The importer's alternate names come from `en` aliases and then `mul` aliases, for works
  (`alternateTitles`) and creators (`alternateNames`), on new imports and backfills.
- A backfill brings `mul` aliases to the works and creators already in AMDB, including the ~78,000
  whose list the first names backfill set from `en` aliases alone.

## Non-goals

- Labels or aliases in any other language code.
- Re-checking `en` aliases Wikidata has changed since they were imported; the backfill only adds.
- Any change to search, the edit form, merges or redaction.

## Anti-goals

- An import or backfill that changes a list a person has touched (constitution IV): the
  never-overwrite-people rule stands exactly as before.
- Names in a non-Latin script reaching AMDB through `mul`. (My call: see Decided.)
- Removing a name. The backfill only appends.

## Constraints

- Constitution 0.2.0 (`CLAUDE.md`) binds, as for the first feature: writes through
  `features/changes/apply.ts`, PGlite tests, no hand-edited OpenAPI snapshot, no edited applied
  migrations. No migration is expected.
- The client already requests `languages: 'en|mul'` with `aliases` in `props`, so no fetch changes.
- Production: the backfill needs the owner's go-ahead at that moment, runs alone, and never overlaps
  a deploy. The first names backfill took 2.5 hours for films, TV and books and grew the database by
  44 MB (1.396 to 1.440 GB of the 3.5 GB cap); this one fetches the same items, so expect similar
  time and less growth.

## Decided

By the owner: read `mul` aliases ("Spec it", after the Mark Twain finding).

By me:

- **Order and dedupe:** `en` aliases first, in Wikidata's order, then `mul` aliases, each trimmed,
  1–500 characters, deduped with `dedupeNames` against the main and original title and earlier
  names. An alias in both lists appears once, in its `en` position. The cap is below.
- **Latin script only from `mul`:** a `mul` alias is kept only when every letter in it is Latin
  script (`\p{Script=Latin}`); digits, punctuation, spaces and symbols don't count. `mul` is meant
  for Latin-script names but holds occasional native-script forms, and the owner deferred other
  scripts. `en` aliases are not filtered, as today. Cost if wrong: a few genuine English names
  written with a non-Latin letter are dropped from `mul`.
- **Which lists the backfill may change:** the first spec let an import set a list only if no
  change had ever touched it, imports included. That rule now reads: the backfill may change a list
  when every change that ever set it came from an import run (its submission has an
  `import_run_id`), in any status; nothing was ever merged into or out of the entity; and no create
  or update on it was redacted. A person's edit, a moderator's revert or rejection, a pending
  person's change: any of these still blocks, forever. A revert is a person's change, so a list a
  moderator reverted, even back to what an import wrote, stays put.
- **Reverts:** a revert is stored as a change whose payload is `{ revertOf }`, with no names key,
  so it doesn't match a key test. A revert, in any status, blocks the list when the change it
  reverts set that list (including an import's change). A revert of an unrelated change, such as
  a title edit, doesn't block. Every change has a submission (`changes.submission_id` is not null),
  so "came from an import run" is always decidable.
- **Append only:** for a list it may change, the backfill appends the computed names that the list
  doesn't already hold (normalized), after its current names, until the list has 50. It never
  removes or reorders, so the only way a name leaves a list is a person's edit, which then blocks
  the list. A list that would not change gets no revision. Lists never set behave as today (an
  append to empty).
- **Where the cap applies:** the en-then-mul list is computed uncapped. The 50 limit applies to
  the stored list after the append (for a create, to the new list), so a `mul` alias isn't lost
  to `en` aliases the list already holds.
- **No overwrite race:** `importSubmission` has no conflict check, and an update replaces the
  whole list. So the "only imports ever set it" check runs again inside the write's transaction,
  with the entity row locked (`FOR UPDATE`). A list a person or moderator touched between the read
  and the write is skipped and logged, not retried. This also closes the same window for lists
  being set for the first time, which today's backfill has.
- **Normal imports** (creates) use the same `en` then `mul` list. An import never updates a work it
  finds `present`; only `--backfill` adds names to existing entries.
- **Stats:** `namesAdded` keeps counting works and creators that got a names update, now including
  appends. No new counter.
- **No new flag:** `--backfill` already re-fetches every imported work and the creators it may name.

## Left to the builder

- How the "only imports ever set it" check is written: a variant of `findNamesTouched` that
  ignores import-run changes, or a second query; it must stay indexed (the 0011 indexes, plus the
  `submissions` join) and handle 50-id batches as today.
- Whether the creators fetched for names reuse the existing path unchanged.
- Test fixtures: a `mul`-only alias, an alias in both `en` and `mul`, a Cyrillic `mul` alias, a
  list a person edited, a list a moderator reverted, a list the first backfill set.

## Review focus

- A list the first names backfill set from `en` gains its `mul` aliases; a second backfill adds
  nothing (`namesAdded: 0`).
- A person clears a list the import set; the next backfill leaves it empty.
- A moderator reverts an import-set list; the next backfill leaves it alone.
- A list at 50 names gets nothing appended; one at 48 gets two.
- A moderator reverts the import's names change; the next backfill leaves the list alone. A
  revert of the same work's title edit doesn't stop names being appended.
- A person edits a list while the backfill is between its read and its write; the person's list
  survives, and the skip is logged.
- "samuel clemens" finds Mark Twain after the backfill.
