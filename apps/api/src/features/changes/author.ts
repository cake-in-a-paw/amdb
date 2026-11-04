/** The public author of a change: the user's chosen handle (or none), never their email or name. */
export function publicAuthor(userId: string | null, handle: string | null) {
  return userId ? { userId, handle } : ('anonymous' as const);
}
