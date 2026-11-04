import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { Role } from '@amdb/shared';
import type { paths } from '@amdb/shared/api';
import { fieldClass } from '@/components/form-fields';
import { LoadError, Loading, NotFound } from '@/components/entity-states';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { meQueryOptions } from '@/lib/me';

export const Route = createFileRoute('/admin/users')({ component: AdminUsers });

type Account = paths['/api/admin/users']['get']['responses'][200]['content']['application/json']['items'][number];

function AdminUsers() {
  const { api } = Route.useRouteContext();
  const me = useQuery(meQueryOptions(api));
  const emailId = useId();
  const [email, setEmail] = useState('');
  // The API takes an exact email, so there is nothing to list until one is asked for.
  const find = useMutation({
    mutationFn: async (address: string) =>
      unwrap(await api.GET('/api/admin/users', { params: { query: { email: address } } })),
  });

  if (me.isPending) return <Loading what="your account" />;
  if (me.isError) return <LoadError what="your account" error={me.error} onRetry={() => void me.refetch()} />;
  // Only admins may ask; to everyone else this page doesn't exist.
  if (me.data?.role !== 'admin') return <NotFound what="page" />;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (email.trim()) find.mutate(email.trim());
  }

  return (
    <div className="max-w-3xl py-10">
      <h1 className="font-serif text-3xl font-semibold">Users</h1>
      <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-2">
        <div className="grid flex-1 gap-1">
          <label htmlFor={emailId} className="text-sm font-medium">
            Email
          </label>
          <input
            id={emailId}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={fieldClass}
          />
        </div>
        <Button type="submit" disabled={find.isPending}>
          Find
        </Button>
      </form>
      {find.isError && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {describeError(find.error, "Couldn't look that up. Try again.")}
        </p>
      )}
      {find.data &&
        (find.data.items.length === 0 ? (
          <p className="mt-4 text-muted-foreground">No account has that email.</p>
        ) : (
          <ul aria-label="Accounts" className="mt-4">
            {find.data.items.map((account) => (
              <UserRow key={account.id} account={account} />
            ))}
          </ul>
        ))}
    </div>
  );
}

function UserRow({ account }: { account: Account }) {
  const { api, queryClient } = Route.useRouteContext();
  const roleId = useId();
  const [role, setRole] = useState<Role>(account.role);
  const save = useMutation({
    mutationFn: async (next: Role) =>
      unwrap(
        await api.POST('/api/admin/users/{id}/role', { params: { path: { id: account.id } }, body: { role: next } }),
      ),
    // A role changed here may be the signed-in admin's own.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meQueryOptions(api).queryKey }),
  });

  return (
    <li
      aria-label={account.handle ? `${account.email} (${account.handle})` : account.email}
      className="border-b border-border py-4"
    >
      <p>
        <span className="font-medium">{account.email}</span>
        {account.handle && <span className="text-muted-foreground"> ({account.handle})</span>}
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <label htmlFor={roleId} className="text-sm font-medium">
            Role
          </label>
          <select
            id={roleId}
            value={role}
            onChange={(e) => {
              setRole(Role.parse(e.target.value));
              save.reset();
            }}
            className={fieldClass}
          >
            {Role.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant="outline"
          disabled={save.isPending || role === (save.data?.role ?? account.role)}
          onClick={() => save.mutate(role)}
        >
          Save role
        </Button>
      </div>
      {save.isSuccess && (
        <p role="status" className="mt-2 text-sm">
          Saved: {save.data.role}
        </p>
      )}
      {save.isError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {describeError(save.error, "Couldn't change the role. Try again.")}
        </p>
      )}
    </li>
  );
}
