import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindingKey,
  clearClient,
  clearTokens,
  clientStore,
  pendingAuthStore,
  prunePendingRequests,
  readClient,
  readTokens,
  savePendingRequest,
  shouldRefresh,
  takePendingRequest,
  toStoredTokens,
  tokenStore,
  tokensExpired,
  writeClient,
  writeTokens,
  type StoredTokens,
} from './token-store';

const NOW = 1_700_000_000_000;
const ISSUER = 'https://auth.example.com';
const OTHER_ISSUER = 'https://other.example.com';

function tokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    access_token: 'access-1',
    token_type: 'Bearer',
    obtainedAt: NOW,
    expiresAt: NOW + 3600_000,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  tokenStore.remove();
  clientStore.remove();
  pendingAuthStore.remove();
});

describe('bindingKey', () => {
  it('combines server and issuer', () => {
    expect(bindingKey('srv', ISSUER)).toBe(`srv|${ISSUER}`);
  });
});

describe('token binding', () => {
  it('round-trips tokens for a server and issuer', () => {
    writeTokens('srv', ISSUER, tokens());
    expect(readTokens('srv', ISSUER)?.access_token).toBe('access-1');
  });

  it('does not leak a token across servers', () => {
    writeTokens('srv-a', ISSUER, tokens());
    expect(readTokens('srv-b', ISSUER)).toBeUndefined();
  });

  it('does not leak a token across issuers', () => {
    writeTokens('srv', ISSUER, tokens());
    expect(readTokens('srv', OTHER_ISSUER)).toBeUndefined();
  });

  it('clears a single binding when the issuer is given', () => {
    writeTokens('srv', ISSUER, tokens());
    writeTokens('srv', OTHER_ISSUER, tokens({ access_token: 'access-2' }));

    clearTokens('srv', ISSUER);

    expect(readTokens('srv', ISSUER)).toBeUndefined();
    expect(readTokens('srv', OTHER_ISSUER)?.access_token).toBe('access-2');
  });

  it('clears every binding for a server on disconnect', () => {
    writeTokens('srv', ISSUER, tokens());
    writeTokens('srv', OTHER_ISSUER, tokens());
    writeTokens('keep', ISSUER, tokens());

    clearTokens('srv');

    expect(readTokens('srv', ISSUER)).toBeUndefined();
    expect(readTokens('srv', OTHER_ISSUER)).toBeUndefined();
    expect(readTokens('keep', ISSUER)).toBeDefined();
  });
});

describe('client registration binding', () => {
  it('keeps client IDs separate per issuer, so none is reused after a change', () => {
    writeClient('srv', ISSUER, { client_id: 'client-a', source: 'dynamic' });
    expect(readClient('srv', OTHER_ISSUER)).toBeUndefined();
    expect(readClient('srv', ISSUER)?.client_id).toBe('client-a');
  });

  it('clears client registrations for a server', () => {
    writeClient('srv', ISSUER, { client_id: 'client-a', source: 'dynamic' });
    clearClient('srv');
    expect(readClient('srv', ISSUER)).toBeUndefined();
  });
});

describe('expiry and refresh', () => {
  it('is not expired before the deadline', () => {
    expect(tokensExpired(tokens(), NOW + 3599_000)).toBe(false);
  });

  it('is expired at the deadline', () => {
    expect(tokensExpired(tokens(), NOW + 3600_000)).toBe(true);
  });

  it('never expires when the server gave no lifetime', () => {
    expect(tokensExpired(tokens({ expiresAt: undefined }), NOW + 10 ** 12)).toBe(false);
  });

  it('refreshes at 80 % of lifetime, not before', () => {
    const token = tokens(); // 1 hour
    expect(shouldRefresh(token, NOW + 2879_000)).toBe(false); // 79.97 %
    expect(shouldRefresh(token, NOW + 2880_000)).toBe(true); // exactly 80 %
  });

  it('does not schedule a refresh without a known lifetime', () => {
    expect(shouldRefresh(tokens({ expiresAt: undefined }), NOW + 10 ** 12)).toBe(false);
  });

  it('treats a non-positive lifetime as immediately refreshable', () => {
    expect(shouldRefresh(tokens({ expiresAt: NOW }), NOW)).toBe(true);
  });
});

describe('toStoredTokens', () => {
  it('converts expires_in into an absolute deadline', () => {
    expect(toStoredTokens({ access_token: 'a', expires_in: 3600 }, NOW)).toEqual({
      access_token: 'a',
      token_type: 'Bearer',
      obtainedAt: NOW,
      expiresAt: NOW + 3600_000,
    });
  });

  it('omits expiry when the server reports none', () => {
    expect(toStoredTokens({ access_token: 'a' }, NOW).expiresAt).toBeUndefined();
  });

  it('carries the refresh token and granted scope through', () => {
    expect(
      toStoredTokens({ access_token: 'a', refresh_token: 'r', scope: 'files:read' }, NOW)
    ).toMatchObject({ refresh_token: 'r', scope: 'files:read' });
  });
});

describe('pending authorization requests', () => {
  const record = {
    serverId: 'srv',
    state: 'state-1',
    codeVerifier: 'verifier',
    expectedIssuer: ISSUER,
    issParameterSupported: true,
    resource: 'https://mcp.example.com/mcp',
    createdAt: NOW,
  };

  it('round-trips a request by state', () => {
    savePendingRequest(record);
    expect(takePendingRequest('state-1')).toMatchObject({ codeVerifier: 'verifier' });
  });

  it('is single use, so an authorization code cannot be replayed', () => {
    savePendingRequest(record);
    expect(takePendingRequest('state-1')).toBeDefined();
    expect(takePendingRequest('state-1')).toBeUndefined();
  });

  it('returns nothing for an unknown state', () => {
    expect(takePendingRequest('never-issued')).toBeUndefined();
  });

  it('prunes abandoned requests', () => {
    savePendingRequest(record);
    savePendingRequest({ ...record, state: 'state-2', createdAt: NOW - 10 ** 6 });

    prunePendingRequests(NOW, 600_000);

    expect(Object.keys(pendingAuthStore.get())).toEqual(['state-1']);
  });
});

describe('storage classification', () => {
  it('marks credential stores secret so "forget keys" reaches them', () => {
    expect(tokenStore.secret).toBe(true);
    expect(clientStore.secret).toBe(true);
    expect(pendingAuthStore.secret).toBe(true);
  });
});
