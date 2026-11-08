/**
 * A waiting limiter for calls to an outside service: at most `limit` calls start in any
 * `intervalMs`. A caller is given the next free slot and waits for it, unless that slot comes at
 * or after its deadline, in which case it is refused at once. `blockUntil` refuses every call
 * until a time (an upstream's `Retry-After`). State lives in this process: see "Production
 * Annotations" in docs/superpowers/specs/2026-11-02-amdb-design.md.
 */
export function createOutboundLimit({
  limit,
  intervalMs,
  now = Date.now,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  limit: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  /** Start times of the last `limit` granted slots, oldest first; some may lie in the future. */
  const slots: number[] = [];
  let blockedUntil = -Infinity;

  return {
    /** Waits for a slot; false when none comes before `deadline` or the limiter is blocked. */
    async acquire(deadline: number): Promise<boolean> {
      const t = now();
      if (t < blockedUntil) return false;
      // The slot `limit` grants back frees up one interval after it started.
      const oldest = slots.length >= limit ? slots[slots.length - limit] : undefined;
      const slot = oldest === undefined ? t : Math.max(t, oldest + intervalMs);
      if (slot >= deadline) return false;
      // Reserved before waiting, so callers in parallel each take the next slot.
      slots.push(slot);
      if (slots.length > limit) slots.shift();
      if (slot > t) {
        await sleep(slot - t);
        if (now() < blockedUntil) return false;
      }
      return true;
    },
    blockUntil(t: number) {
      blockedUntil = Math.max(blockedUntil, t);
    },
  };
}

export type OutboundLimit = ReturnType<typeof createOutboundLimit>;

/**
 * A `Retry-After` header as milliseconds from `now`: delta-seconds or an HTTP date, never
 * negative. Undefined when absent or unparsable.
 */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  const raw = header?.trim();
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
