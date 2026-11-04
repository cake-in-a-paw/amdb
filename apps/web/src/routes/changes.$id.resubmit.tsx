import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChangeStatus } from '@/components/change-status';
import { EntryForm } from '@/components/entry-form';
import { LoadError, Loading } from '@/components/entity-states';
import { Button } from '@/components/ui/button';
import { ApiError, unwrap } from '@/lib/api';
import { diffFields } from '@/lib/diff';
import { useDraft } from '@/lib/drafts';
import { entityQueryOptions } from '@/lib/entity';
import { describeResubmitError } from '@/lib/errors';
import { isEditDraft, rebase, type EditDraft } from '@/lib/rebase';
import { changeQueryOptions, type ChangeDetail } from '@/lib/rejected-change';
import { linkClass } from '@/lib/styles';
import {
  emptyForm,
  toFields,
  toInputs,
  validateForm,
  type EntryForm as EntryFormValue,
  type FormErrors,
} from '@/lib/submission';

export const Route = createFileRoute('/changes/$id/resubmit')({ component: Resubmit });

function Resubmit() {
  const { id } = Route.useParams();
  const { api } = Route.useRouteContext();
  const change = useQuery(changeQueryOptions(api, id));

  let body;
  if (change.isPending) body = <Loading what="this change" />;
  else if (change.isError) {
    body =
      change.error instanceof ApiError && change.error.status === 404 ? (
        <p className="py-6">
          There's no change like this among your submissions.{' '}
          <Link to="/me/submissions" className={linkClass}>
            My submissions
          </Link>
        </p>
      ) : (
        <LoadError what="this change" error={change.error} onRetry={() => void change.refetch()} />
      );
  } else if (change.data.status !== 'rejected' || change.data.redacted || !change.data.payload) {
    body = (
      <p className="py-6">
        {change.data.redacted
          ? 'This change was removed, so it can’t be resubmitted.'
          : 'Only a rejected change can be resubmitted.'}{' '}
        <Link to="/me/submissions" className={linkClass}>
          My submissions
        </Link>
      </p>
    );
  } else body = <Fix change={change.data} payload={change.data.payload} />;

  return (
    <div className="max-w-3xl py-10">
      <h1 className="font-serif text-3xl font-semibold">Fix and resubmit</h1>
      {body}
    </div>
  );
}

/** A rejected change: its reason, and what to fix. Only a create's or update's fields can be edited. */
function Fix({ change, payload }: { change: ChangeDetail; payload: Record<string, unknown> }) {
  const editable = change.op === 'create' || change.op === 'update';
  return (
    <>
      <p className="mt-3">
        <ChangeStatus status={change.status} reason={change.reason} />
      </p>
      {editable ? (
        change.op === 'update' && change.entityId ? (
          <UpdateFix change={change} entityId={change.entityId} payload={payload} />
        ) : (
          <FieldsFix change={change} base={payload} />
        )
      ) : (
        <FieldsFix change={change} base={null} />
      )}
    </>
  );
}

/** An update's form starts from the entry as it is now, with the rejected fields laid over it. */
function UpdateFix({
  change,
  entityId,
  payload,
}: {
  change: ChangeDetail;
  entityId: string;
  payload: Record<string, unknown>;
}) {
  const { api } = Route.useRouteContext();
  const entity = useQuery(entityQueryOptions(api, entityId));
  if (entity.isPending) return <Loading what="the entry" />;
  if (entity.isError) return <LoadError what="the entry" error={entity.error} onRetry={() => void entity.refetch()} />;
  return <FieldsFix change={change} base={{ ...entity.data.fields, ...payload }} />;
}

/**
 * Resubmits `change`. With `base` (the fields the change would set), a form to fix them; the
 * request carries only what differs from `base`. Without, for a change that has no fields to fix
 * (a link, a removal), a button to send it again as it was.
 */
function FieldsFix({ change, base }: { change: ChangeDetail; base: Record<string, unknown> | null }) {
  const { api } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const kind = change.kind;
  const initial: EntryFormValue = { ...emptyForm(), kind, fields: toInputs(kind, base ?? {}) };
  // As when editing an entry: the draft keeps the form it started from beside the edited one, and
  // on load the edits are laid over what the change would set now.
  const conflicts = useRef<string[]>([]);
  const [draft, setDraft, clearDraft] = useDraft<EditDraft>(
    `resubmit.${change.id}`,
    { base: initial, form: initial },
    (v): v is EditDraft => isEditDraft(v, kind),
    (saved) => {
      const rebased = rebase(saved.base, saved.form, initial);
      conflicts.current = rebased.conflicts;
      return { base: initial, form: rebased.form };
    },
  );
  const form = draft.form;
  const setForm = (next: EntryFormValue) => setDraft({ base: draft.base, form: next });
  const [checked, setChecked] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [focusError, setFocusError] = useState(0);
  const errors: FormErrors = base && checked ? validateForm(form) : {};

  useEffect(() => {
    if (focusError) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusError]);

  const send = useMutation({
    mutationFn: async () => {
      const fields = base ? diffFields(toFields(kind, initial.fields), toFields(kind, form.fields)) : {};
      return unwrap(
        await api.POST('/api/changes/{id}/resubmit', {
          params: { path: { id: change.id } },
          body: Object.keys(fields).length > 0 ? { fields } : {},
        }),
      );
    },
    onSuccess: async () => {
      clearDraft();
      await queryClient.invalidateQueries({ queryKey: ['my-submissions'] });
      await queryClient.invalidateQueries({ queryKey: ['submission'] });
      // The change is no longer rejected-and-open: coming back must not offer a second resubmit.
      await queryClient.invalidateQueries({ queryKey: ['change'] });
      await navigate({ to: '/me/submissions' });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (base && Object.keys(validateForm(form)).length > 0) {
      setFocusError((n) => n + 1);
      return;
    }
    send.mutate();
  }

  return (
    <>
      {conflicts.current.length > 0 && (
        <p role="status" className="mt-4 rounded-md border border-border bg-card p-3">
          This entry changed since you started editing. Your values are kept; check {conflicts.current.join(', ')}.
        </p>
      )}
      <form ref={formRef} onSubmit={onSubmit} noValidate className="mt-8 grid gap-8">
        {base ? (
          <EntryForm
            value={form}
            onChange={setForm}
            errors={errors}
            entityId={change.entityId ?? undefined}
            lockKind
            lockMediaType={change.op === 'update'}
            relations={false}
          />
        ) : (
          <p>This change has no fields to edit here. You can send it to the moderators again as it was.</p>
        )}
        {send.isError && (
          <p role="alert" className="text-destructive">
            {describeResubmitError(send.error)}
          </p>
        )}
        <div>
          <Button type="submit" disabled={send.isPending}>
            {send.isPending ? 'Resubmitting…' : 'Resubmit for review'}
          </Button>
        </div>
      </form>
    </>
  );
}
