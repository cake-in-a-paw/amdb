const DEFAULT_TIMEOUT_MS = 5_000;
const ENDPOINT = 'https://api.resend.com/emails';

/** Sends plain-text email. */
export interface EmailClient {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

/** The email could not be sent: Resend is down, slow, rate-limiting, or refusing the message. */
export class EmailUnavailableError extends Error {
  override name = 'EmailUnavailableError';

  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
  }
}

export function createResendClient(opts: {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): EmailClient {
  const doFetch = opts.fetch ?? fetch;
  return {
    async send(msg) {
      try {
        const res = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: opts.from, to: [msg.to], subject: msg.subject, text: msg.text }),
          // A redirect could carry the key to another host, so it fails instead.
          redirect: 'error',
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (!res.ok) {
          // Reported for the logs, never waited on: the user can ask for a new code.
          const retryAfter = res.headers.get('retry-after');
          throw new EmailUnavailableError(
            `Resend answered ${res.status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ''}`,
          );
        }
      } catch (err) {
        if (err instanceof EmailUnavailableError) throw err;
        throw new EmailUnavailableError(`Resend unavailable: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
    },
  };
}
