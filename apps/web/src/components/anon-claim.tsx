import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { isClaimed, markClaimed, peekAnonToken, rotateAnonToken, unmarkClaimed } from '@/lib/anon';
import { unwrap } from '@/lib/api';
import { meQueryOptions } from '@/lib/me';

const rootRoute = getRouteApi('__root__');

/** The token being claimed right now: storage can fail, so storage alone can't stop a double send. */
let claiming: string | null = null;

/**
 * When a session appears and this browser holds an anonymous token that has not been claimed, hand
 * its submissions to the account, once, and rotate the token. The token is marked before the call,
 * so a reload or second tab doesn't send it again. A failed call unmarks it, says so and offers
 * Try again; the next load tries again too. Retrying is safe: the API moves each submission once,
 * so a second claim of the same token moves none. Storage failures are ignored: signing in never
 * depends on them.
 */
export function AnonClaim() {
  const { api } = rootRoute.useRouteContext();
  const queryClient = useQueryClient();
  const userId = useQuery(meQueryOptions(api)).data?.id;
  const [failed, setFailed] = useState(false);
  // Bumped by Try again, to run the claim once more.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!userId) return;
    const token = peekAnonToken();
    if (!token || claiming === token || isClaimed(token)) return;
    claiming = token;
    markClaimed(token);
    void (async () => {
      try {
        // Signed in, the client sends no token of its own; the claim names the one to hand over.
        unwrap(await api.POST('/api/me/claim-anonymous', { headers: { 'x-amdb-anon': token } }));
        rotateAnonToken();
        setFailed(false);
        await queryClient.invalidateQueries({ queryKey: ['my-submissions'] });
      } catch {
        unmarkClaimed();
        setFailed(true);
      } finally {
        claiming = null;
      }
    })();
  }, [userId, api, queryClient, attempt]);

  // Signed out since, there is no account to hand them to.
  if (!failed || !userId) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2 text-sm">
      <p>Couldn't move the submissions you made before signing in to your account.</p>
      <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
        Try again
      </Button>
    </div>
  );
}
