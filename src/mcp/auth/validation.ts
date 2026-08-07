/**
 * Authorization-response validation: `state` and RFC 9207 `iss`.
 *
 * Implements tasks/spec.md §7.5. This module exists because the MCP TypeScript
 * SDK (verified at 1.30.0, backlog M4-1) implements discovery, PKCE, CIMD and
 * the token exchange, but performs **no `iss` validation at all**. Without it a
 * mix-up attack can hand an authorization code issued by one authorization
 * server to a different server's token endpoint.
 *
 * Two rules from the specification are easy to get subtly wrong and are pinned
 * by tests here:
 *
 *  1. Comparison is byte-for-byte. No scheme/host case folding, no default-port
 *     elision, no trailing-slash or percent-encoding normalization.
 *  2. The validation applies to error responses too. On a mismatch the client
 *     must not act on, or display, `error` / `error_description` / `error_uri`,
 *     because those fields are then attacker-controlled.
 */

export interface AuthorizationRequestRecord {
  /** The MCP server this authorization is for. */
  serverId: string;
  /** Opaque CSRF value; must come back unchanged. */
  state: string;
  /** PKCE verifier, held until the token exchange. */
  codeVerifier: string;
  /** `issuer` from the validated authorization-server metadata document. */
  expectedIssuer: string;
  /** Whether that metadata set `authorization_response_iss_parameter_supported`. */
  issParameterSupported: boolean;
  /** RFC 8707 canonical resource URI this token is being requested for. */
  resource: string;
  scope?: string | undefined;
  createdAt: number;
}

export type CallbackFailureReason =
  | 'unknown-request'
  | 'state-missing'
  | 'state-mismatch'
  | 'expired'
  | 'issuer-missing'
  | 'issuer-mismatch'
  | 'authorization-error'
  | 'code-missing';

export type CallbackValidationResult =
  | { ok: true; code: string; record: AuthorizationRequestRecord }
  | { ok: false; reason: CallbackFailureReason; message: string };

/** Authorization requests older than this are treated as abandoned. */
export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;

/**
 * RFC 9207 §2.4, as tabulated in spec §7.5.
 *
 * Returns `undefined` when the response is acceptable, or a failure reason.
 */
export function validateIssuer(
  received: string | null | undefined,
  expectedIssuer: string,
  issParameterSupported: boolean
): 'issuer-missing' | 'issuer-mismatch' | undefined {
  const present = received !== null && received !== undefined;

  if (!present) {
    // Advertised support but omitted it: reject. Not advertised and omitted: fine.
    return issParameterSupported ? 'issuer-missing' : undefined;
  }

  // Present in either case: compare, with no normalization whatsoever.
  return received === expectedIssuer ? undefined : 'issuer-mismatch';
}

export interface CallbackParams {
  code?: string | null;
  state?: string | null;
  iss?: string | null;
  error?: string | null;
  error_description?: string | null;
}

export function readCallbackParams(search: string): CallbackParams {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return {
    code: params.get('code'),
    state: params.get('state'),
    iss: params.get('iss'),
    error: params.get('error'),
    error_description: params.get('error_description'),
  };
}

/**
 * Validates an authorization response against the record stored before the
 * redirect. Ordering matters: `state` is checked first so an unsolicited
 * response is rejected before anything in it is trusted, then `iss`, and only
 * then is an `error` field considered safe to surface.
 */
export function validateCallback(
  params: CallbackParams,
  lookup: (state: string) => AuthorizationRequestRecord | undefined,
  now: number = Date.now()
): CallbackValidationResult {
  if (!params.state) {
    return {
      ok: false,
      reason: 'state-missing',
      message: 'The authorization response carried no state value and cannot be trusted.',
    };
  }

  const record = lookup(params.state);
  if (!record) {
    return {
      ok: false,
      reason: 'unknown-request',
      message:
        'The authorization response does not match any pending request. It may have already been used, or it was not initiated by this app.',
    };
  }

  if (now - record.createdAt > AUTHORIZATION_REQUEST_TTL_MS) {
    return {
      ok: false,
      reason: 'expired',
      message: 'The authorization request expired. Start the connection again.',
    };
  }

  const issuerFailure = validateIssuer(
    params.iss,
    record.expectedIssuer,
    record.issParameterSupported
  );
  if (issuerFailure) {
    return {
      ok: false,
      reason: issuerFailure,
      message:
        issuerFailure === 'issuer-missing'
          ? 'The authorization server advertised issuer identification but did not return one. The response was rejected.'
          : 'The authorization response came from a different issuer than expected. The response was rejected.',
    };
  }

  // Only now is the server's own error text trustworthy enough to repeat.
  if (params.error) {
    return {
      ok: false,
      reason: 'authorization-error',
      message: params.error_description
        ? `Authorization failed: ${params.error_description} (${params.error})`
        : `Authorization failed: ${params.error}`,
    };
  }

  if (!params.code) {
    return {
      ok: false,
      reason: 'code-missing',
      message: 'The authorization response contained neither an authorization code nor an error.',
    };
  }

  return { ok: true, code: params.code, record };
}

/**
 * `state` comparison helper. Kept explicit so the "no normalization" rule is
 * visible at the call site rather than implied by `===`.
 */
export function statesMatch(received: string, expected: string): boolean {
  return received === expected;
}
