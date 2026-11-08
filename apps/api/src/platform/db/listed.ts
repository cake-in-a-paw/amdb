import { and, isNull } from 'drizzle-orm';
import { entities } from './schema';

/**
 * The entities the public sees in lists, relation groups, search and duplicates: not removed,
 * retracted (its create was rejected or reverted) or merged away. The one place that rule lives.
 */
export const listed = () =>
  and(isNull(entities.removedAt), isNull(entities.retractedByChange), isNull(entities.mergedIntoId));
