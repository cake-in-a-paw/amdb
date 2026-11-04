import { ApiError } from './api';

/** "in 3 minutes" or "in 40 seconds", from a `Retry-After`. */
function waitWords(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minutes`;
}

/**
 * What to tell a person about a failed API call, in plain words. Known codes get their own
 * sentence; anything else gets the fallback, so the API's wording never leaks into the UI. A
 * `fetch` that never got an answer (a TypeError) is a network failure.
 */
export function describeError(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (error instanceof TypeError) return "Couldn't reach AMDB. Check your connection and try again.";
  if (!(error instanceof ApiError)) return fallback;
  switch (error.code) {
    case 'handle_taken':
      return 'That handle is taken.';
    case 'handle_reserved':
      return "That handle isn't available.";
    case 'invalid_request':
      return "That isn't valid. Check it and try again.";
    case 'invalid_fields':
    case 'invalid_relation':
    case 'invalid_role':
      return "Some of this isn't valid. Check it and try again.";
    case 'duplicate_slug':
      return 'A tag with that slug already exists.';
    case 'duplicate_external_id':
      return 'That ID is already recorded on another entry.';
    case 'identity_required':
      return "AMDB couldn't tell who is submitting. Sign in, or allow this site to store data, and try again.";
    case 'rate_limited':
      return error.retryAfterSeconds
        ? `Too many tries. Try again in ${waitWords(error.retryAfterSeconds)}.`
        : 'Too many tries. Wait a minute and try again.';
    case 'not_found':
      return "That doesn't exist, or you can't see it.";
    case 'removed':
      return 'This entry was removed.';
    case 'stale_change':
      return 'Something else changed this entry in the meantime, so this no longer applies. Reload and look again.';
    case 'has_dependents':
      return "Other entries or later changes build on this, so it can't be undone yet. Undo those first.";
    case 'already_reverted':
      return 'This change was already reverted.';
    case 'not_revertable':
    case 'not_live':
    case 'redacted':
      return "This change can't be reverted.";
    default:
      return fallback;
  }
}

/** "1 minute" or "60 minutes": a `Retry-After` rounded up to whole minutes. */
const minutes = (seconds: number) => {
  const n = Math.ceil(seconds / 60);
  return `${n} minute${n === 1 ? '' : 's'}`;
};

/** `describeError` for sending a submission, where a rate limit is about submissions, not tries. */
export function describeSubmitError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'rate_limited') {
    return error.retryAfterSeconds
      ? `Too many submissions — try again in ${minutes(error.retryAfterSeconds)}`
      : 'Too many submissions — try again later';
  }
  return describeError(error, "Couldn't submit. Try again.");
}

/** The entry an answer points at, when it names one (`details.existingId` on a duplicate). */
export function existingIdOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || typeof error.details !== 'object' || error.details === null) return null;
  const id: unknown = 'existingId' in error.details ? error.details.existingId : undefined;
  return typeof id === 'string' ? id : null;
}
