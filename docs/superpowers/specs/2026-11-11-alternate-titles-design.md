# Alternate titles: design

Status: approved, 2026-11-11.

Amended by `2026-11-11-mul-aliases-design.md` (mul aliases; imports may extend lists only imports set).

## Why

People search for a work or creator by the name they know it by, and that is often not the
title AMDB shows. Searching "1984" returns two films titled *1984* but not Orwell's novel, because
Wikidata's English label is "Nineteen Eighty-Four" and AMDB searches only the main and original
title. Wikidata lists "1984" as one of the novel's English aliases; AMDB never imports aliases
and has nowhere to keep them. The same gap hits creators known by a pen name or a short form
("Mark Twain", "Hitchcock").

Success: searching any English name a work or creator is commonly known by finds it, and
contributors can correct those names like any other field.

## Goals

- Works and creators carry a list of **alternate names** (works: alternate titles; creators:
  alternate names).
- Search, and the duplicate check shown while someone types a title or name, match alternate
  names as well as the main and original title.
- Contributors can add, change and remove alternate names through the normal submission and
  review flow. Every edit is a recorded revision and can be reverted (constitution III).
- The Wikidata importer brings in each item's **English aliases**. (Amended: `en` then Latin-script
  `mul` aliases; see `2026-11-11-mul-aliases-design.md`.)
- A backfill gives the works and creators already in AMDB their aliases.
- Work and creator pages show the names ("Also known as").

## Non-goals

- Names in other languages or scripts (labels and aliases in languages other than English). The
  owner deferred this.
- Alternate names for series, properties and tags.
- Typed names (pen name vs. working title vs. abbreviation), per-name language tags, or a
  preferred-name flag. A name is just a string.
- Fuzzy or typo-tolerant search. Matching follows the existing normalization.

## Anti-goals

- An import or backfill that overwrites names a person has edited (constitution IV).
- Names that carry no information: one that equals the main or original title after
  normalization, or repeats another name in the list.
- Main-title matches buried under alternate-name matches. Someone searching "1984" still sees
  the films titled *1984*; the novel is added to the results, not put ahead of them.

## Constraints

- Constitution 0.2.0 (`CLAUDE.md`) binds: writes go through `features/changes/apply.ts`; tests
  run on PGlite; field shapes live in `@amdb/shared`; applied migrations are never edited; the
  OpenAPI snapshot is regenerated, never hand-edited.
- Wikidata is CC0, so its aliases may be imported (constitution II); every stored name records its
  source through the existing per-field provenance (`field_sources`).
- Production: the backfill runs inside the `app` container like other imports, needs the owner's
  go-ahead at that moment, and never overlaps a deploy or another import.
- The database is 865 MB of a 3.5 GB cap and growing; aliases are short strings, so their size is
  small, but the builder reports the measured cost per item from a dry run.

## Decided

By the owner:

- Works and creators both, now.
- English only, from Wikidata aliases.
- Editing is required, not just display.
- No other changes to the summary below.
- **Merges union names.** When one work or creator merges into another, the winner's alternate
  names gain the loser's main title or name, its original title (works) and its alternate names,
  deduped by the rule below, so the loser's names keep finding the winner. The merge is one
  revision; its `unmerge` inverse restores the winner's previous list and that field's provenance
  exactly. The 50-name cap limits submissions, not merges: a merge keeps every name. The merge
  counts as a write to the winner's field, so imports leave it alone afterward.

By me (the owner saw these in the summary and raised no objection):

- **Shape:** one list-valued field per kind, `alternateTitles` on works and `alternateNames` on
  creators: an array of strings, each trimmed, 1–500 characters (the existing title rule), at
  most 50 per entity. An `update` replaces the whole list, like any other field, so history,
  conflicts, review and revert work unchanged. Order is kept as entered.
- **Duplicates:** a name is a duplicate when it normalizes (the existing `normalizeTitle`) to the
  main title, the original title, or an earlier name in the list. The edit form drops duplicates
  before submitting, so the contributor sees exactly what will be saved; the API rejects a
  submitted list that still has one (400) rather than changing it, so a recorded revision is
  exactly what was submitted and a revert restores it exactly. The importer and the merge drop
  duplicates themselves before writing. The check runs when the list is written only: a later
  title edit that makes an existing name a duplicate leaves the list as it is.
- **Ranking:** results that match the main or original title come before results that match
  only an alternate name; within each group, the existing order holds.
- **Imports never overwrite people:** the importer and the backfill set the field only when no
  change in the entity's history has ever touched it: not a person's edit, not a merge, not an
  earlier import. This is checked against the revision history, not the current value or
  `field_sources` (which a revert resets), so a person clearing the list, or a revert back to
  empty, is never refilled. (Amended: imports may extend a list only import runs ever set; see
  `2026-11-11-mul-aliases-design.md`.)
- **Duplicate check:** matches alternate names of listed (live) works and creators, so typing
  "1984" when entering a work warns about *Nineteen Eighty-Four*. Pending creates are matched by
  title as today; their alternate names are not matched or exposed, so what pending submissions
  reveal is unchanged (constitution I).
- **Backfill scope:** it uses the existing `--backfill` run. For each work an import run created, it
  sets `alternateTitles` if never set, and does the same for creators an import run created
  (same provenance rule as works: their create and live wikidata id came from one import-run
  submission) that those works reference. Person-entered creators are left alone. Creator aliases
  are fetched from the entity API in batches like works. This is a field update, which the current
  backfill spec forbids ("no work create or update"); that rule is relaxed for exactly these two
  fields under the never-set condition, and the importer spec is amended to say so.
- **Every view:** the names appear in entity responses in the API (and so in the OpenAPI
  document) and in the dumps (constitution V).

## Left to the builder

- Storage: a `text[]` column or a side table, and how search indexes it. The work search uses a
  generated `tsvector` and the others use `like` on `*_norm` columns; whichever fits, as long as
  search and the duplicate check stay indexed or no worse than today.
- The edit control's look in the existing entry form.
- Fetching aliases: add `aliases` to the entity API's `props` and read the `en` entries.
- Stats names for the import and backfill (for example `namesAdded`), documented in
  `docs/import.md`.
- Whether the backfill needs its own flag to run names-only.

## Review focus

- A person clears a work's names; the next backfill must not refill them.
- An alias equal to the title in a different case or punctuation ("Nineteen Eighty-four") is
  dropped.
- Reverting a names edit restores the previous list exactly.
- Merging creator "Mark Twain" into "Samuel Clemens" makes "Mark Twain" find Clemens; unmerging
  restores Clemens's previous list exactly, and a later backfill doesn't add names to either.
- A moderator reverts a person's names edit back to empty; the next backfill leaves it empty.
- Search for "1984" returns both films and the novel, films first.
