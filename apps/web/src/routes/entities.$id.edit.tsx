import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Cc0Agreement } from '@/components/cc0-agreement';
import { ConflictNotice } from '@/components/conflict-notice';
import { EntryForm } from '@/components/entry-form';
import { NoteField } from '@/components/note-field';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api';
import { buildEdit } from '@/lib/diff';
import { describeSubmitError } from '@/lib/errors';
import { entityQueryOptions, type EntityView } from '@/lib/entity';
import { formFromEntity } from '@/lib/entity-form';
import { useEditDraft } from '@/lib/rebase';
import { validateForm, type FormErrors } from '@/lib/submission';

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
  const current = useMemo(() => formFromEntity(entity), [entity]);
  // The draft keeps the form as it was when the contributor started beside the form as they
  // changed it, laid over the entry as it is now (on load and on every refetch), so what they
  // never touched follows the entry and only what they changed is sent.
  const { form, setForm, clear: clearDraft, conflicts } = useEditDraft(`edit.${entity.id}`, current);
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
      <ConflictNotice conflicts={conflicts} />
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
