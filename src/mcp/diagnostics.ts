/**
 * Connection diagnostics for remote MCP servers (spec §9.1, backlog M3-6).
 *
 * A browser cannot tell a DNS failure, an offline network and a CORS rejection
 * apart: `fetch` rejects with the same opaque TypeError for all three. That
 * makes "failed to fetch" unsolvable for a user, and CORS is the single biggest
 * adoption risk for a browser-only MCP client (risk R1).
 *
 * The trick used here is a second probe with `mode: 'no-cors'`. That request
 * bypasses the CORS check and yields an opaque response. So:
 *
 *   normal fetch fails + no-cors probe succeeds  → the server is reachable and
 *                                                  the browser blocked it: CORS
 *   normal fetch fails + no-cors probe fails     → genuinely unreachable
 *
 * A second trick covers the harder case, where the endpoint answers `initialize`
 * and the connection still dies: the same request is repeated carrying one of
 * the headers the MCP client adds after the handshake. Succeeding without it and
 * failing with it isolates that header as the blocked one — which is a
 * measurement, not a guess, and the reason the remedy can name it.
 *
 * The decision logic is pure and exhaustively tested; only `probe` touches the
 * network.
 */

import {
  blockedRequestHeaderRemedy,
  mcpEndpointCorsRemedy,
  NATIVE_CLIENT_NOTE,
  tokenRejectedRemedy,
} from './cors-remedy';
import { canonicalHeaderName } from './header-negotiation';
import { extractChallengeError } from './auth/discovery';

export type DiagnosisKind =
  | 'ok'
  | 'needs-auth'
  | 'token-rejected'
  | 'cors'
  | 'cors-headers'
  | 'network'
  | 'not-found'
  | 'server-error'
  | 'protocol';

export interface Diagnosis {
  kind: DiagnosisKind;
  message: string;
  /** Concrete fix, aimed at whoever operates the MCP server. */
  remedy?: string;
}

export interface ProbeOutcome {
  /** True when the CORS-checked request completed at all. */
  corsRequestSucceeded: boolean;
  /** HTTP status, when a response was actually received. */
  status?: number;
  /** True when a `no-cors` request reached the server. */
  reachable?: boolean;
  /** True when `WWW-Authenticate` was readable on a 401/403. */
  wwwAuthenticateReadable?: boolean;
  /** True when `Mcp-Session-Id` was readable on a successful response. */
  sessionIdReadable?: boolean;
  /**
   * Headers the differential probe proved the browser will not send to this
   * endpoint: the request went through without them and was blocked with them.
   */
  blockedRequestHeaders?: string[];
  /**
   * True when the probe carried an access token. Without this the diagnosis
   * cannot distinguish "never authorized" from "token refused" — every probe
   * looks like "needs authorization", which is useless precisely when the user
   * has just finished authorizing.
   */
  tokenPresent?: boolean;
  /** The `error` parameter from the challenge, e.g. `invalid_token`. */
  challengeError?: string | undefined;
  /** The MCP server's canonical URI, for the audience remedy. */
  resource?: string;
  /** The authorization server issuer, for a server-specific remedy. */
  issuer?: string | undefined;
}

export const REQUIRED_EXPOSED_HEADERS = 'WWW-Authenticate, Mcp-Session-Id';

