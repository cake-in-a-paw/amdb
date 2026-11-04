import { useMutation } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { fieldClass } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { ApiError, unwrap } from '@/lib/api';
import { describeError } from '@/lib/errors';

const rootRoute = getRouteApi('__root__');

/**
 * Admin removal of a change's content (legal or abuse). The first try leaves live content alone; if
 * the change is what the entry shows now, the API says so (`content_is_current`) and the dialog asks
 * to take the content down too, which it sends as `removeEntity: true`.
 */
export function RedactDialog({
  changeId,
  label,
  onRedacted,
}: {
  changeId: string;
  /** What the trigger button says to a screen reader, to tell one change's button from another. */
  label: string;
  onRedacted: () => Promise<unknown>;
}) {
  const { api } = rootRoute.useRouteContext();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  // Set once the API says the content is live; from then on the dialog asks for the takedown.
  const [isLive, setIsLive] = useState(false);
  const redact = useMutation({
    mutationFn: async (removeEntity: boolean) =>
      unwrap(
        await api.POST('/api/admin/changes/{id}/redact', {
          params: { path: { id: changeId } },
          body: { reason: reason.trim(), ...(removeEntity ? { removeEntity: true } : {}) },
        }),
      ),
    onSuccess: async () => {
      await onRedacted();
      setOpen(false);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'content_is_current') setIsLive(true);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const empty = reason.trim() === '';
    setMissing(empty);
    if (!empty) redact.mutate(isLive);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          redact.reset();
          setIsLive(false);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" aria-label={`Redact: ${label}`}>
          Redact
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Redact this change"
        description="Erases what this change contained. Its author, time and your reason stay in the history."
      >
        <form onSubmit={submit} noValidate className="grid gap-3">
          <div className="grid gap-1">
            <label htmlFor={reasonId} className="text-sm font-medium">
              Reason
            </label>
            <textarea
              id={reasonId}
              rows={3}
              value={reason}
              maxLength={1000}
              aria-invalid={missing || undefined}
              onChange={(e) => setReason(e.target.value)}
              className={`${fieldClass} py-2`}
            />
          </div>
          {missing && (
            <p role="alert" className="text-sm text-destructive">
              Give a reason; it stays in the history.
            </p>
          )}
          {isLive && (
            <p role="alert" className="text-sm">
              This content is live on the site. Redacting it also takes the content down: the entry, or the link,
              disappears until someone submits it again.
            </p>
          )}
          {redact.isError && !(redact.error instanceof ApiError && redact.error.code === 'content_is_current') && (
            <p role="alert" className="text-sm text-destructive">
              {describeError(redact.error, "Couldn't redact this change. Try again.")}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant={isLive ? 'destructive' : 'default'} disabled={redact.isPending}>
              {isLive ? 'Redact and take down' : 'Redact'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
