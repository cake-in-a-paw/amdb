import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/client';
import { emailOTPClient } from 'better-auth/client/plugins';

export type SocialProvider = 'google' | 'github';

/**
 * The part of the Better Auth client the app uses. Routes get it through router context
 * (`context.auth`), so tests pass a stub instead of module-mocking Better Auth.
 */
export interface AuthClient {
  signIn: {
    social(opts: { provider: SocialProvider; callbackURL: string; errorCallbackURL: string }): Promise<AuthResult>;
    emailOtp(opts: { email: string; otp: string }): Promise<AuthResult>;
    passkey(): Promise<AuthResult>;
  };
  emailOtp: { sendVerificationOtp(opts: { email: string; type: 'sign-in' }): Promise<AuthResult> };
  passkey: {
    addPasskey(): Promise<AuthResult>;
    listUserPasskeys(): Promise<AuthResult>;
  };
  signOut(): Promise<AuthResult>;
}

/**
 * Better Auth's client resolves `{ data, error }` for a failed answer instead of throwing (it still
 * rejects on a network failure), so callers check `error`. The API wraps Better Auth's errors as
 * `{ error: { code, message } }`, which the client keeps on `error`, so the code is at
 * `error.error.code` and the HTTP status at `error.status`.
 */
export interface AuthResult {
  data?: unknown;
  error: { code?: string; message?: string; status?: number; error?: { code?: string; message?: string } } | null;
}

/**
 * The real Better Auth client, built on demand so importing this file (as every test does) never
 * constructs it. Only main.tsx calls it. The API is same-origin (Vite proxies /api in dev), so the
 * base URL is the page's origin; passing it explicitly stops Better Auth from reading one out of
 * the environment.
 */
export function createBrowserAuthClient(): AuthClient {
  return createAuthClient({
    baseURL: window.location.origin,
    basePath: '/api/auth',
    plugins: [emailOTPClient(), passkeyClient()],
  });
}
