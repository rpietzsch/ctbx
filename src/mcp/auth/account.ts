/**
 * Which account a stored token belongs to, spec §7.6.
 *
 * This exists for verification, never for authorization. With one endpoint
 * configured twice under two identities (§6.2) nothing else on screen tells the
 * two connections apart, and a silent re-authorization can rebind a slot to the
 * wrong account without changing anything visible. The resolved label is shown
 * to the user and used for nothing else — no decision anywhere reads it.
 */
import { z } from 'zod';
import type { FetchLike } from './flow';

export const storedAccountSchema = z.object({
  /** The `sub` claim: stable, opaque, and the only identifier always present. */
  subject: z.string(),
  /** What to show a human; falls back to the subject when nothing better exists. */
  label: z.string(),
  source: z.enum(['id_token', 'userinfo']),
});
export type StoredAccount = z.infer<typeof storedAccountSchema>;

/**
 * Decodes a JWT payload **without verifying the signature**.
 *
 * Legitimate for exactly the two cases here, and for nothing else. An ID token
 * taken straight from the token endpoint over TLS may skip signature validation
 * (OIDC Core §3.1.3.7, clause 6) because the TLS channel to the authorization
 * server already establishes where it came from; the same reasoning covers a
 * userinfo response returned as a JWT. Both are read for display only, so a
 * forged claim buys an attacker a wrong name on screen and no access.
 */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const payload = jwt.split('.')[1];
  if (!payload) return undefined;

  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');

  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    // Claims are UTF-8; `atob` alone mangles anything outside Latin-1, which
    // includes most non-English names.
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '');
}

/**
 * Builds the account from OIDC claims.
 *
 * Claim priority is what a person would recognise first, ending at `sub`, which
 * is unreadable but always there — an opaque subject still distinguishes two
 * accounts, which is the whole job.
 */
export function accountFromClaims(
  claims: Record<string, unknown>,
  source: StoredAccount['source']
): StoredAccount | undefined {
  const subject = firstString(claims.sub);
  if (!subject) return undefined;

  return {
    subject,
    label: firstString(claims.preferred_username, claims.email, claims.name) ?? subject,
    source,
  };
}

/**
 * Best-effort userinfo call. Every failure returns `undefined` rather than
 * throwing: this runs inside the token request, and an authorization server
 * that does not answer userinfo cross-origin — the ordinary case, since
 * userinfo is rarely CORS-enabled — must not fail an otherwise good login.
 */
export async function fetchUserInfoClaims(
  endpoint: string,
  accessToken: string,
  fetchFn: FetchLike
): Promise<Record<string, unknown> | undefined> {
  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  const body = await response.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Some servers sign the userinfo response and return a JWT instead.
    return decodeJwtClaims(body);
  }
  return undefined;
}

export interface ResolveAccountInput {
  /** `id_token` from the token response, when `openid` was among the scopes. */
  idToken?: string | undefined;
  accessToken: string;
  userinfoEndpoint?: string | undefined;
  fetchFn: FetchLike;
}

/**
 * The ID token first: it is already in hand, costs no request, and cannot be
 * blocked by CORS. Userinfo is the fallback for servers that issued no ID token
 * because `openid` was not among the granted scopes.
 */
export async function resolveAccount(
  input: ResolveAccountInput
): Promise<StoredAccount | undefined> {
  if (input.idToken) {
    const claims = decodeJwtClaims(input.idToken);
    const account = claims ? accountFromClaims(claims, 'id_token') : undefined;
    if (account) return account;
  }

  if (!input.userinfoEndpoint) return undefined;
  const claims = await fetchUserInfoClaims(
    input.userinfoEndpoint,
    input.accessToken,
    input.fetchFn
  );
  return claims ? accountFromClaims(claims, 'userinfo') : undefined;
}
