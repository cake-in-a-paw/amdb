import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { PasskeyOffer } from '@/components/passkey-offer';
import { Button } from '@/components/ui/button';
import type { AuthClient, AuthResult } from '@/lib/auth';
import { meQueryKey } from '@/lib/me';
import { safeNext } from '@/lib/next-path';

const CODE_LENGTH = 6;
const field =
  'min-h-11 w-full rounded-md border border-input bg-card px-3 text-foreground aria-invalid:border-destructive';
const linkButton = 'inline-flex min-h-11 min-w-11 items-center text-sm text-primary underline underline-offset-4';

type Step = { kind: 'email' } | { kind: 'code'; email: string } | { kind: 'offer' };

/** What to say when a code could not be sent. */
function sendFailure(error: NonNullable<AuthResult['error']>): string {
  if (error.status === 429) return 'Too many tries. Wait a minute and try again.';
  return "We couldn't send the email. Try again in a moment, or continue with Google or GitHub.";
}

/**
 * Email-code and passkey sign-in. Any success refetches `GET /api/me` and lands on `next`; an email
 * sign-in by someone with no passkey stops at the offer first.
 */
export function EmailSignIn({ auth, next }: { auth: AuthClient; next: string | undefined }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'email' });
  const [message, setMessage] = useState<string | null>(null);

  const leave = () => router.navigate({ href: safeNext(next) });

  const signedIn = async (offerPasskey: boolean) => {
    await queryClient.invalidateQueries({ queryKey: meQueryKey });
    if (offerPasskey && (await shouldOfferPasskey(auth))) return setStep({ kind: 'offer' });
    await leave();
  };

  const passkey = async () => {
    setMessage(null);
    try {
      const { error } = await auth.signIn.passkey();
      if (!error) return await signedIn(false);
    } catch {
      // Falls through to the same message as a cancelled prompt.
    }
    setMessage("Couldn't sign in with a passkey. Use an email code instead.");
  };

  if (step.kind === 'offer') return <PasskeyOffer auth={auth} onDone={() => void leave()} />;
  return step.kind === 'email' ? (
    <EmailStep
      auth={auth}
      message={message}
      setMessage={setMessage}
      onSent={(email) => setStep({ kind: 'code', email })}
      onPasskey={() => void passkey()}
    />
  ) : (
    <CodeStep
      auth={auth}
      email={step.email}
      onVerified={() => signedIn(true)}
      onBack={() => {
        setMessage(null);
        setStep({ kind: 'email' });
      }}
    />
  );
}

/** Offer only where the browser can save a passkey and the person has none yet; any doubt skips it. */
async function shouldOfferPasskey(auth: AuthClient): Promise<boolean> {
  if (typeof window.PublicKeyCredential === 'undefined') return false;
  try {
    const { data, error } = await auth.passkey.listUserPasskeys();
    return !error && Array.isArray(data) && data.length === 0;
  } catch {
    return false;
  }
}

function EmailStep({
  auth,
  message,
  setMessage,
  onSent,
  onPasskey,
}: {
  auth: AuthClient;
  message: string | null;
  setMessage: (m: string | null) => void;
  onSent: (email: string) => void;
  onPasskey: () => void;
}) {
  const fieldId = useId();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setMessage(null);
    try {
      const { error } = await auth.emailOtp.sendVerificationOtp({ email: trimmed, type: 'sign-in' });
      if (error) setMessage(sendFailure(error));
      else onSent(trimmed);
    } catch {
      setMessage(sendFailure({}));
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)}>
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId} className="text-sm font-medium">
          Email
        </label>
        <input
          id={fieldId}
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={message ? true : undefined}
          className={field}
        />
      </div>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <Button type="submit" disabled={sending}>
        Continue with email
      </Button>
      <Button type="button" variant="ghost" onClick={onPasskey}>
        Sign in with a passkey
      </Button>
    </form>
  );
}

function CodeStep({
  auth,
  email,
  onVerified,
  onBack,
}: {
  auth: AuthClient;
  email: string;
  onVerified: () => Promise<void>;
  onBack: () => void;
}) {
  const fieldId = useId();
  const [message, setMessage] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);

  const verify = async (value: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await auth.signIn.emailOtp({ email, otp: value });
      if (!error) return await onVerified();
      const code = error.error?.code?.toLowerCase();
      if (error.status === 429) setMessage('Too many tries. Wait a minute and try again.');
      else if (code === 'too_many_attempts' || code === 'otp_expired') {
        setMessage('That code has expired. Send a new one.');
      } else setMessage(code === 'invalid_otp' ? "That code didn't work." : "Couldn't sign you in. Try again.");
    } catch {
      setMessage("Couldn't sign you in. Try again.");
    }
    setCode('');
    setBusy(false);
  };

  const onChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(digits);
    if (digits.length === CODE_LENGTH && !busy) void verify(digits);
  };

  const resend = async () => {
    setSending(true);
    setMessage(null);
    try {
      const { error } = await auth.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
      if (error) setMessage(sendFailure(error));
      else setCode('');
    } catch {
      setMessage(sendFailure({}));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p>We sent a code to {email}</p>
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId} className="text-sm font-medium">
          Code
        </label>
        <input
          id={fieldId}
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={CODE_LENGTH}
          value={code}
          readOnly={busy}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={message ? true : undefined}
          className={field}
        />
      </div>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className={linkButton} disabled={sending || busy} onClick={() => void resend()}>
          Send a new code
        </button>
        <button type="button" className={linkButton} onClick={onBack}>
          Use a different email
        </button>
      </div>
    </div>
  );
}
