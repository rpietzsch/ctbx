import { describe, expect, it, vi } from 'vitest';
import { analyzeProbe, diagnoseConnection } from './diagnostics';

describe('analyzeProbe', () => {
  it('reports CORS when the server is reachable but the browser blocked it', () => {
    const result = analyzeProbe({ corsRequestSucceeded: false, reachable: true });
    expect(result.kind).toBe('cors');
    expect(result.remedy).toContain('Access-Control-Allow-Origin');
    expect(result.remedy).toContain('Access-Control-Expose-Headers');
  });

  it('reports a network failure when the server is not reachable at all', () => {
    const result = analyzeProbe({ corsRequestSucceeded: false, reachable: false });
    expect(result.kind).toBe('network');
    expect(result.remedy).toBeUndefined();
  });

  it('distinguishes needs-auth from a hard failure', () => {
    expect(
      analyzeProbe({ corsRequestSucceeded: true, status: 401, wwwAuthenticateReadable: true }).kind
    ).toBe('needs-auth');
  });

  it('names the missing header when the auth challenge is unreadable', () => {
    const result = analyzeProbe({
      corsRequestSucceeded: true,
      status: 401,
      wwwAuthenticateReadable: false,
    });
    expect(result.kind).toBe('needs-auth');
    expect(result.remedy).toContain('Access-Control-Expose-Headers: WWW-Authenticate');
  });

  /**
   * The distinction that matters after a user has just authorized: probing
   * without the token reports "needs auth" for a token the server refused.
   */
  it('reports token-rejected when a token was sent and still bounced', () => {
    const result = analyzeProbe({
      corsRequestSucceeded: true,
      status: 401,
      wwwAuthenticateReadable: true,
      tokenPresent: true,
      challengeError: 'invalid_token',
      resource: 'https://mcp.example.com/mcp',
    });
    expect(result.kind).toBe('token-rejected');
    expect(result.message).toContain('invalid_token');
    expect(result.message).toMatch(/rejected the access token/i);
  });

  it('reports token-rejected even when the challenge names no error', () => {
    const result = analyzeProbe({
      corsRequestSucceeded: true,
      status: 401,
      wwwAuthenticateReadable: true,
      tokenPresent: true,
    });
    expect(result.kind).toBe('token-rejected');
  });

  it('explains audience binding in the token-rejected remedy', () => {
    const result = analyzeProbe({
      corsRequestSucceeded: true,
      status: 401,
      tokenPresent: true,
      resource: 'https://mcp.example.com/mcp',
    });
    expect(result.remedy).toMatch(/audience/i);
    expect(result.remedy).toContain('https://mcp.example.com/mcp');
  });

  it('gives Keycloak-specific audience advice when the issuer is Keycloak', () => {
    const result = analyzeProbe({
      corsRequestSucceeded: true,
      status: 401,
      tokenPresent: true,
      resource: 'https://mcp.example.com/mcp',
      issuer: 'https://host.example/auth/realms/cmem',
    });
    expect(result.remedy).toMatch(/RFC 8707/);
    expect(result.remedy).toMatch(/audience mapper/i);
  });

  it('still reports needs-auth when no token was sent', () => {
    const result = analyzeProbe({
      corsRequestSucceeded: true,
      status: 401,
      wwwAuthenticateReadable: true,
      tokenPresent: false,
    });
    expect(result.kind).toBe('needs-auth');
    expect(result.message).toMatch(/no access token is stored/i);
  });

  it('treats 403 as needing authorization too', () => {
    expect(
      analyzeProbe({ corsRequestSucceeded: true, status: 403, wwwAuthenticateReadable: true }).kind
    ).toBe('needs-auth');
  });

  it('suggests a path fix on 404', () => {
    const result = analyzeProbe({ corsRequestSucceeded: true, status: 404 });
    expect(result.kind).toBe('not-found');
    expect(result.message).toContain('/mcp');
  });

  it('attributes 5xx to the server, not the configuration', () => {
    const result = analyzeProbe({ corsRequestSucceeded: true, status: 503 });
    expect(result.kind).toBe('server-error');
    expect(result.message).toContain('503');
  });

  it('reports other 4xx as a protocol mismatch', () => {
    expect(analyzeProbe({ corsRequestSucceeded: true, status: 400 }).kind).toBe('protocol');
  });

  it('warns when the session header is not exposed, but still reports success', () => {
    const result = analyzeProbe({
      corsRequestSucceeded: true,
      status: 200,
      sessionIdReadable: false,
    });
    expect(result.kind).toBe('ok');
    expect(result.remedy).toContain('Mcp-Session-Id');
  });

  /**
   * The probe is one `initialize` POST. Claiming to be "connected" contradicts
   * the error banner whenever the client failed on a later request.
   */
  it('never claims to be connected, since it only made one request', () => {
    for (const sessionIdReadable of [true, false]) {
      const result = analyzeProbe({ corsRequestSucceeded: true, status: 200, sessionIdReadable });
      expect(result.message).not.toMatch(/^Connected/);
      expect(result.message).toMatch(/answered a single MCP initialize request/i);
    }
  });

  it('reports a clean connection with no remedy', () => {
    const result = analyzeProbe({
      corsRequestSucceeded: true,
      status: 200,
      sessionIdReadable: true,
    });
    expect(result.kind).toBe('ok');
    expect(result.remedy).toBeUndefined();
  });

  /**
   * The verdict that used to be missing: the handshake works, so the old probe
   * said "ok" while the connection kept dying on the next request.
   */
  it('names the blocked header instead of calling the endpoint ok', () => {
    const result = analyzeProbe({
      corsRequestSucceeded: true,
      status: 200,
      sessionIdReadable: true,
      blockedRequestHeaders: ['MCP-Protocol-Version'],
    });
    expect(result.kind).toBe('cors-headers');
    expect(result.message).toContain('MCP-Protocol-Version');
    expect(result.remedy).toContain('Access-Control-Allow-Headers');
  });

  it('says a blocked session header cannot be worked around', () => {
    const result = analyzeProbe({
      corsRequestSucceeded: true,
      status: 200,
      blockedRequestHeaders: ['MCP-Protocol-Version', 'Mcp-Session-Id'],
    });
    expect(result.kind).toBe('cors-headers');
    expect(result.remedy).toMatch(/stateful server cannot be used from a browser/i);
  });

  /**
   * A stateless MCP server never sends a session id, and that is fine. The old
   * wording accused every such server of a CORS misconfiguration.
   */
  it('does not accuse a stateless server of hiding its session id', () => {
    const result = analyzeProbe({
      corsRequestSucceeded: true,
      status: 200,
      sessionIdReadable: false,
    });
    expect(result.remedy).toMatch(/stateless MCP server and needs no action/i);
  });
});

