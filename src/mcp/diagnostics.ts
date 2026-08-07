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
 * The decision logic is pure and exhaustively tested; only `probe` touches the
 * network.
 */

import { mcpEndpointCorsRemedy, NATIVE_CLIENT_NOTE } from './cors-remedy';

export type DiagnosisKind =
  'ok' | 'needs-auth' | 'cors' | 'network' | 'not-found' | 'server-error' | 'protocol';

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
    if (outcome.wwwAuthenticateReadable === false) {
      return {
        kind: 'needs-auth',
        message:
          'The server requires authorization, but the browser cannot read its WWW-Authenticate challenge. Discovery will fall back to probing the well-known URLs.',
        remedy:
          'The MCP server should add Access-Control-Expose-Headers: WWW-Authenticate so the client can read the resource_metadata hint and the required scopes.',
      };
    }
    return { kind: 'needs-auth', message: 'The server requires authorization.' };
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

  if (outcome.sessionIdReadable === false) {
    return {
      kind: 'ok',
      message: 'Connected, but the session header is not readable, so sessions cannot be resumed.',
      remedy:
        'The MCP server should add Mcp-Session-Id to Access-Control-Expose-Headers to allow session resumption across reloads.',
    };
  }

  return { kind: 'ok', message: 'The server responded correctly.' };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Runs the two probes and analyses the outcome. */
export async function diagnoseConnection(
  url: string,
  fetchFn: FetchLike = fetch
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

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body,
    });

    return analyzeProbe({
      corsRequestSucceeded: true,
      status: response.status,
      wwwAuthenticateReadable: response.headers.get('WWW-Authenticate') !== null,
      sessionIdReadable: response.headers.get('Mcp-Session-Id') !== null,
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
