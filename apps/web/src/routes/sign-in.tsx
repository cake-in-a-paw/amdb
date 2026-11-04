import { createFileRoute } from '@tanstack/react-router';
import { EmailSignIn } from '@/components/email-sign-in';
import { SignInButtons } from '@/components/sign-in-buttons';

export const Route = createFileRoute('/sign-in')({
  // `next` is where to go after signing in; `error` comes back from a failed provider sign-in.
  validateSearch: (search: Record<string, unknown>): { next?: string; error?: string } => ({
    ...(typeof search.next === 'string' ? { next: search.next } : {}),
    ...(typeof search.error === 'string' ? { error: search.error } : {}),
  }),
  component: SignIn,
});

function SignIn() {
  const { auth } = Route.useRouteContext();
  const { next, error } = Route.useSearch();
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 py-12">
      <h1 className="font-serif text-3xl font-semibold">Sign in</h1>
      <p className="text-muted-foreground">
        You can browse without an account. Sign in to keep your contributions together and add a public handle.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't sign you in. Try again.
        </p>
      )}
      <SignInButtons auth={auth} next={next} />
      <p className="text-center text-sm text-muted-foreground">or</p>
      <EmailSignIn auth={auth} next={next} />
    </div>
  );
}
