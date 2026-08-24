import { describe, expect, it, vi } from 'vitest';
import { accountFromClaims, decodeJwtClaims, fetchUserInfoClaims, resolveAccount } from './account';
import type { FetchLike } from './flow';

const USERINFO = 'https://auth.example.com/userinfo';

/** Signature is never checked, so any header and signature will do. */
function jwt(claims: Record<string, unknown>): string {
  const body = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(claims))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${body}.signature`;
}

function jsonFetch(body: unknown, status = 200): FetchLike {
  return vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
  );
}

describe('decodeJwtClaims', () => {
  it('reads the payload of a well-formed token', () => {
    expect(decodeJwtClaims(jwt({ sub: 'user-a' }))?.sub).toBe('user-a');
  });

  /** Padding is stripped in base64url, so the decoder has to restore it. */
  it('handles every payload length, not just the ones that need no padding', () => {
    for (const name of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
      expect(decodeJwtClaims(jwt({ sub: name }))?.sub).toBe(name);
    }
  });

  it('decodes claims as UTF-8, so non-Latin-1 names survive', () => {
    expect(decodeJwtClaims(jwt({ sub: 'x', name: 'Renée Müller 日本' }))?.name).toBe(
      'Renée Müller 日本'
    );
  });

  it('returns nothing for a string that is not a JWT', () => {
    expect(decodeJwtClaims('not-a-jwt')).toBeUndefined();
    expect(decodeJwtClaims('')).toBeUndefined();
  });

  it('returns nothing when the payload is not base64', () => {
    expect(decodeJwtClaims('header.!!!!.signature')).toBeUndefined();
  });

  it('returns nothing when the payload is not a JSON object', () => {
    const encoded = btoa('["an","array"]').replace(/=+$/, '');
    expect(decodeJwtClaims(`header.${encoded}.signature`)).toBeUndefined();
  });
});

describe('accountFromClaims', () => {
  it('prefers the username a person would recognise', () => {
    const account = accountFromClaims(
      { sub: 'abc-123', preferred_username: 'user-a', email: 'a@example.com', name: 'User A' },
      'id_token'
    );
    expect(account).toEqual({ subject: 'abc-123', label: 'user-a', source: 'id_token' });
  });

  it('falls back through email and name', () => {
    expect(accountFromClaims({ sub: 'x', email: 'a@example.com' }, 'id_token')?.label).toBe(
      'a@example.com'
    );
    expect(accountFromClaims({ sub: 'x', name: 'User A' }, 'id_token')?.label).toBe('User A');
  });

  /** Opaque, but it still tells two accounts apart, which is the job. */
  it('falls back to the subject when no readable claim exists', () => {
    expect(accountFromClaims({ sub: 'abc-123' }, 'id_token')?.label).toBe('abc-123');
  });

  it('ignores a blank claim rather than showing an empty label', () => {
    expect(accountFromClaims({ sub: 'abc-123', preferred_username: '  ' }, 'id_token')?.label).toBe(
      'abc-123'
    );
  });

  it('returns nothing without a subject, since there is then no account to name', () => {
    expect(accountFromClaims({ preferred_username: 'user-a' }, 'id_token')).toBeUndefined();
  });
});

describe('fetchUserInfoClaims', () => {
  it('reads a JSON response', async () => {
    const claims = await fetchUserInfoClaims(USERINFO, 'token', jsonFetch({ sub: 'user-a' }));
    expect(claims?.sub).toBe('user-a');
  });

  it('sends the access token as a bearer credential', async () => {
    const fetchFn = jsonFetch({ sub: 'user-a' });
    await fetchUserInfoClaims(USERINFO, 'the-token', fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      USERINFO,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer the-token' }),
      })
    );
  });

  it('reads a signed userinfo response, which comes back as a JWT', async () => {
    const claims = await fetchUserInfoClaims(USERINFO, 'token', jsonFetch(jwt({ sub: 'user-b' })));
    expect(claims?.sub).toBe('user-b');
  });

  /**
   * Userinfo is rarely CORS-enabled, so this is the expected outcome rather
   * than an edge case — and it must stay quiet.
   */
  it('gives up quietly when the browser blocks the request', async () => {
    const blocked: FetchLike = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchUserInfoClaims(USERINFO, 'token', blocked)).resolves.toBeUndefined();
  });

  it('gives up quietly when the token is rejected', async () => {
    await expect(
      fetchUserInfoClaims(USERINFO, 'token', jsonFetch({ error: 'invalid_token' }, 401))
    ).resolves.toBeUndefined();
  });
});

describe('resolveAccount', () => {
  it('uses the ID token and makes no request at all', async () => {
    const fetchFn = jsonFetch({ sub: 'from-userinfo' });
    const account = await resolveAccount({
      idToken: jwt({ sub: 'from-id-token', preferred_username: 'user-a' }),
      accessToken: 'token',
      userinfoEndpoint: USERINFO,
      fetchFn,
    });

    expect(account?.subject).toBe('from-id-token');
    expect(account?.source).toBe('id_token');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('falls back to userinfo when no ID token was issued', async () => {
    const account = await resolveAccount({
      accessToken: 'token',
      userinfoEndpoint: USERINFO,
      fetchFn: jsonFetch({ sub: 'user-b', preferred_username: 'user-b' }),
    });
    expect(account).toEqual({ subject: 'user-b', label: 'user-b', source: 'userinfo' });
  });

  it('falls back to userinfo when the ID token is unreadable', async () => {
    const account = await resolveAccount({
      idToken: 'garbage',
      accessToken: 'token',
      userinfoEndpoint: USERINFO,
      fetchFn: jsonFetch({ sub: 'user-b' }),
    });
    expect(account?.source).toBe('userinfo');
  });

  it('resolves to nothing when the server offers neither', async () => {
    const account = await resolveAccount({
      accessToken: 'token',
      fetchFn: jsonFetch({ sub: 'unreachable' }),
    });
    expect(account).toBeUndefined();
  });
});
