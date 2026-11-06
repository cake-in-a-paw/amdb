import { useEffect, useMemo, useRef, useState } from 'react';
import { same } from '@/lib/diff';
import { useDraft } from '@/lib/drafts';
import { isEntryForm, type EntryForm } from '@/lib/submission';

/**
 * An edit in progress: the form as the contributor started it (`base`, built from the entry at
 * that time) and the form as they have changed it. What they edited is the difference between
 * the two, so a draft stays correct after the entry itself changes.
 */
export interface EditDraft {
  base: EntryForm;
  form: EntryForm;
}

/** Rows of one relation list after rebasing: the current rows, with the contributor's edits laid over. */
function rebaseRows<T extends { relationId?: string | undefined }>(base: T[], draft: T[], current: T[]): T[] {
  const mine = new Map(draft.flatMap((row) => (row.relationId ? [[row.relationId, row] as const] : [])));
  const live = new Set(current.flatMap((row) => (row.relationId ? [row.relationId] : [])));
  const kept = current.flatMap((row): T[] => {
    const id = row.relationId;
    const was = base.find((b) => b.relationId === id);
    // Not in the contributor's form: they removed it, if it was there when they started; if it
    // only appeared since, they never saw it and it stays.
    if (!id || !mine.has(id)) return was ? [] : [row];
    const edited = mine.get(id);
    return [edited && was && !same(was, edited) ? edited : row];
  });
  // Their additions, and edited rows whose relation has since gone (kept as new rows, not dropped).
  const added = draft
    .filter((row) => !row.relationId)
    .concat(
      draft
        .filter((row) => row.relationId && !live.has(row.relationId))
        .filter(
          (row) =>
            !same(
              base.find((b) => b.relationId === row.relationId),
              row,
            ),
        )
        .map((row) => ({ ...row, relationId: undefined })),
    );
  return [...kept, ...added];
}

/**
 * The contributor's edits (`draft` against `base`) laid over the entry as it is now (`current`):
 * a field they didn't touch takes the current value, one they edited keeps theirs; a relation they
 * removed stays removed (and is simply gone if it was already); one added since stays. `conflicts`
 * names the fields both sides changed to different values, where theirs is kept.
 */
export function rebase(
  base: EntryForm,
  draft: EntryForm,
  current: EntryForm,
): { form: EntryForm; conflicts: string[] } {
  const fields: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const key of new Set([
    ...Object.keys(base.fields),
    ...Object.keys(draft.fields),
    ...Object.keys(current.fields),
  ])) {
    const was = base.fields[key] ?? '';
    const mine = draft.fields[key] ?? '';
    const now = current.fields[key] ?? '';
    const value = mine === was ? now : mine;
    if (mine !== was && now !== was && now !== mine) conflicts.push(key);
    if (value !== '') fields[key] = value;
  }
  const form: EntryForm = {
    ...current,
    fields,
    note: draft.note,
    credits: rebaseRows(base.credits, draft.credits, current.credits),
    series: rebaseRows(base.series, draft.series, current.series),
    properties: rebaseRows(base.properties, draft.properties, current.properties),
    tags: rebaseRows(base.tags, draft.tags, current.tags),
    links: rebaseRows(base.links, draft.links, current.links),
    externalIds: rebaseRows(base.externalIds, draft.externalIds, current.externalIds),
  };
  return { form, conflicts };
}

/** Whether `v` is an edit draft this version can read: both forms parse, and are of `kind`. */
export function isEditDraft(v: unknown, kind: EntryForm['kind']): v is EditDraft {
  return (
    typeof v === 'object' &&
    v !== null &&
    'base' in v &&
    'form' in v &&
    isEntryForm(v.base) &&
    isEntryForm(v.form) &&
    v.base.kind === kind &&
    v.form.kind === kind
  );
}

/**
 * An edit form kept as a draft under `key`, always laid over `current` (the form built from the
 * entry, or the change, as it is now). A restored draft is rebased when it loads, and the form is
 * rebased again whenever `current` changes while it is open (a refetch on returning to the tab, an
 * invalidation), so what is sent is only ever the contributor's own edits: never a revert of a
 * field someone else changed meanwhile, nor an unrelate of a relation someone else added.
 * `conflicts` names the fields both sides changed, from the load on. `adoptFrom` is as for `useDraft`.
 */
export function useEditDraft(
  key: string,
  current: EntryForm,
  adoptFrom?: readonly string[],
): { form: EntryForm; setForm: (next: EntryForm) => void; clear: () => void; conflicts: string[] } {
  const loaded = useRef<string[]>([]);
  const [draft, setDraft, clear] = useDraft<EditDraft>(
    key,
    { base: current, form: current },
    {
      valid: (v): v is EditDraft => isEditDraft(v, current.kind),
      migrate: (saved) => {
        const rebased = rebase(saved.base, saved.form, current);
        loaded.current = rebased.conflicts;
        return { base: current, form: rebased.form };
      },
      adoptFrom,
    },
  );
  const [conflicts, setConflicts] = useState(() => loaded.current);
  // Rebased during render, so even the render before the effect below never builds a request
  // from a form that was based on an older entry.
  const rebased = useMemo(
    () => (same(draft.base, current) ? null : rebase(draft.base, draft.form, current)),
    [draft, current],
  );
  // Set by `clear` (after a 201): the reset draft is based on the entry as first loaded, and
  // rebasing it must not write it back to storage. Typing again unsets it.
  const cleared = useRef(false);
  useEffect(() => {
    if (!rebased || cleared.current) return;
    setDraft({ base: current, form: rebased.form });
    if (rebased.conflicts.length > 0) setConflicts((was) => [...new Set([...was, ...rebased.conflicts])]);
  }, [rebased, current, setDraft]);

  return {
    form: rebased ? rebased.form : draft.form,
    // The form shown is always based on `current`, so an edit to it is too.
    setForm: (next) => {
      cleared.current = false;
      setDraft({ base: current, form: next });
    },
    clear: () => {
      cleared.current = true;
      clear();
    },
    conflicts,
  };
}
