import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useEffect } from 'react';
import { isClaimed, markClaimed, peekAnonToken, rotateAnonToken, unmarkClaimed } from '@/lib/anon';
import { unwrap } from '@/lib/api';
import { meQueryOptions } from '@/lib/me';

const rootRoute = getRouteApi('__root__');

/** The token being claimed right now: storage can fail, so storage alone can't stop a double send. */
let claiming: string | null = null;

/**
 * When a session appears and this browser holds an anonymous token that has not been claimed, hand
 * its submissions to the account, once, and rotate the token. The token is marked before the call,
 * so a reload or second tab doesn't send it again; a failed call unmarks it to try on the next
 * load. Storage failures are ignored: signing in never depends on them.
 */
export function AnonClaim() {
  const { api } = rootRoute.useRouteContext();
  const queryClient = useQueryClient();
  const userId = useQuery(meQueryOptions(api)).data?.id;

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
        await queryClient.invalidateQueries({ queryKey: ['my-submissions'] });
      } catch {
        unmarkClaimed();
      } finally {
        claiming = null;
      }
    })();
  }, [userId, api, queryClient]);

  return null;
}
