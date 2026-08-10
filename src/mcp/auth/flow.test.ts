import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthFlowError,
  beginAuthorization,
  discoverAuthorizationServerMetadata,
  discoverIssuerAtResourceOrigin,
  discoverProtectedResourceMetadata,
  exchangeAuthorizationCode,
  refreshAccessToken,
  resolveClient,
  revokeToken,
  selectAuthorizationServer,
  type AuthorizationServerMetadata,
  type FetchLike,
} from './flow';
import { pendingAuthStore, takePendingRequest } from './token-store';
import { deriveCodeChallenge } from './pkce';

const NOW = 1_700_000_000_000;
const MCP_URL = 'https://mcp.example.com/mcp';
const ISSUER = 'https://auth.example.com';
const REDIRECT_URI = 'https://rpietzsch.github.io/ctbx/oauth/callback.html';
const CIMD_URL = 'https://rpietzsch.github.io/ctbx/oauth/client-metadata.json';

const AS_METADATA: AuthorizationServerMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
};

/** The rejection of a promise, typed, so a message can be asserted on. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject');
}

/** Builds a fetch double from a map of URL → response. */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>): FetchLike {
  return vi.fn(async (url: string) => {
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

beforeEach(() => {
  localStorage.clear();
  pendingAuthStore.remove();
});

describe('discoverProtectedResourceMetadata', () => {
  const metadata = { authorization_servers: [ISSUER], scopes_supported: ['files:read'] };

  it('follows the resource_metadata hint from WWW-Authenticate', async () => {
    const hint = 'https://mcp.example.com/.well-known/oauth-protected-resource';
    const fetchFn = fakeFetch({ [hint]: { body: metadata } });

    const result = await discoverProtectedResourceMetadata(
      MCP_URL,
      `Bearer resource_metadata="${hint}"`,
      fetchFn
    );

    expect(result.source).toBe('header');
    expect(result.metadata.authorization_servers).toEqual([ISSUER]);
  });

  it('falls back to the path-specific well-known URL when the header is unreadable', async () => {
    // The CORS case from spec §9.1: header not exposed, so it arrives as null.
    const fetchFn = fakeFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': { body: metadata },
    });

    const result = await discoverProtectedResourceMetadata(MCP_URL, null, fetchFn);

    expect(result.source).toBe('well-known');
  });

  it('falls back to the root well-known URL when the path-specific one 404s', async () => {
    const fetchFn = fakeFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource': { body: metadata },
    });

    const result = await discoverProtectedResourceMetadata(MCP_URL, null, fetchFn);

    expect(result.source).toBe('well-known');
  });

  it('falls back to well-known when the hinted URL itself fails', async () => {
    const hint = 'https://mcp.example.com/broken';
    const fetchFn = fakeFetch({
      [hint]: { status: 500 },
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': { body: metadata },
    });

    const result = await discoverProtectedResourceMetadata(
      MCP_URL,
      `Bearer resource_metadata="${hint}"`,
      fetchFn
    );

    expect(result.source).toBe('well-known');
  });

  it('reports a diagnosable error when nothing is published', async () => {
    await expect(
      discoverProtectedResourceMetadata(MCP_URL, null, fakeFetch({}))
    ).rejects.toMatchObject({ code: 'no-protected-resource-metadata' });
  });
});

describe('discoverAuthorizationServerMetadata', () => {
  it('uses the first candidate URL that validates', async () => {
    const fetchFn = fakeFetch({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: { body: AS_METADATA },
    });
    await expect(discoverAuthorizationServerMetadata(ISSUER, fetchFn)).resolves.toMatchObject({
      issuer: ISSUER,
    });
  });

  it('falls through to OpenID configuration', async () => {
    const fetchFn = fakeFetch({
      [`${ISSUER}/.well-known/openid-configuration`]: { body: AS_METADATA },
    });
    await expect(discoverAuthorizationServerMetadata(ISSUER, fetchFn)).resolves.toMatchObject({
      issuer: ISSUER,
    });
  });

  it('handles a tenanted issuer via path insertion', async () => {
    const tenant = `${ISSUER}/tenant1`;
    const fetchFn = fakeFetch({
      [`${ISSUER}/.well-known/oauth-authorization-server/tenant1`]: {
        body: { ...AS_METADATA, issuer: tenant },
      },
    });
    await expect(discoverAuthorizationServerMetadata(tenant, fetchFn)).resolves.toMatchObject({
      issuer: tenant,
    });
  });

  it('rejects a document whose issuer does not match the URL it came from', async () => {
    const fetchFn = fakeFetch({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: {
        body: { ...AS_METADATA, issuer: 'https://attacker.example' },
      },
    });
    await expect(discoverAuthorizationServerMetadata(ISSUER, fetchFn)).rejects.toMatchObject({
      code: 'issuer-mismatch',
    });
  });

  it('rejects a document missing required endpoints', async () => {
    const fetchFn = fakeFetch({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: { body: { issuer: ISSUER } },
    });
    await expect(discoverAuthorizationServerMetadata(ISSUER, fetchFn)).rejects.toBeInstanceOf(
      AuthFlowError
    );
  });

  it('reports when nothing is published at all', async () => {
    await expect(discoverAuthorizationServerMetadata(ISSUER, fakeFetch({}))).rejects.toMatchObject({
      code: 'no-authorization-server-metadata',
    });
  });
});

