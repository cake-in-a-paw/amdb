import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { AppEnv } from './app-env';
import { ApiError } from './errors';

/**
 * The client's address from `x-forwarded-for`, trusting only the last `trustedHops` entries:
 * each trusted proxy appends the address it saw, so the entry `trustedHops` from the right is the
 * one the outermost trusted proxy recorded, and everything left of it is whatever the client sent.
 * Null when the header is missing or has fewer entries than that (nothing trustworthy to key on).
 */
export function clientIp(c: Context<AppEnv>, trustedHops: number): string | null {
  const entries = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  return entries.length >= trustedHops ? (entries[entries.length - trustedHops] ?? null) : null;
}

/**
 * An in-memory fixed-window limiter. `key` names the bucket for a request, or returns null to
 * leave the request alone. State lives in this process: see "Production Annotations" in
 * docs/superpowers/specs/2026-11-02-amdb-design.md.
 */
export function rateLimit({
  key,
  limit,
  windowMs,
  now = Date.now,
}: {
  key: (c: Context<AppEnv>) => string | null;
  limit: number;
  windowMs: number;
  now?: () => number;
}) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return createMiddleware<AppEnv>(async (c, next) => {
    const bucket = key(c);
    if (bucket === null) return next();
    const t = now();
    // Expired windows are dropped lazily, once there are enough of them to matter.
    if (windows.size > 1000) for (const [k, old] of windows) if (old.resetAt <= t) windows.delete(k);
    const current = windows.get(bucket);
    const w = current && current.resetAt > t ? current : { count: 0, resetAt: t + windowMs };
    w.count += 1;
    windows.set(bucket, w);
    if (w.count > limit) {
      c.header('Retry-After', String(Math.ceil((w.resetAt - t) / 1000)));
      throw new ApiError(429, 'rate_limited', 'Too many requests. Try again later.');
    }
    return next();
  });
}
