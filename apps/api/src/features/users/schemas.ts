import { z } from '@hono/zod-openapi';
import { Handle, Role } from '@amdb/shared';

export const SetRoleBody = z.object({ role: Role });
export const UserRoleSchema = z.object({ id: z.uuid(), role: Role });

export const MeSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  handle: z.string().nullable(),
  role: Role,
});
export const PatchMeBody = z.object({ handle: Handle.nullable() });
export const FindUsersQuery = z.object({ email: z.string().min(1) });
export const UserListSchema = z.object({ items: z.array(MeSchema) });
