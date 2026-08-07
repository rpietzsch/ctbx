/**
 * PKCE (RFC 7636) and CSRF state generation, spec §7.4.
 *
 * There is no confidential place to keep a client secret in a static page, so
 * PKCE is the only thing binding an authorization code to this client. S256 is
 * mandatory; `plain` is deliberately not implemented.
 */

const VERIFIER_BYTES = 32; // → 43 base64url characters, the RFC 7636 minimum
const STATE_BYTES = 16; // 128 bits

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(VERIFIER_BYTES));
}

export function generateState(): string {
  return base64UrlEncode(randomBytes(STATE_BYTES));
}

export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return base64UrlEncode(digest);
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export async function createPkcePair(): Promise<PkcePair> {
  const codeVerifier = generateCodeVerifier();
  return {
    codeVerifier,
    codeChallenge: await deriveCodeChallenge(codeVerifier),
    codeChallengeMethod: 'S256',
  };
}

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
export function isValidCodeVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}
