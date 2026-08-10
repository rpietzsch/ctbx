/**
 * Runtime negotiation of the MCP request headers a server's CORS policy accepts.
 *
 * The MCP client adds headers to every request after the handshake:
 * `MCP-Protocol-Version` always, `Mcp-Session-Id` once the server issued one,
 * `Last-Event-ID` when resuming a stream. None of them are CORS-safelisted, so
 * each one has to appear in the server's `Access-Control-Allow-Headers` or the
 * browser rejects the preflight and the request never leaves the page.
 *
 * That is the shape of the failure this module exists for: `initialize` carries
 * none of those headers and succeeds, then `notifications/initialized` carries
 * `MCP-Protocol-Version` and is blocked — so the endpoint looks healthy to any
 * one-shot probe and the connection still dies. Native clients (Claude Code,
 * Witsy, …) never see it, because CORS is enforced by the browser and not by
 * the server, so servers ship with the header missing and nobody notices.
 *
 * A page cannot read a preflight response, so ctbx cannot ask which headers are
 * allowed — it can only find out by trying. On an opaque network failure the
 * request is retried with the droppable headers removed, cheapest first, and
 * whatever worked is remembered for the rest of the connection.
 *
 * Dropping is safe for the headers listed here:
 *
 *   - `MCP-Protocol-Version` — the spec requires a server that does not receive
 *     it to assume `2025-03-26`, which is a version ctbx speaks.
 *   - `Last-Event-ID` — only replays a stream from a known point; without it
 *     the stream restarts.
 *   - `Mcp-Session-Id` — last resort, and the only one with teeth: a stateless
 *     server does not care, a stateful one answers with an HTTP error instead
 *     of an opaque browser rejection, which at least says what went wrong.
 */

/** Droppable headers, ordered by how little is lost by dropping them. */
export const DROPPABLE_HEADERS = [
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
] as const;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface NegotiatingFetch extends FetchLike {
  /** Header names found to be blocked, lower-cased. Stripped from every request. */
  readonly dropped: readonly string[];
}

export interface NegotiateOptions {
  fetchFn?: FetchLike;
  /** Called when a header is dropped for the first time, for the UI to report. */
  onDrop?: (dropped: readonly string[]) => void;
}

function headerEntries(init: HeadersInit | undefined): [string, string][] {
  if (!init) return [];
  if (init instanceof Headers) return [...init.entries()];
  if (Array.isArray(init)) return init.map(([name, value]) => [name, value]);
  return Object.entries(init);
}

/** Lower-cased names of the headers on a request. */
export function headerNames(init: HeadersInit | undefined): string[] {
  return headerEntries(init).map(([name]) => name.toLowerCase());
}

/** The same headers minus `drop`, compared case-insensitively. */
export function withoutHeaders(init: HeadersInit | undefined, drop: ReadonlySet<string>): Headers {
  const headers = new Headers();
  for (const [name, value] of headerEntries(init)) {
    if (!drop.has(name.toLowerCase())) headers.append(name, value);
  }
  return headers;
}

/**
 * The successive header sets to try removing: first the cheapest header alone,
 * then it plus the next, and so on. Cumulative because a server that rejects
 * one unknown header usually rejects the others too — a single narrow
 * allow-list is the norm — so widening the reduction converges faster than
 * testing each header on its own.
 */
export function dropPlan(present: Iterable<string>, exclude: ReadonlySet<string>): string[][] {
  const seen = new Set([...present].map((name) => name.toLowerCase()));
  const candidates = DROPPABLE_HEADERS.filter((name) => seen.has(name) && !exclude.has(name));
  return candidates.map((_, index) => candidates.slice(0, index + 1));
}

/**
 * A `fetch` rejection that carries no information: a CORS rejection, a DNS
 * failure and an offline network are all a bare `TypeError`. An aborted request
 * rejects with an `AbortError` `DOMException` instead, which must not be
 * retried.
 */
export function isOpaqueNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError;
}

/**
 * Wraps `fetch` so a blocked MCP header degrades the request instead of killing
 * the connection.
 *
 * Retrying sends the body a second time, so experimentation is bounded: it only
 * happens while there is an untried droppable header on the request, and stops
 * for good once a full round of reductions fails to help. In practice the
 * negotiation resolves on `notifications/initialized` — the first request that
 * carries `MCP-Protocol-Version`, and a notification, so re-sending it has no
 * effect on the server.
 */
export function createNegotiatingFetch(options: NegotiateOptions = {}): NegotiatingFetch {
  const baseFetch: FetchLike = options.fetchFn ?? ((input, init) => fetch(input, init));
  const dropped = new Set<string>();
  let exhausted = false;

  const negotiating = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const request: RequestInit | undefined =
      dropped.size > 0 && init ? { ...init, headers: withoutHeaders(init.headers, dropped) } : init;

    try {
      return await baseFetch(input, request);
    } catch (error) {
      if (exhausted || !isOpaqueNetworkFailure(error)) throw error;

      for (const candidate of dropPlan(headerNames(request?.headers), dropped)) {
        const reduced = new Set([...dropped, ...candidate]);
        try {
          const response = await baseFetch(input, {
            ...request,
            headers: withoutHeaders(request?.headers, reduced),
          });
          for (const name of candidate) dropped.add(name);
          options.onDrop?.([...dropped]);
          return response;
        } catch (retryError) {
          if (!isOpaqueNetworkFailure(retryError)) throw retryError;
        }
      }

      // Nothing left to try. Stop re-sending bodies on every later failure —
      // from here the problem is not a header the browser can drop.
      exhausted = true;
      throw error;
    }
  };

  return Object.defineProperty(negotiating, 'dropped', {
    get: () => [...dropped],
  }) as NegotiatingFetch;
}

/** Header names as an operator would see them in a CORS configuration. */
const CANONICAL_NAMES: Record<string, string> = {
  'last-event-id': 'Last-Event-ID',
  'mcp-protocol-version': 'MCP-Protocol-Version',
  'mcp-session-id': 'Mcp-Session-Id',
};

export function canonicalHeaderName(name: string): string {
  return CANONICAL_NAMES[name.toLowerCase()] ?? name;
}
