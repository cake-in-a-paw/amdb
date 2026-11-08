import { describe, expect, it } from 'vitest';
import { createOutboundLimit, retryAfterMs } from '../src/platform/http/outbound-limit';

/** A clock that only moves when something sleeps; a sleep ends at its own start plus `ms`. */
function fakeClock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      const end = t + ms;
      await Promise.resolve();
      t = Math.max(t, end);
    },
    sleeps,
  };
}

describe('createOutboundLimit', () => {
  it('grants up to the limit at once, then waits for room', async () => {
    const clock = fakeClock();
    const limit = createOutboundLimit({ limit: 2, intervalMs: 1000, now: clock.now, sleep: clock.sleep });
    expect(await limit.acquire(5000)).toBe(true);
    expect(await limit.acquire(5000)).toBe(true);
    expect(clock.sleeps).toEqual([]);
    expect(await limit.acquire(5000)).toBe(true);
    expect(clock.sleeps).toEqual([1000]);
    expect(clock.now()).toBe(1000);
  });

  it('gives up without waiting when room would come only at or after the deadline', async () => {
    const clock = fakeClock();
    const limit = createOutboundLimit({ limit: 1, intervalMs: 1000, now: clock.now, sleep: clock.sleep });
    expect(await limit.acquire(1000)).toBe(true);
    expect(await limit.acquire(1000)).toBe(false);
    expect(clock.sleeps).toEqual([]);
    expect(clock.now()).toBe(0);
  });

  it('waiters in parallel each get the next free slot, and the ones past the deadline give up at once', async () => {
    const clock = fakeClock();
    const limit = createOutboundLimit({ limit: 2, intervalMs: 1000, now: clock.now, sleep: clock.sleep });
    const results = await Promise.all(Array.from({ length: 7 }, () => limit.acquire(2500)));
    // Two at 0, two at 1000, two at 2000; the seventh's slot (3000) is past the deadline.
    expect(results).toEqual([true, true, true, true, true, true, false]);
    expect(clock.sleeps.toSorted((a, b) => a - b)).toEqual([1000, 1000, 2000, 2000]);
  });

  it('refuses everything while blocked, then grants again', async () => {
    const clock = fakeClock();
    const limit = createOutboundLimit({ limit: 5, intervalMs: 1000, now: clock.now, sleep: clock.sleep });
    limit.blockUntil(30_000);
    expect(await limit.acquire(100_000)).toBe(false);
    expect(clock.sleeps).toEqual([]);
    await clock.sleep(30_000);
    expect(await limit.acquire(100_000)).toBe(true);
  });

  it('a waiter whose slot comes up during a block gives up', async () => {
    const clock = fakeClock();
    const limit = createOutboundLimit({ limit: 1, intervalMs: 1000, now: clock.now, sleep: clock.sleep });
    expect(await limit.acquire(100_000)).toBe(true);
    const waiting = limit.acquire(100_000);
    limit.blockUntil(5000);
    expect(await waiting).toBe(false);
  });

  it('a shorter block never shortens a longer one', async () => {
    const clock = fakeClock();
    const limit = createOutboundLimit({ limit: 5, intervalMs: 1000, now: clock.now, sleep: clock.sleep });
    limit.blockUntil(30_000);
    limit.blockUntil(10_000);
    await clock.sleep(20_000);
    expect(await limit.acquire(100_000)).toBe(false);
  });
});

describe('retryAfterMs', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  it('reads delta-seconds and HTTP dates', () => {
    expect(retryAfterMs('30', now)).toBe(30_000);
    expect(retryAfterMs('Sun, 08 Nov 2026 12:01:00 GMT', now)).toBe(60_000);
  });
  it('is undefined when absent or unparsable, and never negative', () => {
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs('', now)).toBeUndefined();
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs('Sun, 08 Nov 2026 11:00:00 GMT', now)).toBe(0);
  });
});
