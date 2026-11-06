import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Cc0Agreement } from '@/components/cc0-agreement';
import { LoadError, Loading } from '@/components/entity-states';
import { EntryForm } from '@/components/entry-form';
import { NoteField } from '@/components/note-field';
import { SubmissionResult } from '@/components/submission-result';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api';
import { draftKeys, useDraft } from '@/lib/drafts';
import { describeSubmitError, existingIdOf } from '@/lib/errors';
import { meQueryOptions, useIdentity } from '@/lib/me';
import { linkClass } from '@/lib/styles';
import {
  buildSubmission,
  emptyForm,
  isEntryForm,
  validateForm,
  type EntryForm as EntryFormValue,
  type FormErrors,
  type SubmissionCreated,
  type SubmissionInput,
} from '@/lib/submission';

export const Route = createFileRoute('/submit')({
  // `title` starts a new entry with that title (search's "Add it"); with a draft saved, it is offered instead.
  validateSearch: (raw: Record<string, unknown>): { title?: string } =>
    typeof raw.title === 'string' && raw.title.trim() ? { title: raw.title.trim() } : {},
  // Who is signed in decides which draft opens; read it first so the form shows at once. A failure
  // is left to the page, which says so; no retries here, so a failing API never holds the page
  // blank through the backoff.
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({ ...meQueryOptions(context.api), retry: false }).catch(() => null),
  component: Submit,
});

/** The form a draft starts from; compared by identity to tell whether a draft was restored. */
const EMPTY = emptyForm();

function Submit() {
  const { api } = Route.useRouteContext();
  const { title } = Route.useSearch();
  const navigate = Route.useNavigate();
  // The address's title is taken once, on arrival, and left out of the address after.
  const [offered] = useState(title);
  useEffect(() => {
    if (title) void navigate({ search: {}, replace: true });
  }, []);
  const { identity, error, retry } = useIdentity(api);
  if (!identity) {
    return (
      <div className="max-w-3xl py-10">
        {error ? <LoadError what="your account" error={error} onRetry={retry} /> : <Loading what="your draft" />}
      </div>
    );
  }
  // Keyed: a draft is the contributor's, so signing in or out opens theirs.
  return <SubmitForm key={identity} identity={identity} offered={offered} />;
}

function SubmitForm({ identity, offered }: { identity: string; offered: string | undefined }) {
  const { api } = Route.useRouteContext();
  const { key, adoptFrom } = draftKeys('submit', identity);
  const [form, setForm, clearDraft] = useDraft<EntryFormValue>(key, EMPTY, { valid: isEntryForm, adoptFrom });
  const [cc0, setCc0] = useState(false);
  // Errors show once a submit was tried, then follow the form as it changes.
  const [checked, setChecked] = useState(false);
  const [done, setDone] = useState<{ form: EntryFormValue; input: SubmissionInput; created: SubmissionCreated } | null>(
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [focusError, setFocusError] = useState(0);
  const errors: FormErrors = checked ? validateForm(form) : {};

  // A title from the address fills a fresh form. Over a saved draft it is offered, not forced:
  // the draft is work the contributor did, and the title is one click away.
  const restored = useRef(form !== EMPTY);
  const [offer, setOffer] = useState(
    offered && restored.current && (form.fields.title ?? form.fields.name) !== offered ? offered : null,
  );
  useEffect(() => {
    if (offered && !restored.current) setForm({ ...EMPTY, fields: { title: offered } });
    // Once, on arrival.
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
      {offer && (
        <div
          role="status"
          className="mt-4 flex flex-wrap items-center gap-x-4 rounded-md border border-border bg-card p-3"
        >
          <p>Your saved draft is open, so “{offer}” wasn’t filled in.</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setForm({ ...EMPTY, fields: { title: offer } });
              setOffer(null);
            }}
          >
            Start “{offer}” instead
          </Button>
        </div>
      )}
      <form ref={formRef} onSubmit={onSubmit} noValidate className="mt-8">
        {/* Read-only while it is sent: a 201 clears the draft, so nothing typed meanwhile may be lost. */}
        <fieldset disabled={submit.isPending} className="grid min-w-0 gap-8">
          <EntryForm value={form} onChange={setForm} errors={errors} />
          <NoteField id="submit-note" value={form.note} onChange={(note) => setForm({ ...form, note })} />
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
        </fieldset>
      </form>
    </div>
  );
}