describe('selectAuthorizationServer', () => {
  it('picks the single listed server', () => {
    expect(selectAuthorizationServer({ authorization_servers: [ISSUER] })).toBe(ISSUER);
  });

  /**
   * Not an error any more: the caller falls back to looking for an
   * authorization server at the resource's own origin, which is what makes
   * PRM-without-authorization_servers deployments usable at all.
   */
  it('reports absence rather than failing, so the origin fallback can run', () => {
    expect(selectAuthorizationServer({})).toBeUndefined();
  });
});

describe('discoverIssuerAtResourceOrigin', () => {
  const ORIGIN_ISSUER = 'https://mcp.example.com/auth/realms/cmem';

  it('reads the issuer from the resource origin well-known document', async () => {
    const fetchFn = fakeFetch({
      'https://mcp.example.com/.well-known/oauth-authorization-server': {
        body: {
          issuer: ORIGIN_ISSUER,
          authorization_endpoint: `${ORIGIN_ISSUER}/protocol/openid-connect/auth`,
          token_endpoint: `${ORIGIN_ISSUER}/protocol/openid-connect/token`,
        },
      },
    });

    await expect(discoverIssuerAtResourceOrigin(MCP_URL, fetchFn)).resolves.toBe(ORIGIN_ISSUER);
  });

  it('falls through to the OpenID Connect document', async () => {
    const fetchFn = fakeFetch({
      'https://mcp.example.com/.well-known/openid-configuration': {
        body: { issuer: ORIGIN_ISSUER },
      },
    });

    await expect(discoverIssuerAtResourceOrigin(MCP_URL, fetchFn)).resolves.toBe(ORIGIN_ISSUER);
  });

  it('explains what the operator must add when the origin publishes nothing', async () => {
    const fetchFn = fakeFetch({});
    await expect(discoverIssuerAtResourceOrigin(MCP_URL, fetchFn)).rejects.toThrow(
      /authorization_servers/
    );
  });

  /**
   * The origin document is only a pointer. Trust still depends on the issuer's
   * own metadata naming itself, which `discoverAuthorizationServerMetadata`
   * enforces — so a document that lies about its issuer buys nothing.
   */
  it('leaves issuer validation to the second hop', async () => {
    const fetchFn = fakeFetch({
      'https://mcp.example.com/.well-known/oauth-authorization-server': {
        body: { issuer: 'https://attacker.example' },
      },
      'https://attacker.example/.well-known/oauth-authorization-server': {
        body: {
          issuer: 'https://somewhere-else.example',
          authorization_endpoint: 'https://attacker.example/auth',
          token_endpoint: 'https://attacker.example/token',
        },
      },
    });

    const issuer = await discoverIssuerAtResourceOrigin(MCP_URL, fetchFn);
    await expect(discoverAuthorizationServerMetadata(issuer, fetchFn)).rejects.toThrow(
      AuthFlowError
    );
  });
});