export function analyzeProbe(outcome: ProbeOutcome): Diagnosis {
  if (!outcome.corsRequestSucceeded) {
    if (outcome.reachable) {
      return {
        kind: 'cors',
        message:
          'The server is reachable but the browser blocked the request. It does not permit cross-origin requests from this page.',
        remedy: `${mcpEndpointCorsRemedy()}\n\n${NATIVE_CLIENT_NOTE}`,
      };
    }
    return {
      kind: 'network',
      message:
        'The server could not be reached at all. Check the endpoint IRI, and check that you are online.',
    };
  }

  const status = outcome.status ?? 0;

  if (status === 401 || status === 403) {
    // A token was sent and still bounced: this is no longer "needs auth".
    if (outcome.tokenPresent) {
      return {
        kind: 'token-rejected',
        message:
          outcome.challengeError === undefined
            ? 'The MCP server rejected the access token. Authorization completed, but the token is not accepted for this resource.'
            : `The MCP server rejected the access token (${outcome.challengeError}). Authorization completed, but the token is not accepted for this resource.`,
        remedy: tokenRejectedRemedy(outcome.resource ?? 'this MCP server', outcome.issuer),
      };
    }

    if (outcome.wwwAuthenticateReadable === false) {
      return {
        kind: 'needs-auth',
        message:
          'The server requires authorization, but the browser cannot read its WWW-Authenticate challenge. Discovery will fall back to probing the well-known URLs.',
        remedy:
          'The MCP server should add Access-Control-Expose-Headers: WWW-Authenticate so the client can read the resource_metadata hint and the required scopes.',
      };
    }
    return {
      kind: 'needs-auth',
      message: 'The server requires authorization, and no access token is stored for it yet.',
    };
  }

  if (status === 404) {
    return {
      kind: 'not-found',
      message:
        'No MCP endpoint at that address. Check the path — many servers expose MCP at /mcp rather than the root.',
    };
  }

  if (status >= 500) {
    return {
      kind: 'server-error',
      message: `The server returned HTTP ${status}. That is a fault on its side, not a configuration problem here.`,
    };
  }

  if (status >= 400) {
    return {
      kind: 'protocol',
      message: `The server rejected the MCP handshake with HTTP ${status}. It may not speak the Streamable HTTP transport.`,
    };
  }

  // The endpoint speaks MCP, so anything below is about what the *browser* is
  // allowed to send it. This is the case a plain probe used to call "ok" while
  // the connection kept failing.
  if (outcome.blockedRequestHeaders?.length) {
    const names = outcome.blockedRequestHeaders.map(canonicalHeaderName);
    return {
      kind: 'cors-headers',
      // Deliberately silent on whether the connection survived: ctbx drops the
      // header where it can, so this same verdict appears next to a connected
      // server and next to a failed one.
      message: `The endpoint answers a plain initialize request, but the browser blocks any request carrying ${names.join(' or ')} — ${names.length === 1 ? 'a header' : 'headers'} the MCP client sends on every request after the handshake. That is why the endpoint looks healthy to a single probe.`,
      remedy: blockedRequestHeaderRemedy(names),
    };
  }

  // Wording matters here: this probe is a single `initialize` POST. It says
  // nothing about whether a session can be maintained, so it must not claim to
  // be "connected" — that reads as a contradiction next to a failed connection.
  if (outcome.sessionIdReadable === false) {
    return {
      kind: 'ok',
      message:
        'The endpoint answered a single MCP initialize request. No Mcp-Session-Id came back with it.',
      remedy:
        'That is expected from a stateless MCP server and needs no action. If the server is stateful, it is missing Mcp-Session-Id from Access-Control-Expose-Headers — the browser then hides the session id, and every request after the handshake starts a new session.',
    };
  }

  return { kind: 'ok', message: 'The endpoint answered a single MCP initialize request.' };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiagnoseOptions {
  /** Stored access token, so the probe reflects the authenticated state. */
  token?: string | undefined;
  /** Authorization server issuer, for a server-specific remedy. */
  issuer?: string | undefined;
}

/**
 * Headers the differential probe tests one at a time, with the value the MCP
 * client would really send. Only the name reaches the preflight, but a
 * plausible value keeps the request itself valid if it does get through.
 */
const PROBED_HEADERS: Record<string, string> = {
  'MCP-Protocol-Version': '2025-06-18',
  'Mcp-Session-Id': 'ctbx-cors-probe',
};

/**
 * Repeats the request once per candidate header and reports the ones that turn
 * a working request into an opaque failure. Any HTTP answer — including 400 or
 * 404 for the made-up session id — means the browser allowed the header, which
 * is the only question being asked here.
 */
async function probeBlockedHeaders(
  url: string,
  fetchFn: FetchLike,
  headers: Record<string, string>,
  body: string
): Promise<string[]> {
  const results = await Promise.all(
    Object.entries(PROBED_HEADERS).map(async ([name, value]) => {
      try {
        await fetchFn(url, { method: 'POST', headers: { ...headers, [name]: value }, body });
        return undefined;
      } catch {
        return name;
      }
    })
  );
  return results.filter((name): name is string => name !== undefined);
}

/** Runs the probes and analyses the outcome. */
export async function diagnoseConnection(
  url: string,
  fetchFn: FetchLike = fetch,
  options: DiagnoseOptions = {}
): Promise<Diagnosis> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ctbx', version: '0.1.0' },
    },
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  try {
    const response = await fetchFn(url, { method: 'POST', headers, body });
    const challenge = response.headers.get('WWW-Authenticate');

    // Only worth asking once the endpoint has shown it answers at all: below
    // 400 the handshake worked, so a post-handshake header is the remaining
    // suspect. On a 401 the auth problem is the story and the extra requests
    // would just be noise.
    const blockedRequestHeaders =
      response.status < 400 ? await probeBlockedHeaders(url, fetchFn, headers, body) : [];

    return analyzeProbe({
      corsRequestSucceeded: true,
      status: response.status,
      wwwAuthenticateReadable: challenge !== null,
      sessionIdReadable: response.headers.get('Mcp-Session-Id') !== null,
      tokenPresent: options.token !== undefined,
      challengeError: extractChallengeError(challenge),
      resource: url,
      issuer: options.issuer,
      blockedRequestHeaders,
    });
  } catch {
    let reachable: boolean;
    try {
      await fetchFn(url, { method: 'POST', mode: 'no-cors', body });
      reachable = true;
    } catch {
      reachable = false;
    }
    return analyzeProbe({ corsRequestSucceeded: false, reachable });
  }
}
