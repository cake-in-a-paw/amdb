import { useMutation } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { fieldClass } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { unwrap } from '@/lib/api';
import { describeError } from '@/lib/errors';

const rootRoute = getRouteApi('__root__');

/** Rejecting asks for a reason, which goes back to the contributor with their work. */
export function RejectDialog({ changeId, onRejected }: { changeId: string; onRejected: () => Promise<unknown> }) {
  const { api } = rootRoute.useRouteContext();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const reject = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/changes/{id}/reject', {
          params: { path: { id: changeId } },
          body: { reason: reason.trim() },
        }),
      ),
    onSuccess: async () => {
      await onRejected();
      setOpen(false);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const empty = reason.trim() === '';
    setMissing(empty);
    if (!empty) reject.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Reject</Button>
      </DialogTrigger>
      <DialogContent
        title="Reject this change"
        description="The contributor keeps their work and sees your reason, so they can fix it and resubmit."
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
              Give a reason, so the contributor knows what to fix.
            </p>
          )}
          {reject.isError && (
            <p role="alert" className="text-sm text-destructive">
              {describeError(reject.error, "Couldn't reject this change. Try again.")}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={reject.isPending}>
              Reject
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