describe('resolveClient — registration priority (spec §7.3)', () => {
  const base = {
    clientMetadataUrl: CIMD_URL,
    clientMetadata: { client_name: 'ctbx' },
    fetchFn: fakeFetch({}),
  };

  it('priority 1: a pre-registered client ID wins over everything', async () => {
    await expect(
      resolveClient({
        ...base,
        configuredClientId: 'preregistered-id',
        metadata: { ...AS_METADATA, client_id_metadata_document_supported: true },
      })
    ).resolves.toEqual({ client_id: 'preregistered-id', source: 'pre-registered' });
  });

  it('priority 2: CIMD when the server advertises support', async () => {
    await expect(
      resolveClient({
        ...base,
        metadata: { ...AS_METADATA, client_id_metadata_document_supported: true },
      })
    ).resolves.toEqual({ client_id: CIMD_URL, source: 'cimd' });
  });

  it('prefers CIMD over dynamic registration when both are available', async () => {
    const result = await resolveClient({
      ...base,
      metadata: {
        ...AS_METADATA,
        client_id_metadata_document_supported: true,
        registration_endpoint: `${ISSUER}/register`,
      },
    });
    expect(result.source).toBe('cimd');
  });

  it('priority 3: dynamic registration when CIMD is unsupported', async () => {
    const result = await resolveClient({
      ...base,
      metadata: { ...AS_METADATA, registration_endpoint: `${ISSUER}/register` },
      fetchFn: fakeFetch({ [`${ISSUER}/register`]: { body: { client_id: 'dcr-id' } } }),
    });
    expect(result).toEqual({ client_id: 'dcr-id', source: 'dynamic' });
  });

  it('sends application_type web during dynamic registration', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ client_id: 'dcr-id' }), { status: 200 })
    );
    await resolveClient({
      ...base,
      metadata: { ...AS_METADATA, registration_endpoint: `${ISSUER}/register` },
      fetchFn,
    });
    const body = JSON.parse(String((fetchFn.mock.calls[0]![1] as RequestInit).body));
    expect(body.application_type).toBe('web');
  });

  it('priority 4: asks the user when nothing else is possible', async () => {
    await expect(resolveClient({ ...base, metadata: AS_METADATA })).rejects.toMatchObject({
      code: 'no-client-id',
    });
  });

  /**
   * A server that advertises a registration endpoint and then refuses is not a
   * server "without dynamic registration" — reporting it that way sends the
   * operator after the wrong thing entirely.
   */
  it('reports a refused registration as a refusal, with the status', async () => {
    await expect(
      resolveClient({
        ...base,
        metadata: { ...AS_METADATA, registration_endpoint: `${ISSUER}/register` },
        fetchFn: fakeFetch({
          [`${ISSUER}/register`]: { status: 403, body: { error: 'Invalid origin' } },
        }),
      })
    ).rejects.toMatchObject({ code: 'registration-failed' });
  });

  it('quotes the error the registration endpoint returned', async () => {
    const error = await rejectionOf(
      resolveClient({
        ...base,
        metadata: { ...AS_METADATA, registration_endpoint: `${ISSUER}/register` },
        fetchFn: fakeFetch({
          [`${ISSUER}/register`]: { status: 403, body: { error: 'Invalid origin' } },
        }),
      })
    );

    expect(error.message).toContain('HTTP 403');
    expect(error.message).toContain('Invalid origin');
    expect(error.message).toMatch(/Advanced/);
  });

  /**
   * From a browser the interesting failure is the one with no readable
   * response at all: an endpoint that returns no CORS headers on its error
   * path. Saying "could not read it" is the only honest report.
   */
  it('distinguishes a response it could not read from one it could', async () => {
    const error = await rejectionOf(
      resolveClient({
        ...base,
        metadata: { ...AS_METADATA, registration_endpoint: `${ISSUER}/register` },
        fetchFn: vi.fn(async () => {
          throw new TypeError('NetworkError when attempting to fetch resource.');
        }),
      })
    );

    expect(error.message).toMatch(/could not complete the request/i);
    expect(error.message).not.toMatch(/HTTP \d/);
  });
});

describe('beginAuthorization', () => {
  const input = {
    serverId: 'srv-1',
    serverUrl: MCP_URL,
    redirectUri: REDIRECT_URI,
    client: { client_id: CIMD_URL, source: 'cimd' as const },
    metadata: AS_METADATA,
    resourceMetadata: { scopes_supported: ['files:read'] },
    now: NOW,
  };

  it('builds a PKCE authorization URL with the resource indicator', async () => {
    const result = await beginAuthorization(input);
    const url = new URL(result.authorizationUrl);

    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CIMD_URL);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(MCP_URL);
    expect(url.searchParams.get('scope')).toBe('files:read');
    expect(url.searchParams.get('state')).toBe(result.state);
  });

  it('sends the resource parameter even when scopes are unknown', async () => {
    const result = await beginAuthorization({ ...input, resourceMetadata: {} });
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get('resource')).toBe(MCP_URL);
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('prefers the WWW-Authenticate scope challenge', async () => {
    const result = await beginAuthorization({ ...input, challengeScope: 'files:write' });
    expect(new URL(result.authorizationUrl).searchParams.get('scope')).toBe('files:write');
  });

  it('records the verifier and the expected issuer for callback validation', async () => {
    const result = await beginAuthorization(input);
    const pending = takePendingRequest(result.state);

    expect(pending).toMatchObject({
      serverId: 'srv-1',
      expectedIssuer: ISSUER,
      issParameterSupported: false,
      resource: MCP_URL,
      createdAt: NOW,
    });
    // The stored verifier must match the challenge that was sent.
    const challenge = new URL(result.authorizationUrl).searchParams.get('code_challenge');
    expect(await deriveCodeChallenge(pending!.codeVerifier)).toBe(challenge);
  });

  it('records that the server advertises iss support', async () => {
    const result = await beginAuthorization({
      ...input,
      metadata: { ...AS_METADATA, authorization_response_iss_parameter_supported: true },
    });
    expect(takePendingRequest(result.state)?.issParameterSupported).toBe(true);
  });

  it('produces a distinct state and verifier each time', async () => {
    const a = await beginAuthorization(input);
    const b = await beginAuthorization(input);
    expect(a.state).not.toBe(b.state);
    expect(takePendingRequest(a.state)?.codeVerifier).not.toBe(
      takePendingRequest(b.state)?.codeVerifier
    );
  });
});

