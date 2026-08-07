import { describe, expect, it } from 'vitest';
import {
  buildAuthorizationServerMetadataUrls,
  buildProtectedResourceMetadataUrls,
  canonicalResourceUri,
  extractChallengeScope,
  extractResourceMetadataUrl,
  parseWwwAuthenticate,
  selectScopes,
  unionScopes,
  validateIssuerMatch,
} from './discovery';

describe('parseWwwAuthenticate', () => {
  it('parses the resource_metadata hint from a 401 challenge', () => {
    const header =
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"';
    expect(extractResourceMetadataUrl(header)).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource'
    );
  });

  it('parses the scope challenge alongside resource_metadata', () => {
    const header =
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read files:write"';
    expect(extractChallengeScope(header)).toBe('files:read files:write');
    expect(extractResourceMetadataUrl(header)).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource'
    );
  });

  it('parses an insufficient_scope 403 challenge', () => {
    const header =
      'Bearer error="insufficient_scope", scope="files:write", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", error_description="File write permission required"';
    const [challenge] = parseWwwAuthenticate(header);
    expect(challenge?.scheme).toBe('Bearer');
    expect(challenge?.params).toMatchObject({
      error: 'insufficient_scope',
      scope: 'files:write',
      error_description: 'File write permission required',
    });
  });

  it('handles unquoted parameter values', () => {
    const [challenge] = parseWwwAuthenticate('Bearer realm=example, error=invalid_token');
    expect(challenge?.params).toMatchObject({ realm: 'example', error: 'invalid_token' });
  });

  it('unescapes quoted pairs', () => {
    const [challenge] = parseWwwAuthenticate('Bearer error_description="say \\"hi\\""');
    expect(challenge?.params.error_description).toBe('say "hi"');
  });

  it('returns nothing for an absent header (the CORS case)', () => {
    expect(parseWwwAuthenticate(null)).toEqual([]);
    expect(parseWwwAuthenticate(undefined)).toEqual([]);
    expect(parseWwwAuthenticate('')).toEqual([]);
    expect(extractResourceMetadataUrl(null)).toBeUndefined();
  });
});

describe('buildProtectedResourceMetadataUrls (spec §7.1 step 2b)', () => {
  it('tries the path-specific URL before the root', () => {
    expect(buildProtectedResourceMetadataUrls('https://example.com/public/mcp')).toEqual([
      'https://example.com/.well-known/oauth-protected-resource/public/mcp',
      'https://example.com/.well-known/oauth-protected-resource',
    ]);
  });

  it('returns only the root URL for a root-hosted server', () => {
    expect(buildProtectedResourceMetadataUrls('https://example.com')).toEqual([
      'https://example.com/.well-known/oauth-protected-resource',
    ]);
    expect(buildProtectedResourceMetadataUrls('https://example.com/')).toEqual([
      'https://example.com/.well-known/oauth-protected-resource',
    ]);
  });

  it('ignores a trailing slash on the endpoint path', () => {
    expect(buildProtectedResourceMetadataUrls('https://example.com/mcp/')[0]).toBe(
      'https://example.com/.well-known/oauth-protected-resource/mcp'
    );
  });

  it('preserves a non-default port', () => {
    expect(buildProtectedResourceMetadataUrls('https://example.com:8443/mcp')[0]).toBe(
      'https://example.com:8443/.well-known/oauth-protected-resource/mcp'
    );
  });
});

describe('buildAuthorizationServerMetadataUrls (spec §7.1 step 4)', () => {
  it('uses OAuth then OIDC for an issuer without a path', () => {
    expect(buildAuthorizationServerMetadataUrls('https://auth.example.com')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ]);
  });

  it('uses path insertion before path appending for a tenanted issuer', () => {
    expect(buildAuthorizationServerMetadataUrls('https://auth.example.com/tenant1')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
      'https://auth.example.com/tenant1/.well-known/openid-configuration',
    ]);
  });

  it('treats a bare trailing slash as no path', () => {
    expect(buildAuthorizationServerMetadataUrls('https://auth.example.com/')).toHaveLength(2);
  });

  it('handles a multi-segment tenant path', () => {
    expect(buildAuthorizationServerMetadataUrls('https://auth.example.com/a/b')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/a/b',
      'https://auth.example.com/.well-known/openid-configuration/a/b',
      'https://auth.example.com/a/b/.well-known/openid-configuration',
    ]);
  });
});

describe('validateIssuerMatch (RFC 8414 §3.3)', () => {
  it('accepts an exact match', () => {
    expect(validateIssuerMatch('https://honest.example', 'https://honest.example')).toBe(true);
  });

  it('rejects a document claiming a different issuer', () => {
    // The attack from the spec: fetched from attacker.example, claims honest.example.
    expect(validateIssuerMatch('https://honest.example', 'https://attacker.example')).toBe(false);
  });

  it('rejects a missing or non-string issuer', () => {
    expect(validateIssuerMatch(undefined, 'https://honest.example')).toBe(false);
    expect(validateIssuerMatch(42, 'https://honest.example')).toBe(false);
  });
});

describe('canonicalResourceUri (spec §7.4)', () => {
  it('keeps a path-bearing URI intact', () => {
    expect(canonicalResourceUri('https://mcp.example.com/mcp')).toBe('https://mcp.example.com/mcp');
  });

  it('drops the trailing slash of a root URI', () => {
    expect(canonicalResourceUri('https://mcp.example.com/')).toBe('https://mcp.example.com');
  });

  it('preserves an explicit non-default port', () => {
    expect(canonicalResourceUri('https://mcp.example.com:8443')).toBe(
      'https://mcp.example.com:8443'
    );
  });

  it('lowercases scheme and host', () => {
    expect(canonicalResourceUri('HTTPS://MCP.Example.COM/mcp')).toBe('https://mcp.example.com/mcp');
  });

  it('strips a fragment, which is invalid in a resource indicator', () => {
    expect(canonicalResourceUri('https://mcp.example.com/mcp#section')).toBe(
      'https://mcp.example.com/mcp'
    );
  });

  it('keeps a nested server path', () => {
    expect(canonicalResourceUri('https://mcp.example.com/server/mcp')).toBe(
      'https://mcp.example.com/server/mcp'
    );
  });
});

describe('selectScopes (spec §7.2)', () => {
  it('prefers a user-configured override above everything', () => {
    expect(selectScopes('a', ['b'], ['custom'])).toBe('custom');
  });

  it('prefers the WWW-Authenticate challenge over scopes_supported', () => {
    expect(selectScopes('files:read', ['a', 'b'], undefined)).toBe('files:read');
  });

  it('falls back to scopes_supported', () => {
    expect(selectScopes(undefined, ['a', 'b'], undefined)).toBe('a b');
  });

  it('omits scope entirely when nothing is known', () => {
    expect(selectScopes(undefined, undefined, undefined)).toBeUndefined();
    expect(selectScopes('   ', [], [])).toBeUndefined();
  });
});

describe('unionScopes (step-up, spec §7.2)', () => {
  it('preserves previously granted scopes when adding a challenged one', () => {
    expect(unionScopes('files:read profile', 'files:write')).toBe('files:read profile files:write');
  });

  it('deduplicates', () => {
    expect(unionScopes('a b', 'b c')).toBe('a b c');
  });

  it('handles either side being absent', () => {
    expect(unionScopes(undefined, 'a')).toBe('a');
    expect(unionScopes('a', undefined)).toBe('a');
    expect(unionScopes(undefined, undefined)).toBeUndefined();
  });
});
