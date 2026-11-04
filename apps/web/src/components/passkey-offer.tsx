import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AuthClient } from '@/lib/auth';

/**
 * Shown once, right after an email-code sign-in, to someone with no passkey: save one so the next
 * sign-in skips the email. Either answer carries on to where the person was going.
 */
export function PasskeyOffer({ auth, onDone }: { auth: AuthClient; onDone: () => void }) {
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  async function setUp() {
    setWorking(true);
    setFailed(false);
    try {
      const { error } = await auth.passkey.addPasskey();
      if (!error) return onDone();
    } catch {
      // Falls through to the same message as a cancelled prompt.
    }
    setFailed(true);
    setWorking(false);
  }

  return (
    <section aria-labelledby="passkey-offer" className="flex flex-col gap-3">
      <h2 id="passkey-offer" className="font-serif text-xl font-semibold">
        Skip the email next time?
      </h2>
      <p className="text-muted-foreground">Save a passkey and your device or password manager will sign you in.</p>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't save a passkey. Try again, or carry on without one.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button disabled={working} onClick={() => void setUp()}>
          Set it up
        </Button>
        <Button variant="ghost" disabled={working} onClick={onDone}>
          Not now
        </Button>
      </div>
    </section>
  );
}
