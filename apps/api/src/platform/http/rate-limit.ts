import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { AppEnv } from './app-env';
import { ApiError } from './errors';

/**
 * An in-memory fixed-window limiter. `key` names the bucket for a request, or returns null to
 * leave the request alone. State lives in this process (see Production Annotations in the
 * contribution-engine spec).
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