describe('exchangeAuthorizationCode', () => {
  const input = {
    metadata: AS_METADATA,
    client: { client_id: CIMD_URL, source: 'cimd' as const },
    redirectUri: REDIRECT_URI,
    resource: MCP_URL,
    now: NOW,
  };

  it('posts the verifier, redirect URI and resource', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
    );

    const tokens = await exchangeAuthorizationCode('the-code', 'the-verifier', {
      ...input,
      fetchFn,
    });

    const body = new URLSearchParams(String((fetchFn.mock.calls[0]![1] as RequestInit).body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(body.get('resource')).toBe(MCP_URL);
    expect(body.get('client_id')).toBe(CIMD_URL);
    expect(tokens).toMatchObject({ access_token: 'at', expiresAt: NOW + 3600_000 });
  });

  it('sends no client secret for a public client', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ access_token: 'at' }), { status: 200 })
    );
    await exchangeAuthorizationCode('c', 'v', { ...input, fetchFn });
    const body = new URLSearchParams(String((fetchFn.mock.calls[0]![1] as RequestInit).body));
    expect(body.has('client_secret')).toBe(false);
  });

  it('surfaces the OAuth error description', async () => {
    const fetchFn = fakeFetch({
      [`${ISSUER}/token`]: {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Code already used' },
      },
    });
    await expect(exchangeAuthorizationCode('c', 'v', { ...input, fetchFn })).rejects.toMatchObject({
      code: 'token-request-failed',
      message: expect.stringContaining('Code already used'),
    });
  });

  it('reports a network or CORS failure distinctly', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(exchangeAuthorizationCode('c', 'v', { ...input, fetchFn })).rejects.toMatchObject({
      message: expect.stringContaining('CORS'),
    });
  });

  it('rejects a 200 response with no access token', async () => {
    const fetchFn = fakeFetch({ [`${ISSUER}/token`]: { body: { token_type: 'Bearer' } } });
    await expect(exchangeAuthorizationCode('c', 'v', { ...input, fetchFn })).rejects.toMatchObject({
      code: 'token-request-failed',
    });
  });
});

describe('refreshAccessToken', () => {
  const input = {
    metadata: AS_METADATA,
    client: { client_id: CIMD_URL, source: 'cimd' as const },
    redirectUri: REDIRECT_URI,
    resource: MCP_URL,
    now: NOW,
  };

  it('sends the refresh grant with the resource indicator', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2' }), { status: 200 })
    );

    const tokens = await refreshAccessToken('r1', { ...input, fetchFn });

    const body = new URLSearchParams(String((fetchFn.mock.calls[0]![1] as RequestInit).body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('r1');
    expect(body.get('resource')).toBe(MCP_URL);
    expect(tokens.refresh_token).toBe('r2');
  });

  it('keeps the old refresh token when the server omits a new one', async () => {
    const fetchFn = fakeFetch({ [`${ISSUER}/token`]: { body: { access_token: 'new' } } });
    const tokens = await refreshAccessToken('r1', { ...input, fetchFn });
    expect(tokens.refresh_token).toBe('r1');
  });
});

describe('revokeToken', () => {
  it('posts to the revocation endpoint when one exists', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('', { status: 200 })
    );
    await revokeToken(
      'at',
      { ...AS_METADATA, revocation_endpoint: `${ISSUER}/revoke` },
      { client_id: CIMD_URL, source: 'cimd' },
      fetchFn
    );
    expect(fetchFn).toHaveBeenCalledWith(`${ISSUER}/revoke`, expect.anything());
  });

  it('does nothing when the server publishes no revocation endpoint', async () => {
    const fetchFn = vi.fn();
    await revokeToken('at', AS_METADATA, { client_id: CIMD_URL, source: 'cimd' }, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('never throws when revocation fails', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(
      revokeToken(
        'at',
        { ...AS_METADATA, revocation_endpoint: `${ISSUER}/revoke` },
        { client_id: CIMD_URL, source: 'cimd' },
        fetchFn
      )
    ).resolves.toBeUndefined();
  });
});
