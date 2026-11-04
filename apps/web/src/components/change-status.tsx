import type { paths } from '@amdb/shared/api';

type Page = paths['/api/me/submissions']['get']['responses'][200]['content']['application/json'];
export type Status = Page['items'][number]['changes'][number]['status'];

const words: Record<Status, string> = {
  pending: 'Waiting for review',
  published: 'Published',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** A change's status in words, with the moderator's reason when it was rejected. */
export function ChangeStatus({ status, reason }: { status: Status; reason?: string | null }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span className={status === 'rejected' ? 'font-medium text-destructive' : 'font-medium'}>{words[status]}</span>
      {status === 'rejected' && reason && <span className="text-muted-foreground">Reason: {reason}</span>}
    </span>
  );
}
