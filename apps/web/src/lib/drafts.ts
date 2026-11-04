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

/**
 * State that survives leaving the page: kept in `localStorage['amdb.draft.<key>']`, written 500ms
 * after the last change and on unmount or `pagehide`, so nothing typed is lost. If storage throws,
 * the draft lives in memory for this tab. `clear` forgets it (call it only once the work is safe,
 * i.e. after a 201) and returns the state to `initial`. With `valid`, a saved draft that fails it
 * (JSON `null`, a shape from another version) is ignored and `initial` is used. A draft that is
 * restored goes through `migrate` first (for bringing it up to date with what it was based on).
 */
export function useDraft<T>(
  key: string,
  initial: T,
  valid?: (value: unknown) => value is T,
  migrate?: (draft: T) => T,
): [T, (next: T) => void, () => void] {
  const k = storageKey(key);
  const [value, setValue] = useState(() => load(k, initial, valid, migrate));
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
