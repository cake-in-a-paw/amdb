import { useId, useState, type FormEvent } from 'react';
import { fieldClass } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { fieldLabel } from '@/lib/labels';

/** A field a moderator can correct: text or a number. The API only accepts keys the change already has. */
const editable = (value: unknown): value is string | number => typeof value === 'string' || typeof value === 'number';

/**
 * Corrects fields of a create or update and approves it. Only the fields that differ are sent;
 * the contributor's original is kept by the API as what they submitted.
 */
export function EditApproveDialog({
  fields,
  onApprove,
}: {
  fields: Record<string, unknown>;
  onApprove: (edited: Record<string, unknown>) => Promise<unknown>;
}) {
  const id = useId();
  const keys = Object.keys(fields).filter((key) => editable(fields[key]));
  const initial = () => Object.fromEntries(keys.map((key) => [key, String(fields[key])]));
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  /** The fields whose text differs from what was submitted, as the API's values (numbers stay numbers). */
  const changed = () =>
    Object.fromEntries(
      keys
        .filter((key) => values[key] !== String(fields[key]) && !notANumber(key))
        .map((key) => [key, typeof fields[key] === 'number' ? Number(values[key]) : values[key]]),
    );
  /** A number field left empty or holding something that isn't a number: it can't be sent as a value. */
  const notANumber = (key: string) =>
    typeof fields[key] === 'number' && (values[key]?.trim() === '' || !Number.isFinite(Number(values[key])));
  const invalid = keys.filter(notANumber);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid.length > 0) return;
    setPending(true);
    setError(null);
    try {
      await onApprove(changed());
      setOpen(false);
    } catch (caught) {
      // These two are explained on the item itself, which the dialog covers while open.
      if (caught instanceof ApiError && ['dependency_pending', 'stale_change'].includes(caught.code)) setOpen(false);
      else setError(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setValues(initial());
          setError(null);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">Edit and approve</Button>
      </DialogTrigger>
      <DialogContent
        title="Edit and approve"
        description="Correct what was submitted, then approve. Only the fields you change are edited."
      >
        <form onSubmit={(e) => void submit(e)} className="grid gap-3">
          {keys.map((key) => (
            <div key={key} className="grid gap-1">
              <label htmlFor={`${id}-${key}`} className="text-sm font-medium">
                {fieldLabel(key)}
              </label>
              {key === 'description' ? (
                <textarea
                  id={`${id}-${key}`}
                  rows={4}
                  value={values[key] ?? ''}
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                  className={`${fieldClass} py-2`}
                />
              ) : (
                <input
                  id={`${id}-${key}`}
                  type={typeof fields[key] === 'number' ? 'number' : 'text'}
                  value={values[key] ?? ''}
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                  className={fieldClass}
                />
              )}
            </div>
          ))}
          {invalid.length > 0 && (
            <p role="alert" className="text-sm text-destructive">
              Enter a number for {invalid.map(fieldLabel).join(' and ')}.
            </p>
          )}
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {describeError(error, "Couldn't approve this change. Try again.")}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || invalid.length > 0 || Object.keys(changed()).length === 0}>
              Approve with changes
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
