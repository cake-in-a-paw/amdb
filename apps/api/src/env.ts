import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  /** Origin of the web app: CORS with credentials, trusted origin and passkey relying party. */
  WEB_ORIGIN: z.url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  EMAIL_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().min(1),
  /** Proxies in front of the API that append to X-Forwarded-For; the client is that many entries from the right. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).default(1),
  /** Directory of the built web app to serve alongside the API. Unset means the API serves no web app. */
  WEB_DIST_DIR: z.string().min(1).optional(),
  /** Comma-separated addresses; an account created with one of them is an admin. Unset means none. */
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
});
export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(source: Record<string, unknown> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}
