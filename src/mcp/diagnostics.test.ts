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

  it('reports a clean connection with no remedy', () => {
    const result = analyzeProbe({
      corsRequestSucceeded: true,
      status: 200,
      sessionIdReadable: true,
    });
    expect(result.kind).toBe('ok');
    expect(result.remedy).toBeUndefined();
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

  it('sends a real MCP initialize request', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 })
    );
    await diagnoseConnection('https://mcp.example.com/mcp', fetchFn);

    const body = JSON.parse(String((fetchFn.mock.calls[0]![1] as RequestInit).body));
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'initialize' });
  });
});
