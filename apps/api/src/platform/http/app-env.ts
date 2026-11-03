import type { Role } from '@amdb/shared';

/** The signed-in caller's session: who and when it was created. */
export interface SessionInfo {
  userId: string;
  createdAt: Date;
}

/** Who is making a request: an account, an anonymous visitor (by token hash), or no one. */
export type Actor =
  { kind: 'user'; userId: string; role: Role } | { kind: 'anon'; anonHash: string } | { kind: 'none' };

export interface AppEnv {
  Variables: { actor: Actor };
}
