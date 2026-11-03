import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { authAccounts, authPasskeys, authSessions, authVerifications, users } from '../db/schema';
import type { Db } from '../db/types';
import type { SessionInfo } from '../http/app-env';
import type { Env } from '../../env';

type AuthEnv = Pick<
  Env,
  | 'BETTER_AUTH_SECRET'
  | 'BETTER_AUTH_URL'
  | 'WEB_ORIGIN'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'GITHUB_CLIENT_ID'
  | 'GITHUB_CLIENT_SECRET'
>;

type DatabaseHooks = NonNullable<BetterAuthOptions['databaseHooks']>;

/** How long a session counts as fresh for sensitive actions, such as adding a passkey. */
export const SESSION_FRESH_AGE_SECONDS = 86400;

/** The email-code plugin's routes other than sending a code and signing in with it . */
const UNUSED_EMAIL_OTP_PATHS = [
  '/email-otp/check-verification-otp',
  '/email-otp/verify-email',
  '/email-otp/request-password-reset',
  '/forget-password/email-otp',
  '/email-otp/reset-password',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
];

/** The passkey routes that act on one passkey by id. */
const OWNED_PASSKEY_PATHS = new Set(['/passkey/delete-passkey', '/passkey/update-passkey']);
/** Postgres's uuid text form; anything else would fail the cast (22P02) and answer 500. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Feature rules Better Auth runs; passed in because platform code knows nothing about features. */
export interface AuthHooks {
  /** Runs before a user row is created; may refuse the sign-up or adjust the user. */
  beforeUserCreate: NonNullable<NonNullable<NonNullable<DatabaseHooks['user']>['create']>['before']>;
  /** Delivers a sign-in code. Throws a Better Auth `APIError` when it can't. */
  sendSignInCode(email: string, code: string): Promise<void>;
}

/** The email-code routes whose `email` is normalized before the plugin reads it. */
const EMAIL_CODE_PATHS = new Set(['/email-otp/send-verification-otp', '/sign-in/email-otp']);

export function createAuth(db: Db, env: AuthEnv, hooks: AuthHooks, opts: { rateLimit?: boolean } = {}) {
  // The plugin awaits the send but logs and swallows anything it throws (`runInBackgroundOrAwait`
  // at 1.7.13), which would answer "sent" for an email that never went out. So the failure is
  // parked against the request's context here and rethrown by the after hook below.
  const failedSends = new WeakMap<object, unknown>();
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    trustedOrigins: [env.WEB_ORIGIN],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        users,
        auth_sessions: authSessions,
        auth_accounts: authAccounts,
        auth_verifications: authVerifications,
        auth_passkeys: authPasskeys,
      },
    }),
    user: {
      modelName: 'users',
      // Set by the beforeUserCreate hook only; `input: false` keeps a client from choosing its role.
      additionalFields: { role: { type: 'string', required: false, input: false, defaultValue: 'contributor' } },
    },
    session: {
      modelName: 'auth_sessions',
      freshAge: SESSION_FRESH_AGE_SECONDS,
    },
    // Trusted providers are linked even without a verified email, so the list stays empty: linking
    // then requires the provider to report the email as verified.
    account: { modelName: 'auth_accounts', accountLinking: { enabled: true, trustedProviders: [] } },
    verification: { modelName: 'auth_verifications' },
    // This endpoint would write name/image unvalidated.
    disabledPaths: ['/update-user', ...UNUSED_EMAIL_OTP_PATHS],
    // Undefined keeps Better Auth's default: on in production, off elsewhere.
    rateLimit: { enabled: opts.rateLimit },
    advanced: { database: { generateId: 'uuid' } },
    socialProviders: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      // Better Auth requests read:user + user:email and reports whether the email is verified.
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    },
    plugins: [
      passkey({
        rpID: new URL(env.WEB_ORIGIN).hostname,
        rpName: 'AMDB',
        origin: env.WEB_ORIGIN,
        schema: { passkey: { modelName: 'auth_passkeys' } },
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        storeOTP: 'hashed',
        rateLimit: { window: 60, max: 3 },
        sendVerificationOTP: async ({ email, otp }, ctx) => {
          try {
            await hooks.sendSignInCode(email, otp);
          } catch (err) {
            if (!ctx) throw err;
            failedSends.set(ctx.context, err);
          }
        },
      }),
    ],
    hooks: {
      // The plugin lowercases the email but doesn't trim it, so `Tyler@X.com ` would be refused.
      before: createAuthMiddleware(async (ctx) => {
        // Other code types belong to the disabled routes; sending them would email a dead code, and
        // only to known addresses, which a failing send would reveal.
        if (ctx.path === '/email-otp/send-verification-otp' && ctx.body?.type !== 'sign-in') {
          throw new APIError('BAD_REQUEST', { code: 'INVALID_OTP_TYPE', message: 'Only sign-in codes can be sent.' });
        }
        // Better Auth answers 401 when a signed-in caller targets someone else's passkey, but 404 for
        // an unknown id, which would reveal that the id exists. Answer both with 404. (Throwing from
        // an after hook can't change the status, so the ownership check runs here.) Signed-out
        // callers fall through to the plugin's own 401.
        if (OWNED_PASSKEY_PATHS.has(ctx.path) && typeof ctx.body?.id === 'string') {
          const session = await getSessionFromCtx(ctx);
          if (session) {
            // A malformed id can't name anyone's passkey: answer it like a missing one.
            const owned =
              UUID.test(ctx.body.id) &&
              (await ctx.context.adapter.findOne({
                model: 'passkey',
                where: [
                  { field: 'id', value: ctx.body.id },
                  { field: 'userId', value: session.user.id },
                ],
              }));
            if (!owned) throw new APIError('NOT_FOUND', { code: 'NOT_FOUND', message: 'Not found' });
          }
        }
        if (!EMAIL_CODE_PATHS.has(ctx.path) || typeof ctx.body?.email !== 'string') return;
        return { context: { body: { ...ctx.body, email: ctx.body.email.trim().toLowerCase() } } };
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (failedSends.has(ctx.context)) throw failedSends.get(ctx.context);
      }),
    },
    databaseHooks: {
      user: { create: { before: hooks.beforeUserCreate } },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** The caller's Better Auth session, or null when signed out. */
export async function getSessionFromAuth(auth: Auth, headers: Headers): Promise<SessionInfo | null> {
  const result = await auth.api.getSession({ headers });
  if (!result) return null;
  return { userId: result.user.id, createdAt: new Date(result.session.createdAt) };
}
