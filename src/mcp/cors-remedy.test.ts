import { describe, expect, it } from 'vitest';
import {
  authorizationServerCorsRemedy,
  currentOrigin,
  looksLikeKeycloak,
  mcpEndpointCorsRemedy,
  NATIVE_CLIENT_NOTE,
} from './cors-remedy';

const ORIGIN = 'http://localhost:5173';

describe('looksLikeKeycloak', () => {
  it('recognises a realm URL', () => {
    expect(looksLikeKeycloak('https://host.example/auth/realms/cmem')).toBe(true);
  });

  it('recognises an openid-connect endpoint', () => {
    expect(
      looksLikeKeycloak('https://host.example/auth/realms/cmem/protocol/openid-connect/token')
    ).toBe(true);
  });

  it('does not match unrelated authorization servers', () => {
    expect(looksLikeKeycloak('https://auth.example.com/oauth2/token')).toBe(false);
    expect(looksLikeKeycloak('https://login.microsoftonline.com/common/oauth2/v2.0/token')).toBe(
      false
    );
  });
});

describe('authorizationServerCorsRemedy', () => {
  it('names the origin that must be allowed', () => {
    expect(authorizationServerCorsRemedy('https://auth.example.com/token', ORIGIN)).toContain(
      ORIGIN
    );
  });

  it('points out that discovery-only CORS is not enough', () => {
    expect(authorizationServerCorsRemedy('https://auth.example.com/token', ORIGIN)).toMatch(
      /not only on the discovery documents/i
    );
  });

  it('gives Keycloak-specific instructions when it recognises Keycloak', () => {
    const remedy = authorizationServerCorsRemedy(
      'https://azpoc.example.dev/auth/realms/cmem/protocol/openid-connect/token',
      ORIGIN
    );
    expect(remedy).toMatch(/Web Origins/);
    expect(remedy).toMatch(/Valid redirect URIs/);
    expect(remedy).toContain(`${ORIGIN}/ctbx/oauth/callback.html`);
  });

  it('explains the misleading preflight behaviour', () => {
    const remedy = authorizationServerCorsRemedy(
      'https://host.example/auth/realms/x/protocol/openid-connect/token',
      ORIGIN
    );
    expect(remedy).toMatch(/preflight/i);
    expect(remedy).toMatch(/Invalid origin/);
  });

  it('omits Keycloak advice for other servers', () => {
    expect(authorizationServerCorsRemedy('https://auth.example.com/token', ORIGIN)).not.toMatch(
      /Web Origins/
    );
  });
});

describe('mcpEndpointCorsRemedy', () => {
  it('lists every required header', () => {
    const remedy = mcpEndpointCorsRemedy(ORIGIN);
    for (const header of [
      'Access-Control-Allow-Origin',
      'Access-Control-Allow-Headers',
      'Access-Control-Expose-Headers',
      'Mcp-Session-Id',
      'MCP-Protocol-Version',
      'WWW-Authenticate',
    ]) {
      expect(remedy).toContain(header);
    }
  });

  it('calls out the header that fails only after the handshake', () => {
    expect(mcpEndpointCorsRemedy(ORIGIN)).toMatch(/works for the first call and then fails/);
  });

  it('uses the given origin', () => {
    expect(mcpEndpointCorsRemedy(ORIGIN)).toContain(ORIGIN);
  });
});

describe('NATIVE_CLIENT_NOTE', () => {
  it('explains why a CLI client succeeds where a browser does not', () => {
    expect(NATIVE_CLIENT_NOTE).toMatch(/native process/i);
    expect(NATIVE_CLIENT_NOTE).toMatch(/enforced by the browser/i);
  });
});

describe('currentOrigin', () => {
  it('returns the page origin under jsdom', () => {
    expect(currentOrigin()).toMatch(/^https?:\/\//);
  });
});
