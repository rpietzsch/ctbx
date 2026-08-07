import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_REQUEST_TTL_MS,
  readCallbackParams,
  validateCallback,
  validateIssuer,
  type AuthorizationRequestRecord,
} from './validation';

const NOW = 1_700_000_000_000;
const ISSUER = 'https://auth.example.com';

function record(overrides: Partial<AuthorizationRequestRecord> = {}): AuthorizationRequestRecord {
  return {
    serverId: 'srv-1',
    state: 'state-abc',
    codeVerifier: 'verifier',
    expectedIssuer: ISSUER,
    issParameterSupported: true,
    resource: 'https://mcp.example.com/mcp',
    createdAt: NOW,
    ...overrides,
  };
}

const lookupFor = (stored: AuthorizationRequestRecord) => (state: string) =>
  state === stored.state ? stored : undefined;

/**
 * The truth table in tasks/spec.md §7.5, one test per row. This is the
 * validation the MCP SDK does not perform (backlog M4-1).
 */
describe('validateIssuer — RFC 9207 truth table', () => {
  it('row 1: advertised + present + matching → accept', () => {
    expect(validateIssuer(ISSUER, ISSUER, true)).toBeUndefined();
  });

  it('row 1: advertised + present + mismatched → reject', () => {
    expect(validateIssuer('https://evil.example', ISSUER, true)).toBe('issuer-mismatch');
  });

  it('row 2: advertised + absent → reject', () => {
    expect(validateIssuer(null, ISSUER, true)).toBe('issuer-missing');
    expect(validateIssuer(undefined, ISSUER, true)).toBe('issuer-missing');
  });

  it('row 3: not advertised + present + matching → accept', () => {
    expect(validateIssuer(ISSUER, ISSUER, false)).toBeUndefined();
  });

  it('row 3: not advertised + present + mismatched → reject', () => {
    // Local-policy provision: compare regardless of metadata advertisement.
    expect(validateIssuer('https://evil.example', ISSUER, false)).toBe('issuer-mismatch');
  });

  it('row 4: not advertised + absent → proceed', () => {
    expect(validateIssuer(null, ISSUER, false)).toBeUndefined();
  });
});

describe('validateIssuer — no normalization is permitted', () => {
  it('rejects a case-folded host', () => {
    expect(validateIssuer('https://AUTH.example.com', ISSUER, true)).toBe('issuer-mismatch');
  });

  it('rejects a case-folded scheme', () => {
    expect(validateIssuer('HTTPS://auth.example.com', ISSUER, true)).toBe('issuer-mismatch');
  });

  it('rejects an added trailing slash', () => {
    expect(validateIssuer('https://auth.example.com/', ISSUER, true)).toBe('issuer-mismatch');
  });

  it('rejects an elided default port', () => {
    expect(validateIssuer('https://auth.example.com:443', ISSUER, true)).toBe('issuer-mismatch');
  });

  it('rejects percent-encoding differences', () => {
    expect(
      validateIssuer('https://auth.example.com/a%2Db', 'https://auth.example.com/a-b', true)
    ).toBe('issuer-mismatch');
  });
});

describe('validateCallback', () => {
  it('accepts a well-formed response', () => {
    const stored = record();
    const result = validateCallback(
      { code: 'auth-code', state: stored.state, iss: ISSUER },
      lookupFor(stored),
      NOW
    );
    expect(result).toEqual({ ok: true, code: 'auth-code', record: stored });
  });

  it('rejects a response with no state', () => {
    const result = validateCallback({ code: 'c', state: null }, lookupFor(record()), NOW);
    expect(result).toMatchObject({ ok: false, reason: 'state-missing' });
  });

  it('rejects a state that matches no pending request', () => {
    const result = validateCallback({ code: 'c', state: 'other' }, lookupFor(record()), NOW);
    expect(result).toMatchObject({ ok: false, reason: 'unknown-request' });
  });

  it('rejects an expired request', () => {
    const stored = record();
    const result = validateCallback(
      { code: 'c', state: stored.state, iss: ISSUER },
      lookupFor(stored),
      NOW + AUTHORIZATION_REQUEST_TTL_MS + 1
    );
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('validates state before issuer, so an unsolicited response is rejected first', () => {
    const stored = record();
    const result = validateCallback(
      { code: 'c', state: 'forged', iss: 'https://evil.example' },
      lookupFor(stored),
      NOW
    );
    expect(result).toMatchObject({ reason: 'unknown-request' });
  });

  it('rejects a mismatched issuer even when a code is present', () => {
    const stored = record();
    const result = validateCallback(
      { code: 'c', state: stored.state, iss: 'https://evil.example' },
      lookupFor(stored),
      NOW
    );
    expect(result).toMatchObject({ ok: false, reason: 'issuer-mismatch' });
  });

  it('surfaces an authorization error once the issuer checks out', () => {
    const stored = record();
    const result = validateCallback(
      {
        state: stored.state,
        iss: ISSUER,
        error: 'access_denied',
        error_description: 'User refused',
      },
      lookupFor(stored),
      NOW
    );
    expect(result).toMatchObject({ ok: false, reason: 'authorization-error' });
    expect(result.ok === false && result.message).toContain('User refused');
  });

  it('does NOT repeat the error text when the issuer is wrong', () => {
    const stored = record();
    const result = validateCallback(
      {
        state: stored.state,
        iss: 'https://evil.example',
        error: 'access_denied',
        error_description: 'ATTACKER CONTROLLED TEXT',
      },
      lookupFor(stored),
      NOW
    );
    expect(result).toMatchObject({ ok: false, reason: 'issuer-mismatch' });
    expect(result.ok === false && result.message).not.toContain('ATTACKER CONTROLLED TEXT');
  });

  it('does NOT repeat the error text when the state is unknown', () => {
    const result = validateCallback(
      { state: 'forged', error: 'access_denied', error_description: 'ATTACKER CONTROLLED TEXT' },
      lookupFor(record()),
      NOW
    );
    expect(result.ok === false && result.message).not.toContain('ATTACKER CONTROLLED TEXT');
  });

  it('rejects a response with neither code nor error', () => {
    const stored = record();
    const result = validateCallback({ state: stored.state, iss: ISSUER }, lookupFor(stored), NOW);
    expect(result).toMatchObject({ ok: false, reason: 'code-missing' });
  });

  it('rejects when the server omits iss but advertised support', () => {
    const stored = record({ issParameterSupported: true });
    const result = validateCallback({ code: 'c', state: stored.state }, lookupFor(stored), NOW);
    expect(result).toMatchObject({ ok: false, reason: 'issuer-missing' });
  });

  it('accepts when the server omits iss and never advertised support', () => {
    const stored = record({ issParameterSupported: false });
    const result = validateCallback({ code: 'c', state: stored.state }, lookupFor(stored), NOW);
    expect(result).toMatchObject({ ok: true });
  });
});

describe('readCallbackParams', () => {
  it('reads the standard parameters with or without a leading question mark', () => {
    expect(readCallbackParams('?code=abc&state=xyz&iss=https%3A%2F%2Fa.example')).toMatchObject({
      code: 'abc',
      state: 'xyz',
      iss: 'https://a.example',
    });
    expect(readCallbackParams('code=abc').code).toBe('abc');
  });

  it('returns nulls for absent parameters', () => {
    expect(readCallbackParams('')).toEqual({
      code: null,
      state: null,
      iss: null,
      error: null,
      error_description: null,
    });
  });
});
