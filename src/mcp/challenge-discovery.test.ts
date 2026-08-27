import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isUnauthorized, issuerStore, McpConnection } from './connection';

/**
 * The path-mounted server that exposed this: its OAuth metadata lives under the
 * application's own prefix, so the origin-root well-known URLs are 404 and the
 * `resource_metadata` hint in the 401 challenge is the only route to it.
 */
const SERVER_URL = 'http://localhost/dataplatform/mcp/streamable';
const PRM_URL = 'http://localhost/dataplatform/.well-known/oauth-protected-resource';
const ISSUER = 'http://localhost/dataplatform/auth/realms/cmem';
const AS_METADATA_URL =
  'http://localhost/.well-known/oauth-authorization-server/dataplatform/auth/realms/cmem';

const CHALLENGE = `Bearer realm="cmem", resource_metadata="${PRM_URL}"`;

/**
 * The shape the MCP SDK actually throws: the status arrives as `code`, and the
 * response — headers included — is gone by the time it reaches us.
 */
class StreamableHTTPError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string | undefined
  ) {
    super(`Streamable HTTP error: ${message}`);
    this.name = 'StreamableHTTPError';
  }
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('isUnauthorized', () => {
  it('recognises the status the SDK reports as `code`', () => {
    expect(isUnauthorized(new StreamableHTTPError(401, 'Error POSTing to endpoint: '))).toBe(true);
  });

  /**
   * The regression proper: matching only on the message meant a 401 was
   * recognised or not depending on what the server put in the body.
   */
  it('does not depend on the response body naming the status', () => {
    const quiet = new StreamableHTTPError(
      401,
      'Error POSTing to endpoint: {"error":"invalid_token","error_description":"Token verification failed"}'
    );
    expect(isUnauthorized(quiet)).toBe(true);
  });

  it('still rejects failures that are not 401s', () => {
    expect(isUnauthorized(new StreamableHTTPError(500, 'Error POSTing to endpoint: boom'))).toBe(
      false
    );
    expect(isUnauthorized(new Error('SSE stream closed'))).toBe(false);
  });
});

describe('authorizing a server whose metadata is only named by the challenge', () => {
  const seen: string[] = [];

  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    seen.push(url);

    if (url === SERVER_URL) {
      return new Response('', { status: 401, headers: { 'WWW-Authenticate': CHALLENGE } });
    }
    if (url === PRM_URL) {
      return json({
        resource: SERVER_URL,
        authorization_servers: [ISSUER],
        scopes_supported: ['openid'],
      });
    }
    if (url === AS_METADATA_URL) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        client_id_metadata_document_supported: true,
      });
    }
    // Every origin-root well-known URL, which is what discovery used to have to
    // rely on.
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  function connection() {
    return new McpConnection(
      {
        id: 'srv-prefix',
        name: 'dataplatform',
        url: SERVER_URL,
        enabled: true,
        autoConnect: false,
      },
      fetchFn
    );
  }

  beforeEach(() => {
    localStorage.clear();
    issuerStore.set({});
    seen.length = 0;
    // The authorization popup is unavailable under jsdom, so the flow takes the
    // redirect branch. Reaching it at all is the assertion.
    vi.spyOn(globalThis, 'open').mockReturnValue(null);
  });

  /**
   * Authorize straight from a restored page, with no connection attempt behind
   * it — the state in which nothing has captured a challenge.
   */
  it('reads the challenge itself rather than falling back to the origin root', async () => {
    const conn = connection();
    const states: string[] = [];
    conn.subscribe((snapshot) => states.push(snapshot.state));

    await conn.authorize();

    expect(seen).toContain(PRM_URL);
    expect(conn.getSnapshot().error).toBeUndefined();
    expect(states.at(-1)).not.toBe('needs-auth');
  });

  it('does not blame the operator for metadata the server does publish', async () => {
    const conn = connection();
    await conn.authorize();

    expect(conn.getSnapshot().error ?? '').not.toMatch(/lists no authorization server/i);
  });

  it('captures the challenge from the probe when a connection fails', async () => {
    const conn = connection();
    await conn.connect().catch(() => {});
    seen.length = 0;

    await conn.authorize();

    // Straight to the hinted document: the challenge was already in hand, so no
    // second probe of the endpoint was needed.
    expect(seen[0]).toBe(PRM_URL);
  });
});
