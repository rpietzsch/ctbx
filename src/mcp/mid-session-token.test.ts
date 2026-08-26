import { beforeEach, describe, expect, it } from 'vitest';
import { issuerStore, McpConnection } from './connection';
import { readTokens, writeClient, writeTokens } from './auth/token-store';

/**
 * The failure a chat session actually hits: tool calls succeed, the access
 * token quietly expires, and every call after it is rejected — while the
 * connection still reports itself connected and the model, seeing only an
 * unexplained 401, reports that its access was revoked.
 *
 * Exercised through a stand-in MCP endpoint rather than a mocked transport,
 * because what broke was which token reached the wire, and that is only
 * observable there.
 */

const ISSUER = 'https://auth.example.com';
const MCP_URL = 'https://mcp.example.com/mcp';
const SERVER_ID = 'srv-1';

interface Recorded {
  method: string;
  authorization: string | null;
}

/** A minimal Streamable HTTP MCP endpoint that checks the bearer token. */
function mcpEndpoint(options: { validToken: () => string; recorded: Recorded[] }) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    if (url.startsWith(`${ISSUER}/`) || url.includes('/.well-known/')) {
      return authorizationServer(url);
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; id?: number };
    const authorization = new Headers(init?.headers).get('Authorization');
    options.recorded.push({ method: body.method, authorization });

    if (authorization !== `Bearer ${options.validToken()}`) {
      return new Response('token expired', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      });
    }

    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });

    return jsonRpc(body.id, resultFor(body.method));
  };
}

function resultFor(method: string): unknown {
  if (method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'stand-in', version: '1.0.0' },
    };
  }
  if (method === 'tools/list') {
    return { tools: [{ name: 'query', inputSchema: { type: 'object' } }] };
  }
  return { content: [{ type: 'text', text: 'ok' }] };
}

