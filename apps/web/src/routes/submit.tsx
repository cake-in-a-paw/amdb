import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Cc0Agreement } from '@/components/cc0-agreement';
import { EntryForm } from '@/components/entry-form';
import { fieldClass } from '@/components/form-fields';
import { SubmissionResult } from '@/components/submission-result';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api';
import { useDraft } from '@/lib/drafts';
import { describeSubmitError, existingIdOf } from '@/lib/errors';
import { linkClass } from '@/lib/styles';
import {
  buildSubmission,
  emptyForm,
  validateForm,
  type EntryForm as EntryFormValue,
  type FormErrors,
  type SubmissionCreated,
  type SubmissionInput,
} from '@/lib/submission';

export const Route = createFileRoute('/submit')({
  // `title` starts a new entry with that title (search's "Add it"); it never replaces a draft.
  validateSearch: (raw: Record<string, unknown>): { title?: string } =>
    typeof raw.title === 'string' && raw.title.trim() ? { title: raw.title.trim() } : {},
  component: Submit,
});

/** The form a draft starts from; compared by identity to tell whether a draft was restored. */
const EMPTY = emptyForm();

function Submit() {
  const { api } = Route.useRouteContext();
  const { title } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [form, setForm, clearDraft] = useDraft<EntryFormValue>('submit', EMPTY);
  const [cc0, setCc0] = useState(false);
  // Errors show once a submit was tried, then follow the form as it changes.
  const [checked, setChecked] = useState(false);
  const [done, setDone] = useState<{ form: EntryFormValue; input: SubmissionInput; created: SubmissionCreated } | null>(
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [focusError, setFocusError] = useState(0);
  const errors: FormErrors = checked ? validateForm(form) : {};

  // A prefilled title applies only to a fresh form, and leaves the address so it applies once.
  const restored = useRef(form !== EMPTY);
  useEffect(() => {
    if (!title) return;
    if (!restored.current) setForm({ ...EMPTY, fields: { title } });
    void navigate({ search: {}, replace: true });
    // Once, on arrival: later title changes come from this effect itself.
  }, []);

  useEffect(() => {
    if (focusError) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusError]);

  const submit = useMutation({
    mutationFn: async ({ input }: { form: EntryFormValue; input: SubmissionInput }) =>
      unwrap(await api.POST('/api/submissions', { body: input })),
    onSuccess: (created, sent) => {
      setDone({ ...sent, created });
      // Only a 201 clears the draft: anything else leaves the work where it was.
      clearDraft();
      setCc0(false);
      setChecked(false);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (Object.keys(validateForm(form)).length > 0) {
      setFocusError((n) => n + 1);
      return;
    }
    submit.mutate({ form, input: buildSubmission(form) });
  }

  if (done) {
    return (
      <SubmissionResult
        {...done}
        onAnother={() => {
          setDone(null);
          submit.reset();
        }}
      />
    );
  }

  const existingId = submit.isError ? existingIdOf(submit.error) : null;
  return (
    <div className="max-w-3xl py-10">
      <h1 className="font-serif text-3xl font-semibold">Contribute an entry</h1>
      <p className="mt-3 text-muted-foreground">
        A moderator reviews every change before it appears. Your draft is saved in this browser as you type.
      </p>
      <form ref={formRef} onSubmit={onSubmit} noValidate className="mt-8 grid gap-8">
        <EntryForm value={form} onChange={setForm} errors={errors} />
        <div className="grid gap-1">
          <label htmlFor="submit-note" className="text-sm font-medium">
            Note for the moderator <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <textarea
            id="submit-note"
            rows={2}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
            className={`${fieldClass} py-2`}
          />
        </div>
        <Cc0Agreement checked={cc0} onChange={setCc0} />
        {submit.isError && (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 text-destructive">
            <p>{describeSubmitError(submit.error)}</p>
            {existingId && (
              <Link to="/entities/$id" params={{ id: existingId }} className={linkClass}>
                See that entry
              </Link>
            )}
          </div>
        )}
        <div>
          <Button type="submit" disabled={!cc0 || submit.isPending}>
            {submit.isPending ? 'Submitting…' : 'Submit for review'}
          </Button>
        </div>
      </form>
    </div>
  );
}
