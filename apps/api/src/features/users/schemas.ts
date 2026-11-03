import { z } from '@hono/zod-openapi';
import { Role } from '@amdb/shared';

export const SetRoleBody = z.object({ role: Role });
export const UserRoleSchema = z.object({ id: z.uuid(), role: Role });
