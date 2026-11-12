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
    case 'duplicate_ref':
      return "Some of this isn't valid. Check it and try again.";
    case 'duplicate_name':
      return 'An alternate name repeats the title or another alternate name. Remove it and try again.';
    case 'too_many_names':
      return 'There are too many alternate names in one submission. Remove some and try again.';
    case 'unknown_entity':
    case 'unknown_ref':
      return "An entry named here doesn't exist (any more). Check it and try again.";
    case 'unknown_relation':
      return 'A link you removed is already gone. Reload the form.';
    case 'invalid_cursor':
      return 'This list changed while you were reading it. Reload the page.';
    case 'conflict':
    case 'already_exists':
      return 'That already exists. Reload and look again.';
    case 'duplicate_slug':
      return 'A tag with that slug already exists.';
    case 'duplicate_external_id':
      return 'That ID is already recorded on another entry.';
    case 'invalid_tree':
      return "That can't be a part of that entry. A season goes under a show, and an episode under a season or a show.";
    case 'has_parent':
      return 'That entry is already a part of another entry. Remove it from there first.';
    case 'conflicting_parents':
      return 'Those entries are parts of different entries. Merge those first, or remove one from its entry.';
    case 'entity_unavailable':
      return 'An entry this needs was removed or merged into another, so this no longer applies.';
    case 'identity_required':
    case 'anon_token_required':
      return "AMDB couldn't tell who is submitting. Sign in, or allow this site to store data, and try again.";
    case 'rate_limited':
      return error.retryAfterSeconds
        ? `Too many tries. Try again in ${waitWords(error.retryAfterSeconds)}.`
        : 'Too many tries. Wait a minute and try again.';
    case 'unauthenticated':
      return 'Your session ended. Sign in again.';
    case 'forbidden':
      return "You can't do that.";
    case 'not_found':
      return "That doesn't exist, or you can't see it.";
    case 'removed':
      return 'This entry was removed.';
    case 'stale_change':
      return 'Something else changed this entry in the meantime, so this no longer applies. Reload and look again.';
    case 'already_reviewed':
      return 'Someone already reviewed this change.';
    case 'dependency_pending':
      return 'Approve the change this one depends on first.';
    case 'already_redacted':
      return 'Someone already removed this change.';
    case 'not_redactable':
      return 'A revert holds no content of its own. Remove the change it reverted instead.';
    case 'content_is_current':
      return 'This change is what the entry shows now, so removing it takes the content down too.';
    case 'not_rejected':
      return 'Only a rejected change can be resubmitted.';
    case 'already_resubmitted':
      return 'You already resubmitted this change.';
    case 'has_dependents':
      return "Other entries or later changes build on this, so it can't be undone yet. Undo those first.";
    case 'last_admin':
      return "You're the last admin. Make someone else an admin first.";
    case 'edit_out_of_scope':
      return 'An edit can only change fields the contributor submitted.';
    case 'already_published':
      return 'This change is already live. Submit a new change to correct it.';
    case 'already_reverted':
      return 'This change was already reverted.';
    case 'not_revertable':
    case 'not_live':
    case 'redacted':
      return "This change can't be reverted.";
    case 'internal':
      return 'Something went wrong at AMDB. Try again in a moment.';
    default:
      return fallback;
  }
}

/**
 * The cause of a failure when it is known, else nothing: for after a sentence that already says
 * what failed ("Couldn't load …"), where a generic "Something went wrong" would only repeat it.
 */
export const errorCause = (error: unknown): string => describeError(error, '');

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

/** Whether `error` is the API's answer with `code`. */
export const isApiCode = (error: unknown, code: string): boolean => error instanceof ApiError && error.code === code;

/** `describeError` for resubmitting a rejected change, where the state of the change is the usual trouble. */
export function describeResubmitError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'redacted')
    return 'This change was removed, so it can’t be resubmitted.';
  return describeError(error, "Couldn't resubmit. Try again.");
}

/**
 * The field a `duplicate_name` or `too_many_names` answer names (`details.field`), keyed to that
 * input with the usual wording, so the error shows by the field even when the form's own check
 * passed (another change landed first). Empty for any other answer.
 */
export function serverFieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || (error.code !== 'duplicate_name' && error.code !== 'too_many_names')) return {};
  const field: unknown =
    typeof error.details === 'object' && error.details !== null && 'field' in error.details
      ? error.details.field
      : undefined;
  return typeof field === 'string' ? { [field]: describeError(error) } : {};
}
