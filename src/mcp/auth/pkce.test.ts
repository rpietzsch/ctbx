import { describe, expect, it } from 'vitest';
import {
  base64UrlEncode,
  createPkcePair,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
  isValidCodeVerifier,
} from './pkce';

describe('base64UrlEncode', () => {
  it('uses the URL-safe alphabet and strips padding', () => {
    const encoded = base64UrlEncode(new Uint8Array([251, 255, 190, 255]));
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encoded).toBe('-_--_w');
  });

  it('encodes the empty input', () => {
    expect(base64UrlEncode(new Uint8Array([]))).toBe('');
  });
});

describe('generateCodeVerifier', () => {
  it('satisfies the RFC 7636 character and length rules', () => {
    for (let i = 0; i < 20; i++) {
      expect(isValidCodeVerifier(generateCodeVerifier())).toBe(true);
    }
  });

  it('produces 43 characters from 32 bytes of entropy', () => {
    expect(generateCodeVerifier()).toHaveLength(43);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateCodeVerifier()));
    expect(seen.size).toBe(100);
  });
});

describe('generateState', () => {
  it('carries 128 bits of entropy', () => {
    expect(generateState()).toHaveLength(22); // 16 bytes → 22 base64url chars
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateState()));
    expect(seen.size).toBe(100);
  });
});

describe('deriveCodeChallenge', () => {
  it('matches the RFC 7636 appendix B test vector', async () => {
    // verifier and expected challenge from RFC 7636 Appendix B
    await expect(deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });

  it('is deterministic', async () => {
    const verifier = generateCodeVerifier();
    await expect(deriveCodeChallenge(verifier)).resolves.toBe(await deriveCodeChallenge(verifier));
  });

  it('differs for different verifiers', async () => {
    const a = await deriveCodeChallenge(generateCodeVerifier());
    const b = await deriveCodeChallenge(generateCodeVerifier());
    expect(a).not.toBe(b);
  });
});

describe('createPkcePair', () => {
  it('always uses S256', async () => {
    const pair = await createPkcePair();
    expect(pair.codeChallengeMethod).toBe('S256');
    expect(pair.codeChallenge).toBe(await deriveCodeChallenge(pair.codeVerifier));
  });
});

describe('isValidCodeVerifier', () => {
  it('rejects verifiers that are too short or too long', () => {
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(128))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
  });

  it('rejects characters outside the unreserved set', () => {
    expect(isValidCodeVerifier(`${'a'.repeat(42)}+`)).toBe(false);
    expect(isValidCodeVerifier(`${'a'.repeat(42)}/`)).toBe(false);
  });
});
