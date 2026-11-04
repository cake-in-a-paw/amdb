import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import type { AuthClient, SocialProvider } from '@/lib/auth';
import { safeNext } from '@/lib/next-path';

const providers = [
  { provider: 'google', name: 'Google' },
  { provider: 'github', name: 'GitHub' },
] as const satisfies readonly { provider: SocialProvider; name: string }[];

/**
 * Google and GitHub sign-in. After sign-in the person returns to `next`, reduced to a same-origin
 * path first. A refused or failed sign-in comes back to this page with `?error=`, shown by the
 * route; `errorCallbackURL` keeps `next` so a retry still returns to the right place.
 */
export function SignInButtons({ auth, next }: { auth: AuthClient; next: string | undefined }) {
  const signIn = useMutation({
    mutationFn: async (provider: SocialProvider) => {
      // Absolute: Better Auth redirects from the API's origin, which can differ from the app's in dev.
      const kept = safeNext(next);
      const { error } = await auth.signIn.social({
        provider,
        callbackURL: window.location.origin + kept,
        errorCallbackURL:
          window.location.origin + '/sign-in' + (kept === '/' ? '' : `?next=${encodeURIComponent(kept)}`),
      });
      if (error) throw new Error(error.message ?? 'Something went wrong.');
    },
  });
  // A successful call leaves the page for the provider, so the buttons stay disabled after it too.
  const busy = signIn.isPending || signIn.isSuccess;

  return (
    <div className="flex flex-col gap-3">
      {signIn.isError && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't sign in with {providers.find((p) => p.provider === signIn.variables)?.name}. Try again.
        </p>
      )}
      {providers.map(({ provider, name }) => (
        <Button
          key={provider}
          variant="outline"
          className="justify-center"
          disabled={busy}
          onClick={() => signIn.mutate(provider)}
        >
          Continue with {name}
        </Button>
      ))}
    </div>
  );
}