describe('diagnoseConnection', () => {
  it('reports ok for a healthy server', async () => {
    const fetchFn = vi.fn(
      async () => new Response('{}', { status: 200, headers: { 'Mcp-Session-Id': 'session-1' } })
    );
    await expect(diagnoseConnection('https://mcp.example.com/mcp', fetchFn)).resolves.toMatchObject(
      {
        kind: 'ok',
      }
    );
  });

  it('detects an auth requirement with an unreadable challenge', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 401 }));
    await expect(diagnoseConnection('https://mcp.example.com/mcp', fetchFn)).resolves.toMatchObject(
      { kind: 'needs-auth', remedy: expect.stringContaining('WWW-Authenticate') }
    );
  });

  it('uses the no-cors probe to identify a CORS rejection', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      // A real no-cors probe resolves with an opaque response (type 'opaque',
      // status 0). Response cannot be constructed with status 0, and the code
      // only cares that the probe resolves at all, so stand in with a 200.
      if (init?.mode === 'no-cors') return new Response('', { status: 200 });
      throw new TypeError('Failed to fetch');
    });

    const result = await diagnoseConnection('https://mcp.example.com/mcp', fetchFn);

    expect(result.kind).toBe('cors');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('reports a network failure when both probes fail', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(diagnoseConnection('https://mcp.example.com/mcp', fetchFn)).resolves.toMatchObject(
      { kind: 'network' }
    );
  });

  it('sends the stored token and reads the challenge error', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer realm="x", error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        })
    );

    const result = await diagnoseConnection('https://mcp.example.com/mcp', fetchFn, {
      token: 'stored-token',
      issuer: 'https://host.example/auth/realms/cmem',
    });

    const headers = (fetchFn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer stored-token');
    expect(result.kind).toBe('token-rejected');
    expect(result.message).toContain('invalid_token');
  });

  it('sends no Authorization header when no token is stored', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('', { status: 401 })
    );
    await diagnoseConnection('https://mcp.example.com/mcp', fetchFn);
    const headers = (fetchFn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  /**
   * The differential probe: same request, once with the header the MCP client
   * adds after the handshake. Succeeding without it and failing with it is what
   * turns the remedy from a guess into a measurement.
   */
  it('isolates a request header the browser refuses to send', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.has('MCP-Protocol-Version')) throw new TypeError('Failed to fetch');
      return new Response('{}', { status: 200, headers: { 'Mcp-Session-Id': 'session-1' } });
    });

    const result = await diagnoseConnection('https://mcp.example.com/mcp', fetchFn);

    expect(result.kind).toBe('cors-headers');
    expect(result.message).toContain('MCP-Protocol-Version');
    expect(result.message).not.toContain('Mcp-Session-Id');
  });

  it('does not run the differential probe when the endpoint answered 401', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 401 }));
    await diagnoseConnection('https://mcp.example.com/mcp', fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('sends a real MCP initialize request', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 })
    );
    await diagnoseConnection('https://mcp.example.com/mcp', fetchFn);

    const body = JSON.parse(String((fetchFn.mock.calls[0]![1] as RequestInit).body));
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'initialize' });
  });
});
