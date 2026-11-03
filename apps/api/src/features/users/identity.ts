import { createHash } from 'node:crypto';
import type { Actor } from '../../platform/http/app-env';

export type { Actor };

/** The anonymous token: 32–128 URL-safe characters, kept only as its SHA-256 hex. */
const ANON_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/** The hash of a well-formed anonymous token, or null for a missing or malformed one. */
export function anonHashOf(token: string | null | undefined): string | null {
  if (!token || !ANON_TOKEN.test(token)) return null;
  return createHash('sha256').update(token).digest('hex');
}

export const isModerator = (actor: Actor): boolean =>
  actor.kind === 'user' && (actor.role === 'moderator' || actor.role === 'admin');

export const isAdmin = (actor: Actor): boolean => actor.kind === 'user' && actor.role === 'admin';
