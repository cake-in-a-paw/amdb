import type { Actor } from '../../platform/http/app-env';
import type { ChangeInput } from './schemas';

/**
 * Whether a new change waits for a moderator (`hold`) or goes live now and is reviewed after
 * (`publish`). This is the one place that rule lives (spec §6.1); the service only reacts to it.
 */
export type ReviewDecision = 'hold' | 'publish';
export interface ReviewContext {
  change: ChangeInput;
  actor: Actor;
}
export type ReviewPolicy = (ctx: ReviewContext) => ReviewDecision | Promise<ReviewDecision>;

/** v1: every human change waits for a moderator. */
export const holdAll: ReviewPolicy = () => 'hold';
