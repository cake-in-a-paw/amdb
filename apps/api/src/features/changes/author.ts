/**
 * The public author of a change: the user's chosen handle (or none), never their email, name or id,
 * so a contributor without a handle can't have their changes linked together.
 */
export function publicAuthor(userId: string | null, handle: string | null) {
  return userId ? { handle } : ('anonymous' as const);
}

/** The author as moderators see it: the account id too, so they can follow one contributor's changes. */
export function reviewAuthor(userId: string | null, handle: string | null) {
  return userId ? { userId, handle } : ('anonymous' as const);
}
