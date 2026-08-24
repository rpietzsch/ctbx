import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  challengeHeaderOf,
  describeHandshakeOnlyFailure,
  isMethodNotAllowed,
  isUnauthorized,
  issuerStore,
  McpConnection,
} from './connection';
import {
  peekPendingRequest,
  readTokens,
  savePendingRequest,
  writeClient,
  writeTokens,
} from './auth/token-store';

/** Signature is never checked, so any header and signature will do. */
function idToken(claims: Record<string, unknown>): string {
  const body = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(claims))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${body}.signature`;
}

/**
 * The case a one-shot probe cannot see: `initialize` succeeds, so an HTTP probe
 * reports "ok", but the MCP client still fails because the browser blocks the
 * headers it sends on every subsequent request. Reporting the probe's verdict
 * there produced a red box reading "Connected, but …", which is nonsense.
 */
describe('describeHandshakeOnlyFailure', () => {
  const message = describeHandshakeOnlyFailure(new Error('SSE stream closed'));

  it('does not claim the connection succeeded', () => {
    expect(message).not.toMatch(/^Connected/);
    expect(message).toMatch(/could not be established/i);
  });

  it('names the headers that fail only after the handshake', () => {
    expect(message).toContain('MCP-Protocol-Version');
    expect(message).toContain('Mcp-Session-Id');
  });

  it('explains the first-request-works symptom', () => {
    expect(message).toMatch(/first request appears to succeed/i);
  });

  it('includes the required CORS configuration', () => {
    expect(message).toContain('Access-Control-Allow-Headers');
    expect(message).toContain('Access-Control-Expose-Headers');
  });

  it('preserves the underlying transport error', () => {
    expect(message).toContain('SSE stream closed');
  });

  it('handles a non-Error rejection', () => {
    expect(describeHandshakeOnlyFailure('plain string')).toContain('plain string');
  });

  /**
   * Once the client has already retried without the blocked headers, repeating
   * the CORS advice sends the operator after a problem that is handled. Say the
   * theory was tested and ruled out instead.
   */
  describe('when headers were already dropped and it still failed', () => {
    const retried = describeHandshakeOnlyFailure(new TypeError('Failed to fetch'), [
      'mcp-protocol-version',
    ]);

    it('rules out the header theory rather than repeating it', () => {
      expect(retried).toMatch(/not the usual CORS header problem/i);
      expect(retried).toMatch(/retrying without it did not help/i);
      expect(retried).not.toContain('Access-Control-Allow-Headers');
    });

    it('names the header the way a CORS configuration spells it', () => {
      expect(retried).toContain('MCP-Protocol-Version');
    });
  });
});

describe('isUnauthorized', () => {
  it('recognises a 401 in the message', () => {
    expect(isUnauthorized(new Error('HTTP 401 Unauthorized'))).toBe(true);
  });

  it('recognises a status property', () => {
    expect(isUnauthorized({ status: 401 })).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isUnauthorized(new Error('connection reset'))).toBe(false);
  });
});

describe('isMethodNotAllowed', () => {
  it('recognises a 405, which means falling back to the legacy SSE transport', () => {
    expect(isMethodNotAllowed(new Error('HTTP 405 Method Not Allowed'))).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isMethodNotAllowed(new Error('HTTP 500'))).toBe(false);
  });
});

describe('challengeHeaderOf', () => {
  it('reads WWW-Authenticate off an error carrying headers', () => {
    const error = { headers: new Headers({ 'WWW-Authenticate': 'Bearer error="invalid_token"' }) };
    expect(challengeHeaderOf(error)).toContain('invalid_token');
  });

  it('reads it from a nested response', () => {
    const error = { response: { headers: new Headers({ 'WWW-Authenticate': 'Bearer' }) } };
    expect(challengeHeaderOf(error)).toBe('Bearer');
  });

  it('returns null when there is nothing to read', () => {
    expect(challengeHeaderOf(new Error('boom'))).toBeNull();
    expect(challengeHeaderOf(null)).toBeNull();
  });
});

/**
 * The second half of callback routing. The manager dispatches by `serverId`,
 * but the guard lives here too: consuming a record is destructive, so a
 * connection must refuse one that names a different server rather than trust
 * that it was called correctly.
 */
describe('McpConnection.completeAuthorization', () => {
  const STATE = 'state-belonging-to-srv-2';

  beforeEach(() => {
    localStorage.clear();
    savePendingRequest({
      serverId: 'srv-2',
      state: STATE,
      codeVerifier: 'verifier',
      expectedIssuer: 'https://auth.example.com',
      issParameterSupported: false,
      resource: 'https://x/mcp',
      createdAt: Date.now(),
    });
  });

  /**
   * Enough of an authorization server to get past discovery and the token
   * exchange. Whatever the connection attempt does afterwards is beside the
   * point here — these tests are about which server consumes the record.
   */
  const fetchFn = (async (url: string) => {
    if (url.includes('/.well-known/')) {
      return new Response(
        JSON.stringify({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url === 'https://auth.example.com/token') {
      return new Response(
        JSON.stringify({
          access_token: 'token-for-srv-2',
          expires_in: 3600,
          id_token: idToken({ sub: 'abc', preferred_username: 'user-b' }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  function connectionFor(id: string) {
    return new McpConnection(
      { id, name: id, url: 'https://x/mcp', enabled: true, autoConnect: false },
      fetchFn
    );
  }

  it('leaves another server’s pending request unconsumed', async () => {
    await connectionFor('srv-1').completeAuthorization({ code: 'abc', state: STATE });
    expect(peekPendingRequest(STATE)?.serverId).toBe('srv-2');
  });

  it('does not report the foreign response as its own failure', async () => {
    const connection = connectionFor('srv-1');
    await connection.completeAuthorization({ code: 'abc', state: STATE });
    expect(connection.state).toBe('disconnected');
    expect(connection.getSnapshot().error).toBeUndefined();
  });

  it('consumes the request and stores the token when it is the addressee', async () => {
    writeClient('srv-2', 'https://auth.example.com', { client_id: 'cimd', source: 'cimd' });

    await connectionFor('srv-2').completeAuthorization({ code: 'abc', state: STATE });

    expect(peekPendingRequest(STATE)).toBeUndefined();
    expect(readTokens('srv-2', 'https://auth.example.com')?.access_token).toBe('token-for-srv-2');
  });

  /** Without this the two connections are indistinguishable on screen. */
  it('records which account the login was for', async () => {
    writeClient('srv-2', 'https://auth.example.com', { client_id: 'cimd', source: 'cimd' });

    await connectionFor('srv-2').completeAuthorization({ code: 'abc', state: STATE });

    expect(readTokens('srv-2', 'https://auth.example.com')?.account).toEqual({
      subject: 'abc',
      label: 'user-b',
      source: 'id_token',
    });
  });

  /** The binding the whole guard exists to protect. */
  it('never lands another server’s token in this server’s slot', async () => {
    writeClient('srv-1', 'https://auth.example.com', { client_id: 'cimd', source: 'cimd' });

    await connectionFor('srv-1').completeAuthorization({ code: 'abc', state: STATE });

    expect(readTokens('srv-1', 'https://auth.example.com')).toBeUndefined();
  });
});

/**
 * A refresh response carries no ID token, and userinfo is usually unreachable
 * from a browser. If the account were dropped on renewal, the label the user
 * relies on to tell two accounts apart would vanish a few minutes into every
 * session.
 */
describe('McpConnection account across refresh', () => {
  const ISSUER = 'https://auth.example.com';
  const NOW = Date.now();
  const ACCOUNT = { subject: 'abc', label: 'user-a', source: 'id_token' as const };

  const fetchFn = (async (url: string) => {
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
      // No id_token, as on a plain refresh.
      return new Response(JSON.stringify({ access_token: 'renewed', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  beforeEach(() => {
    localStorage.clear();
    issuerStore.set({ 'srv-1': ISSUER });
    writeClient('srv-1', ISSUER, { client_id: 'cimd', source: 'cimd' });
    writeTokens('srv-1', ISSUER, {
      access_token: 'expired',
      token_type: 'Bearer',
      refresh_token: 'refresh-1',
      obtainedAt: NOW - 7_200_000,
      expiresAt: NOW - 3_600_000,
      account: ACCOUNT,
    });
  });

  it('renews the token', async () => {
    await new McpConnection(
      { id: 'srv-1', name: 'A', url: 'https://x/mcp', enabled: true, autoConnect: false },
      fetchFn
    ).connect();

    expect(readTokens('srv-1', ISSUER)?.access_token).toBe('renewed');
  });

  it('keeps the account the login established', async () => {
    await new McpConnection(
      { id: 'srv-1', name: 'A', url: 'https://x/mcp', enabled: true, autoConnect: false },
      fetchFn
    ).connect();

    expect(readTokens('srv-1', ISSUER)?.account).toEqual(ACCOUNT);
  });
});

/**
 * Signing out is what makes `prompt` reachable: `connect()` reuses a stored
 * token, so while one is held `authorize()` never runs and the sign-in setting
 * has nothing to act on.
 */
describe('McpConnection.signOut', () => {
  const ISSUER = 'https://auth.example.com';

  /** Serves AS metadata so the logout URL can be built. */
  const fetchFn = (async (url: string) => {
    if (url.includes('/.well-known/')) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          end_session_endpoint: `${ISSUER}/logout`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  function stored() {
    issuerStore.set({ 'srv-1': ISSUER });
    writeClient('srv-1', ISSUER, { client_id: 'cimd', source: 'cimd' });
    writeTokens('srv-1', ISSUER, {
      access_token: 'held',
      token_type: 'Bearer',
      obtainedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      account: { subject: 'abc', label: 'user-a', source: 'id_token' },
      id_token: 'the-id-token',
    });
    return new McpConnection(
      { id: 'srv-1', name: 'A', url: 'https://x/mcp', enabled: true, autoConnect: false },
      fetchFn
    );
  }

  beforeEach(() => {
    localStorage.clear();
    // Every path ends by closing the popup it opened; a stub that reports
    // itself closed lets signOut finish without a real window.
    vi.stubGlobal(
      'open',
      vi.fn(() => ({ closed: true, close: vi.fn() }))
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  /**
   * The bug this exists for: clearing the token locally left the authorization
   * server's own session untouched, so the next authorization was answered from
   * it silently and came back as the same user.
   */
  it('ends the session at the authorization server, not just locally', async () => {
    await stored().signOut();

    const opened = vi.mocked(globalThis.open).mock.calls[0]?.[0];
    const url = new URL(String(opened));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/logout`);
    expect(url.searchParams.get('id_token_hint')).toBe('the-id-token');
  });

  it('falls back to a full-page redirect when the popup is blocked', async () => {
    vi.stubGlobal(
      'open',
      vi.fn(() => null)
    );
    const assign = vi.fn();
    // origin and pathname included because the post-logout redirect URI is
    // derived from them.
    vi.stubGlobal('location', { assign, origin: 'https://app.example.com', pathname: '/ctbx/' });

    await stored().signOut();

    expect(String(assign.mock.calls[0]?.[0])).toContain(`${ISSUER}/logout`);
  });

  it('still clears local credentials when the server publishes no logout endpoint', async () => {
    const bare = (async () =>
      new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as unknown as typeof fetch;

    issuerStore.set({ 'srv-1': ISSUER });
    writeClient('srv-1', ISSUER, { client_id: 'cimd', source: 'cimd' });
    writeTokens('srv-1', ISSUER, {
      access_token: 'held',
      token_type: 'Bearer',
      obtainedAt: Date.now(),
    });

    await new McpConnection(
      { id: 'srv-1', name: 'A', url: 'https://x/mcp', enabled: true, autoConnect: false },
      bare
    ).signOut();

    expect(readTokens('srv-1', ISSUER)).toBeUndefined();
    expect(globalThis.open).not.toHaveBeenCalled();
  });

  it('discards the stored token', async () => {
    await stored().signOut();
    expect(readTokens('srv-1', ISSUER)).toBeUndefined();
  });

  it('asks for authorization rather than leaving the user to discover it', async () => {
    const connection = stored();
    await connection.signOut();
    expect(connection.state).toBe('needs-auth');
  });

  it('stops claiming a token and an account it no longer holds', async () => {
    const connection = stored();
    await connection.connect();
    await connection.signOut();

    const snapshot = connection.getSnapshot();
    expect(snapshot.hasToken).toBe(false);
    expect(snapshot.account).toBeUndefined();
    expect(snapshot.tokenExpiresAt).toBeUndefined();
  });

  /** Reconnecting has to be free, so a plain disconnect must not sign out. */
  it('is not what a plain disconnect does', async () => {
    const connection = stored();
    await connection.disconnect();

    expect(readTokens('srv-1', ISSUER)?.access_token).toBe('held');
    expect(connection.getSnapshot().account?.label).toBe('user-a');
  });
});

/** So the page can say which account a server holds before anything connects. */
describe('McpConnection initial snapshot', () => {
  const ISSUER = 'https://auth.example.com';

  beforeEach(() => localStorage.clear());

  function connection() {
    return new McpConnection({
      id: 'srv-1',
      name: 'A',
      url: 'https://x/mcp',
      enabled: true,
      autoConnect: false,
    });
  }

  it('reports the stored account without connecting first', () => {
    issuerStore.set({ 'srv-1': ISSUER });
    writeTokens('srv-1', ISSUER, {
      access_token: 'held',
      token_type: 'Bearer',
      obtainedAt: Date.now(),
      account: { subject: 'abc', label: 'user-a', source: 'id_token' },
    });

    const snapshot = connection().getSnapshot();
    expect(snapshot.hasToken).toBe(true);
    expect(snapshot.account?.label).toBe('user-a');
    expect(snapshot.issuer).toBe(ISSUER);
  });

  it('claims no token when none is stored', () => {
    expect(connection().getSnapshot().hasToken).toBe(false);
  });
});
