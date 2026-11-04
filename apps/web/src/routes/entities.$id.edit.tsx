import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Cc0Agreement } from '@/components/cc0-agreement';
import { EntryForm } from '@/components/entry-form';
import { NoteField } from '@/components/note-field';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api';
import { buildEdit } from '@/lib/diff';
import { useDraft } from '@/lib/drafts';
import { describeSubmitError } from '@/lib/errors';
import { entityQueryOptions, type EntityView } from '@/lib/entity';
import { formFromEntity } from '@/lib/entity-form';
import { isEntryForm, validateForm, type EntryForm as EntryFormValue, type FormErrors } from '@/lib/submission';

export const Route = createFileRoute('/entities/$id/edit')({ component: Edit });

/** The edit form for the entry the layout above loaded; the layout covers unknown, removed and unreachable. */
function Edit() {
  const { id } = Route.useParams();
  const { api } = Route.useRouteContext();
  const { data: entity } = useQuery(entityQueryOptions(api, id));
  if (!entity) return null;
  return <EditForm entity={entity} />;
}

function EditForm({ entity }: { entity: EntityView }) {
  const { api } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const initial = useMemo(() => formFromEntity(entity), [entity]);
  // The draft is the form as edited so far; a saved one for another kind of entry is not this form.
  const [form, setForm, clearDraft] = useDraft<EntryFormValue>(
    `edit.${entity.id}`,
    initial,
    (v): v is EntryFormValue => isEntryForm(v) && v.kind === entity.kind,
  );
  const [cc0, setCc0] = useState(false);
  const [checked, setChecked] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [focusError, setFocusError] = useState(0);
  const errors: FormErrors = checked ? validateForm(form) : {};
  const changes = buildEdit(entity, form);

  useEffect(() => {
    if (focusError) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusError]);

  const note = form.note.trim();
  const submit = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST('/api/submissions', { body: { cc0: true, ...(note ? { note } : {}), changes } })),
    onSuccess: async () => {
      // Only a 201 clears the draft: anything else leaves the work where it was.
      clearDraft();
      await queryClient.invalidateQueries({ queryKey: ['my-submissions'] });
      // Back to the entry, which says the edit is waiting.
      await navigate({ to: '/entities/$id', params: { id: entity.id } });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (Object.keys(validateForm(form)).length > 0) {
      setFocusError((n) => n + 1);
      return;
    }
    submit.mutate();
  }

  return (
    <div className="max-w-3xl py-8">
      <h2 className="font-serif text-2xl font-semibold">Edit this entry</h2>
      <p className="mt-3 text-muted-foreground">
        A moderator reviews every change before it appears. Only what you change is sent. Your draft is saved in this
        browser as you type.
      </p>
      <form ref={formRef} onSubmit={onSubmit} noValidate className="mt-8 grid gap-8">
        <EntryForm value={form} onChange={setForm} errors={errors} entityId={entity.id} lockKind lockMediaType />
        <NoteField id="edit-note" value={form.note} onChange={(next) => setForm({ ...form, note: next })} />
        <Cc0Agreement checked={cc0} onChange={setCc0} />
        {submit.isError && (
          <p role="alert" className="text-destructive">
            {describeSubmitError(submit.error)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <Button
            type="submit"
            disabled={!cc0 || changes.length === 0 || submit.isPending}
            aria-describedby={changes.length === 0 ? 'edit-nothing' : undefined}
          >
            {submit.isPending ? 'Submitting…' : 'Submit for review'}
          </Button>
          {changes.length === 0 && (
            <p id="edit-nothing" className="text-sm text-muted-foreground">
              Nothing has changed yet.
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
