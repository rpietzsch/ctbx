/**
 * Attaches the bearer token to MCP transport requests at send time, spec §7.6.
 *
 * The MCP SDK's transport takes its headers once, in `requestInit`, and reuses
 * that object for the life of the connection. Putting `Authorization` there
 * freezes the access token at the moment `connect()` ran, which is fine for
 * exactly as long as the token lives — typically five minutes, the Keycloak
 * default. A chat session outlives that easily: the first tool calls of a turn
 * succeed, the token expires, and every call after it is rejected while the
 * connection still reports itself connected. The model then has to explain a
 * sudden 401/403 with no idea that a token expired, and reaches for the only
 * story that fits what it can see — that its access was revoked.
 *
 * So the token is resolved per request instead, through the same custom `fetch`
 * hook the header negotiation already uses. `token(false)` returns the current
 * one, renewing it first when it is close enough to expiry; `token(true)`
 * demands a renewal, which is the recovery path for a rejection the local clock
 * did not predict — a token revoked early, a skewed clock, or a server that
 * issued no `expires_in` for us to plan around.
 *
 * Only requests that already carry a token are retried: an endpoint that needs
 * no authorization must not be handed one, and a 401 from an anonymous
 * connection is the ordinary "authorize me" signal that `connect()` handles.
 */
import { extractChallengeError } from './discovery';
import type { FetchLike } from '../header-negotiation';

export interface AuthorizingFetchOptions {
  /**
   * The access token to send, or `undefined` when none is held. `force` asks
   * for a renewal rather than whatever is stored; returning the same token
   * again means renewal was impossible, and the rejection stands.
   */
  token: (force: boolean) => Promise<string | undefined>;
  /** The rejection survived a renewal — the connection needs authorizing again. */
  onRejected?: (status: number, challenge: string | null) => void;
  fetchFn: FetchLike;
}

/**
 * Challenge errors that mean "this token is no good", as opposed to "this token
 * is fine and you still may not do that". Only the former is worth renewing
 * for: retrying a genuine authorization failure just doubles every denied
 * request and, worse, would report a working connection as needing login.
 */
const RENEWABLE_CHALLENGES = new Set(['invalid_token', 'expired_token']);

/**
 * Whether a rejection is worth a fresh token.
 *
 * A 401 always is — it is the status for a credential problem, and a server
 * that omits `WWW-Authenticate` from `Access-Control-Expose-Headers` (spec §9.1)
 * leaves the browser nothing else to go on. A 403 only when the challenge says
 * so, because a 403 is otherwise the resource server's way of saying the caller
 * is known and still not allowed.
 */
export function isRenewableRejection(status: number, challenge: string | null): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  const error = extractChallengeError(challenge);
  return error !== undefined && RENEWABLE_CHALLENGES.has(error);
}

/** A body that can be sent twice. Streams are consumed by the first attempt. */
function isReplayable(body: BodyInit | null | undefined): boolean {
  return !(body instanceof ReadableStream);
}

function withAuthorization(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

export function createAuthorizingFetch(options: AuthorizingFetchOptions): FetchLike {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const token = await options.token(false);
    if (!token) return options.fetchFn(input, init);

    const response = await options.fetchFn(input, withAuthorization(init, token));

    const challenge = response.headers.get('WWW-Authenticate');
    if (response.ok || !isRenewableRejection(response.status, challenge)) return response;
    if (!isReplayable(init?.body)) return response;

    const renewed = await options.token(true);
    if (!renewed || renewed === token) {
      options.onRejected?.(response.status, challenge);
      return response;
    }

    // The rejected response body is abandoned rather than read: nothing
    // consumes it, and leaving it undrained keeps the connection pooled.
    void response.body?.cancel().catch(() => {});

    const retried = await options.fetchFn(input, withAuthorization(init, renewed));
    if (!retried.ok) {
      const retryChallenge = retried.headers.get('WWW-Authenticate');
      if (isRenewableRejection(retried.status, retryChallenge)) {
        options.onRejected?.(retried.status, retryChallenge);
      }
    }
    return retried;
  };
}
