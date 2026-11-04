import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { meQueryKey, meQueryOptions } from '@/lib/me';

export const Route = createFileRoute('/account')({ component: Account });

function Account() {
  const { api } = Route.useRouteContext();
  const me = useQuery(meQueryOptions(api));

  return (
    <div className="max-w-xl py-10">
      <h1 className="font-serif text-3xl font-semibold">Account</h1>
      {me.isPending ? (
        <p role="status" className="mt-4 text-muted-foreground">
          Loading your account…
        </p>
      ) : me.isError ? (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-3">
          <p>Couldn't load your account.</p>
          <Button variant="outline" onClick={() => void me.refetch()}>
            Try again
          </Button>
        </div>
      ) : me.data === null ? (
        <div className="mt-4">
          <p>Sign in to see your account.</p>
          <Link
            to="/sign-in"
            search={{ next: '/account' }}
            className="mt-2 inline-flex min-h-11 min-w-11 items-center text-primary underline underline-offset-4"
          >
            Sign in
          </Link>
        </div>
      ) : (
        <>
          <p className="mt-4 text-muted-foreground">
            Signed in as <span className="text-foreground">{me.data.email}</span>. Only you can see your email.
          </p>
          <HandleForm current={me.data.handle} />
        </>
      )}
    </div>
  );
}

function HandleForm({ current }: { current: string | null }) {
  const { api } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const hintId = useId();
  const [handle, setHandle] = useState(current ?? '');
  const [saved, setSaved] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (next: string | null) => unwrap(await api.PATCH('/api/me', { body: { handle: next } })),
    onSuccess: (updated) => {
      queryClient.setQueryData(meQueryKey, updated);
      setHandle(updated.handle ?? '');
      setSaved(updated.handle ? 'Saved.' : 'Handle cleared. You appear as "contributor".');
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(null);
    const trimmed = handle.trim();
    save.mutate(trimmed === '' ? null : trimmed);
  };

  return (
    <form className="mt-8 flex flex-col gap-3" onSubmit={onSubmit}>
      <h2 className="font-serif text-xl font-semibold">Public handle</h2>
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId} className="text-sm font-medium">
          Handle
        </label>
        <input
          id={fieldId}
          name="handle"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={30}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          aria-invalid={save.isError ? true : undefined}
          aria-describedby={hintId}
          className="min-h-11 w-full rounded-md border border-input bg-card px-3 text-foreground aria-invalid:border-destructive"
        />
        <p id={hintId} className="text-sm text-muted-foreground">
          Shown next to your contributions: 3 to 30 letters, numbers, underscores or hyphens. Without one, you appear as
          "contributor".
        </p>
      </div>
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {describeError(save.error)}
        </p>
      )}
      {saved && !save.isPending && (
        <p role="status" className="text-sm">
          {saved}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={save.isPending}>
          Save handle
        </Button>
        {current && (
          <Button
            type="button"
            variant="outline"
            disabled={save.isPending}
            onClick={() => {
              setSaved(null);
              save.mutate(null);
            }}
          >
            Clear handle
          </Button>
        )}
      </div>
    </form>
  );
}