function jsonRpc(id: number | undefined, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let renewals = 0;
let renewalSucceeds = true;

function authorizationServer(url: string): Response {
  if (url.includes('/.well-known/')) {
    return new Response(
      JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (url === `${ISSUER}/token`) {
    if (!renewalSucceeds) return new Response('{"error":"invalid_grant"}', { status: 400 });
    renewals += 1;
    return new Response(
      JSON.stringify({
        access_token: `renewed-${renewals}`,
        refresh_token: `refresh-${renewals + 1}`,
        expires_in: 3600,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response('', { status: 404 });
}

function connection(fetchFn: unknown): McpConnection {
  return new McpConnection(
    { id: SERVER_ID, name: 'Corporate Memory', url: MCP_URL, enabled: true, autoConnect: false },
    fetchFn as typeof fetch
  );
}

function storeTokens(patch: Partial<Parameters<typeof writeTokens>[2]> = {}): void {
  const now = Date.now();
  writeTokens(SERVER_ID, ISSUER, {
    access_token: 'original',
    token_type: 'Bearer',
    refresh_token: 'refresh-1',
    obtainedAt: now,
    expiresAt: now + 3_600_000,
    ...patch,
  });
}

beforeEach(() => {
  localStorage.clear();
  renewals = 0;
  renewalSucceeds = true;
  issuerStore.set({ [SERVER_ID]: ISSUER });
  writeClient(SERVER_ID, ISSUER, { client_id: 'cimd', source: 'cimd' });
  storeTokens();
});

describe('a token that expires while the session is open', () => {
  it('is renewed, and the tool call goes out on the new token', async () => {
    const recorded: Recorded[] = [];
    // The endpoint stops accepting the original the moment it is renewed —
    // exactly what an expiry looks like from the client's side.
    let valid = 'original';
    const mcp = connection(mcpEndpoint({ validToken: () => valid, recorded }));

    await mcp.connect();
    expect(mcp.state).toBe('connected');

    valid = 'renewed-1';
    const result = await mcp.callTool('query', {});

    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(mcp.state).toBe('connected');
    expect(readTokens(SERVER_ID, ISSUER)?.access_token).toBe('renewed-1');
  });

  it('does not keep sending the token the connection was opened with', async () => {
    const recorded: Recorded[] = [];
    let valid = 'original';
    const mcp = connection(mcpEndpoint({ validToken: () => valid, recorded }));

    await mcp.connect();
    valid = 'renewed-1';
    await mcp.callTool('query', {});

    const calls = recorded.filter((entry) => entry.method === 'tools/call');
    expect(calls.at(-1)?.authorization).toBe('Bearer renewed-1');
  });

  it('renews once for several tool calls made at the same time', async () => {
    const recorded: Recorded[] = [];
    let valid = 'original';
    const mcp = connection(mcpEndpoint({ validToken: () => valid, recorded }));

    await mcp.connect();
    valid = 'renewed-1';
    await Promise.all([mcp.callTool('query', {}), mcp.callTool('query', {})]);

    // A refresh per call would, against a server that rotates refresh tokens,
    // leave every attempt after the first holding a spent one.
    expect(renewals).toBe(1);
  });

  it('renews ahead of expiry once the token is mostly spent', async () => {
    const recorded: Recorded[] = [];
    const now = Date.now();
    // 90 % through a one-hour lifetime: past the refresh threshold, not expired.
    storeTokens({ obtainedAt: now - 3_240_000, expiresAt: now + 360_000 });

    const mcp = connection(mcpEndpoint({ validToken: () => 'renewed-1', recorded }));
    await mcp.connect();

    expect(mcp.state).toBe('connected');
    expect(recorded.every((entry) => entry.authorization === 'Bearer renewed-1')).toBe(true);
  });
});

describe('a token that cannot be renewed', () => {
  it('is reported as an expired sign-in, not as a permissions change', async () => {
    const recorded: Recorded[] = [];
    let valid = 'original';
    const mcp = connection(mcpEndpoint({ validToken: () => valid, recorded }));
    await mcp.connect();

    valid = 'something-else';
    renewalSucceeds = false;
    const rejected = await mcp.callTool('query', {}).catch((error: Error) => error);

    expect((rejected as Error).name).toBe('AuthorizationRequiredError');
    expect((rejected as Error).message).toMatch(/no longer authorized/i);
    // The wording the model reads has to rule out the wrong explanation, which
    // is the one a bare 401 invites.
    expect((rejected as Error).message).toMatch(/not a change to what this account may access/i);
  });

  it('stops the connection claiming to be connected', async () => {
    const recorded: Recorded[] = [];
    let valid = 'original';
    const mcp = connection(mcpEndpoint({ validToken: () => valid, recorded }));
    await mcp.connect();

    valid = 'something-else';
    renewalSucceeds = false;
    await mcp.callTool('query', {}).catch(() => undefined);

    // Left `connected`, its tools stay in the set handed to the model on the
    // next turn and every one of them fails the same way.
    expect(mcp.state).toBe('needs-auth');
  });
});

describe('the renewal request', () => {
  it('names the same resource the grant was issued for', async () => {
    const requests: string[] = [];
    const now = Date.now();
    storeTokens({ obtainedAt: now - 7_200_000, expiresAt: now - 3_600_000 });

    const base = mcpEndpoint({ validToken: () => 'renewed-1', recorded: [] });
    const mcp = connection(async (input: string | URL, init?: RequestInit) => {
      if (String(input) === `${ISSUER}/token`) requests.push(String(init?.body ?? ''));
      return base(input, init);
    });

    // Configured with a trailing slash; the authorization request canonicalises
    // it away, so a renewal that sends the raw URL asks for a different
    // audience than the one that was granted.
    mcp.config = { ...mcp.config, url: `${MCP_URL}/` };
    await mcp.connect();

    expect(requests).toHaveLength(1);
    expect(new URLSearchParams(requests[0]!).get('resource')).toBe(MCP_URL);
  });
});
