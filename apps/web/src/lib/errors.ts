import { ApiError } from './api';

/**
 * What to tell a person about a failed API call, in plain words. Known codes get their own
 * sentence; anything else gets the fallback, so the API's wording never leaks into the UI.
 */
export function describeError(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (!(error instanceof ApiError)) return fallback;
  switch (error.code) {
    case 'handle_taken':
      return 'That handle is taken.';
    case 'handle_reserved':
      return "That handle isn't available.";
    case 'invalid_request':
      return "That isn't valid. Check it and try again.";
    case 'rate_limited':
      return 'Too many tries. Wait a minute and try again.';
    default:
      return fallback;
  }
}
