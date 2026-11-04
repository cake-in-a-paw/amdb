# Plan 2 follow-ups

Minor findings from plan 2's reviews that were deferred, kept here so they outlive the build log. Each line names the task whose review found it. Plan 1's deferred items are at the end of the plan 2 document.

## Owner decisions (2026-11-04)

- Resubmits carry the CC0 agreement: the resubmit API requires `cc0: true`, and the resubmit page shows a notice by its button instead of a second checkbox.
- Public authors carry no account id: history shows `{ handle }` or `'anonymous'`, so a contributor without a handle can't be linked across edits. The moderation queue keeps `userId` so moderators can follow one contributor.

## Deferred minors

- **Task 1:** last-admin guard is check-then-act outside a transaction (constitution X); uncommented `as readonly string[]` cast on RESERVED_HANDLES (IX); import order in changes/routes.ts; no 400 test for missing/non-string handle.
- **Task 2:** related() issues extra summaries queries (~6 vs 3); 0008 backfill strips only U+0300–036F vs \p{M}.
- **Task 2:** openapi.snapshot.json reformat churn (prettier collapsing) — snapshot should be written pre-formatted; cap test doesn't show slot consumption with a duplicate.
- **Task 3:** unknown extension paths (/favicon.ico) get index.html 200; no HEAD / traversal / `/apiary` SPA tests; external-id pre-check ignores same-submission unrelate swap; tag slug update only caught at approve.
- **Task 4:** client.ts default baseUrl '' outside a browser undocumented; trivial "none sent" header test.
- **Task 5:** per-test PGlite boot cost (consider a migrated template); search form has no submit button; a11y floor test checks classes not size; signOut error path untested; contrast ratios in ADR not recomputed (final review: verify).
- **Task 6:** StrictMode/claiming guard untested; token created & sent on every anonymous request incl. reads (claim fires on every sign-in, harmless 0); failed claim swallowed silently, test doesn't reload; in-flight signed-out request after rotation; soft assertions (status branch, toBeTruthy, open-redirect only https://evil); CodeStep shows sign-in failure if onVerified throws post-sign-in; me error → anonymous view on submissions page.
- **Task 7:** harness 308 loop drops init.signal; no merged-into-merged chain test; Revert shown on changes the API refuses; empty property group renders "No other works yet."
- **Task 7:** merged-id redirect drops search params; full-date test `?? ''` fallback; search/history failed-Load-more untested.
- **Task 8:** draft key `submit` not per user (shared browser); edits typed during in-flight submit lost on 201; creator↔tag stale kind; old draft silently beats ?title=; plainWords fallback misleading for non-numeric fields; duplicate list key={i}; heading jumps; ambiguous Remove buttons; silent role reassignment on media-type change.
- **Task 9:** 400 tests fake the response via spyOn; notice misses series/property-only edits, newest 50 only; clearing an optional field on resubmitted create → generic 400; series position "3.0" vs "3" spurious unrelate+relate; changeQueryOptions pages up to 10x.
- **Task 9:** resubmit conflict notice prints raw field keys; edited row whose relation was removed meanwhile re-added as new; conflict notice covers fields, not relations.
- **Task 10:** unrelate→relate test approves via API not UI; spyOn transport fault; backdate hard-codes table names; EntryTitle "isn't published" for any error; UpdateDiff falls back to base silently; user search via useMutation, stale row role, self-demotion unmount; ageText units untested; Users link hidden-from-moderator untested; authorName duplicated, valueText imported from history-list.
- **Task 10:** unrelate "no longer on the entry" shown when entityId null; background refetch error hides cached relation; loading state and submit guard untested; describeError(err,'') arg.
- **Task 11:** Google "authorized JavaScript origin" unnecessary; ADR → accepted when live.
- **Task 11:** ADR 0005 wording "if the plan refuses" vs runbook branch B (apply refuses too); railway CLI syntax (`railway service app`, `railway redeploy --service app`, `railway link`) verify on the real run.
- **Final review:** M4 — a draft is orphaned under the loser id when the entry is merged mid-edit; M3 — native checkboxes and radios keep the browser's edge.

## Verify on the first real deploy

- Task 11: ⚠️ carried → Step 5: `railway config plan` acceptance of preserve() on absent vars and of the domain; ADR's 2026-12-01 legacy-config date.
