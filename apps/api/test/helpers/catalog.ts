import { expect } from 'vitest';
import type { setupTest } from './setup';

type T = Awaited<ReturnType<typeof setupTest>>;
type Client = ReturnType<T['as']>;

export type Created = {
  id: string;
  changes: { id: string; seq: number; op: string; status: string; entityId: string | null }[];
};

export const submission = (changes: unknown[]) => ({ cc0: true, changes });

/** Submits as `client` and returns the created submission, failing the test on anything but 201. */
export async function submit(client: Client, changes: unknown[]): Promise<Created> {
  const res = await client.post('/api/submissions', submission(changes));
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as Created;
}

/** Approves each change in order as `moderator`, failing the test on anything but 200. */
export async function approveAll(moderator: Client, created: Created) {
  for (const c of created.changes) {
    const res = await moderator.post(`/api/changes/${c.id}/approve`);
    expect(res.status, await res.clone().text()).toBe(200);
  }
}

/** Submits as `client` and approves everything as `moderator`; returns the submission. */
export async function publish(client: Client, moderator: Client, changes: unknown[]) {
  const created = await submit(client, changes);
  await approveAll(moderator, created);
  return created;
}
