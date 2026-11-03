import { APIError } from 'better-auth/api';
import type { AuthHooks } from '../../platform/auth/auth';
import { EmailUnavailableError, type EmailClient } from '../../platform/email/resend';

/**
 * Builds the hook Better Auth runs before it creates a user.
 * Only verified emails may sign up: this blocks account takeover via an unverified copy of
 * someone's email, and keeps ADMIN_EMAILS from being claimed with an address nobody proved they own.
 * An address in `adminEmails` (lowercased, exact match) is created as an admin; everyone else is a
 * contributor. A profile without a name stores none, and an email-code sign-up ignores the
 * client-sent name and image, which would otherwise be stored unchecked.
 */
export function createBeforeUserCreate({ adminEmails }: { adminEmails: string[] }) {
  // Generic like Better Auth's own user type, which says `name` is a string though we store none.
  return async <
    U extends { email: string; emailVerified?: boolean | null; name?: string | null; image?: string | null },
  >(
    user: U,
    ctx?: { path?: string } | null,
  ): Promise<{ data: U }> => {
    if (!user.emailVerified) {
      throw new APIError('FORBIDDEN', {
        // The OAuth callback passes a coded refusal on to the client's error URL (`?error=`).
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Verify an email address on GitHub, or sign in with Google or with your email.',
      });
    }
    const fromEmailCode = ctx?.path === '/sign-in/email-otp';
    const profile = fromEmailCode ? { ...user, name: null, image: null } : user;
    const role = adminEmails.includes(user.email.trim().toLowerCase()) ? 'admin' : 'contributor';
    return { data: { ...profile, name: profile.name?.trim() ? profile.name : null, role } };
  };
}

/** Emails a sign-in code. A delivery failure becomes a 503 the client shows. */
export function createSignInCodeSender(email: EmailClient): AuthHooks['sendSignInCode'] {
  return async (to, code) => {
    try {
      await email.send({
        to,
        subject: `Your AMDB code: ${code}`,
        text: `Your AMDB sign-in code is ${code}.\n\nIt expires in 5 minutes. If you didn't ask for it, you can ignore this email.`,
      });
    } catch (err) {
      if (!(err instanceof EmailUnavailableError)) throw err;
      console.error(err);
      throw new APIError('SERVICE_UNAVAILABLE', {
        code: 'EMAIL_UNAVAILABLE',
        message: "We couldn't send the email right now.",
      });
    }
  };
}
