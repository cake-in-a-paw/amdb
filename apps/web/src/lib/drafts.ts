import { useCallback, useEffect, useRef, useState } from 'react';

/** How long typing has to pause before a draft is written. */
const WRITE_DELAY_MS = 500;

/**
 * Drafts kept for this tab only because localStorage threw (private mode, blocked storage).
 * Written only on a failed write, so a working store stays the one source.
 */
const memory = new Map<string, string>();

const storageKey = (key: string) => `amdb.draft.${key}`;

function readRaw(k: string): string | null {
  const kept = memory.get(k);
  if (kept !== undefined) return kept;
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function write(k: string, value: unknown) {
  const raw = JSON.stringify(value);
  try {
    localStorage.setItem(k, raw);
    memory.delete(k);
  } catch {
    memory.set(k, raw);
  }
}

function remove(k: string) {
  memory.delete(k);
  try {
    localStorage.removeItem(k);
  } catch {
    // Nothing was stored there; the memory copy is gone, which is what matters.
  }
}

/**
 * Moves the draft at `from` to `to` when `to` has none, so a draft that changed keys (written
 * before drafts were kept per contributor, or while signed out) is picked up rather than stranded.
 */
function adopt(from: string, to: string) {
  if (readRaw(to) !== null) return;
  const raw = readRaw(from);
  if (raw === null) return;
  try {
    localStorage.setItem(to, raw);
    memory.delete(to);
  } catch {
    memory.set(to, raw);
  }
  remove(from);
}

/** Every stored draft key named `name` or under it (`name.<anything>`). */
function keysUnder(name: string): string[] {
  const k = storageKey(name);
  const found = new Set(memory.keys());
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) found.add(key);
    }
  } catch {
    // Storage can't be read; the memory copies are all there is.
  }
  return [...found].filter((key) => key === k || key.startsWith(`${k}.`));
}

/**
 * Moves every draft kept under `from` (each contributor's, and an unscoped one) to the same place
 * under `to`, unless one is already there: for an entry merged into another, whose drafts would
 * otherwise sit under an id nobody opens again.
 */
export function moveDrafts(from: string, to: string) {
  const prefix = storageKey(from);
  for (const key of keysUnder(from)) adopt(key, storageKey(to) + key.slice(prefix.length));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The saved draft, or `initial` if there is none or it can't be read. An object draft is laid over
 * `initial`, so a draft saved before a new key existed still has it. With no draft, `initial`
 * itself comes back, so a caller can tell (by identity) that nothing was restored.
 */
function load<T>(k: string, initial: T, valid?: (value: unknown) => value is T, migrate?: (draft: T) => T): T {
  const raw = readRaw(k);
  if (raw === null) return initial;
  try {
    const parsed: unknown = JSON.parse(raw);
    const draft = isPlainObject(initial) && isPlainObject(parsed) ? { ...initial, ...parsed } : parsed;
    // Without a check, trust it: a draft is only ever written by this hook from a T.
    if (valid && !valid(draft)) return initial;
    return migrate ? migrate(draft as T) : (draft as T);
  } catch {
    return initial;
  }
}

export interface DraftOptions<T> {
  /** A saved draft that fails it (JSON `null`, a shape from another version) is ignored. */
  valid?: ((value: unknown) => value is T) | undefined;
  /** Brings a restored draft up to date with what it was based on. */
  migrate?: ((draft: T) => T) | undefined;
  /** Keys a draft may have been kept under before, taken over in order when `key` has none. */
  adoptFrom?: readonly string[] | undefined;
}

/**
 * State that survives leaving the page: kept in `localStorage['amdb.draft.<key>']`, written 500ms
 * after the last change and on unmount or `pagehide`, so nothing typed is lost. If storage throws,
 * the draft lives in memory for this tab. `clear` forgets it (call it only once the work is safe,
 * i.e. after a 201) and returns the state to `initial`. The key is read once, on mount: a caller
 * whose key can change remounts the component (a React `key`) rather than passing a new one.
 */
export function useDraft<T>(
  key: string,
  initial: T,
  { valid, migrate, adoptFrom = [] }: DraftOptions<T> = {},
): [T, (next: T) => void, () => void] {
  const k = storageKey(key);
  const [value, setValue] = useState(() => {
    for (const from of adoptFrom) adopt(storageKey(from), k);
    return load(k, initial, valid, migrate);
  });
  const initialRef = useRef(initial);
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (pending.current) write(k, pending.current.value);
    pending.current = null;
  }, [k]);

  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      pending.current = { value: next };
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, WRITE_DELAY_MS);
    },
    [flush],
  );

  const clear = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    pending.current = null;
    remove(k);
    setValue(initialRef.current);
  }, [k]);

  return [value, set, clear];
}

/**
 * The draft keys for `name` (`submit`, `edit.<id>`) for `identity`: its own, and the ones it takes
 * over when it has none. Drafts are kept per contributor so a shared browser doesn't hand one
 * person's work to the next. A draft written signed out is taken over on signing in, as the
 * anonymous submissions are claimed; one from before drafts were per contributor (`name` alone)
 * by whoever opens it first.
 */
export function draftKeys(name: string, identity: string): { key: string; adoptFrom: string[] } {
  return {
    key: `${name}.${identity}`,
    adoptFrom: identity === 'anonymous' ? [name] : [name, `${name}.anonymous`],
  };
}
