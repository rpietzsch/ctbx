/**
 * The MCP authorization flow, spec §7.1–§7.6.
 *
 * Implemented here rather than delegated wholesale to the MCP SDK because of
 * the M4-1 spike finding: SDK 1.30.0 covers discovery, CIMD and the token
 * exchange, but performs no RFC 9207 `iss` validation. Rather than run half the
 * flow in the SDK and bolt validation onto the other half, the whole sequence
 * lives here where every step is injectable and unit-testable, and the SDK is
 * used for what it is unambiguously best at: the transport.
 *
 * `fetch` is a parameter throughout so the entire flow can be exercised without
 * a network (spec §12, and the "no keys in tests" rule).
 */
import {
  buildAuthorizationServerMetadataUrls,
  buildProtectedResourceMetadataUrls,
  canonicalResourceUri,
  extractResourceMetadataUrl,
  selectScopes,
  validateIssuerMatch,
} from './discovery';
import {
  authorizationServerCorsRemedy,
  currentOrigin,
  looksLikeKeycloak,
  NATIVE_CLIENT_NOTE,
} from '../cors-remedy';
import { createPkcePair, generateState } from './pkce';
import {
  savePendingRequest,
  toStoredTokens,
  type StoredClient,
  type StoredTokens,
} from './token-store';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class AuthFlowError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'no-protected-resource-metadata'
      | 'no-authorization-server'
      | 'no-authorization-server-metadata'
      | 'issuer-mismatch'
      | 'no-client-id'
      | 'registration-failed'
      | 'token-request-failed'
  ) {
    super(message);
    this.name = 'AuthFlowError';
  }
}

export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
  authorization_response_iss_parameter_supported?: boolean;
}

async function fetchJsonOrUndefined(url: string, fetchFn: FetchLike): Promise<unknown | undefined> {
  try {
    const response = await fetchFn(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Spec §7.1 step 2: use the `resource_metadata` hint when the browser can read
 * it, otherwise probe the well-known URLs in order. The fallback is not a
 * nicety — servers that omit `Access-Control-Expose-Headers: WWW-Authenticate`
 * (spec §9.1) are otherwise unusable from a browser.
 */
export async function discoverProtectedResourceMetadata(
  serverUrl: string,
  wwwAuthenticate: string | null | undefined,
  fetchFn: FetchLike
): Promise<{ metadata: ProtectedResourceMetadata; source: 'header' | 'well-known' }> {
  const hinted = extractResourceMetadataUrl(wwwAuthenticate);
  if (hinted) {
    const metadata = await fetchJsonOrUndefined(hinted, fetchFn);
    if (metadata) return { metadata: metadata as ProtectedResourceMetadata, source: 'header' };
  }

  for (const url of buildProtectedResourceMetadataUrls(serverUrl)) {
    const metadata = await fetchJsonOrUndefined(url, fetchFn);
    if (metadata) return { metadata: metadata as ProtectedResourceMetadata, source: 'well-known' };
  }

  throw new AuthFlowError(
    'The server requires authorization but published no protected resource metadata. It may not implement the MCP authorization spec, or it may not expose the WWW-Authenticate header to browsers.',
    'no-protected-resource-metadata'
  );
}

/**
 * Spec §7.1 steps 4–5. Tries each candidate URL in the normative order and
 * rejects any document whose `issuer` does not match the issuer used to build
 * the URL — without that check a hostile document could redirect token requests.
 */
export async function discoverAuthorizationServerMetadata(
  issuer: string,
  fetchFn: FetchLike
): Promise<AuthorizationServerMetadata> {
  let sawDocument = false;

  for (const url of buildAuthorizationServerMetadataUrls(issuer)) {
    const document = await fetchJsonOrUndefined(url, fetchFn);
    if (!document) continue;
    sawDocument = true;

    const metadata = document as AuthorizationServerMetadata;
    if (!validateIssuerMatch(metadata.issuer, issuer)) continue;
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) continue;
    return metadata;
  }

  throw new AuthFlowError(
    sawDocument
      ? `The authorization server at ${issuer} published metadata that failed validation. Its declared issuer did not match, or required endpoints were missing.`
      : `No authorization server metadata was found at ${issuer}.`,
    sawDocument ? 'issuer-mismatch' : 'no-authorization-server-metadata'
  );
}

export function selectAuthorizationServer(metadata: ProtectedResourceMetadata): string | undefined {
  return metadata.authorization_servers?.[0];
}

/**
 * The fallback for a resource whose metadata names no authorization server —
 * common enough that refusing to handle it makes servers other clients accept
 * look broken here.
 *
 * MCP's legacy behaviour, still implemented by the reference SDK, is to treat
 * the MCP server's own origin as the authorization server base URL. That URL is
 * not an issuer identifier, so RFC 8414 §3.3's "issuer must match the URL it
 * came from" check cannot apply to it — which is why this only reads the
 * `issuer` out of the document and hands it back. The caller then runs ordinary
 * issuer-validated discovery on that value, so the guarantee is recovered on
 * the second hop: an authorization server is only trusted once its own
 * well-known document names itself.
 */
export async function discoverIssuerAtResourceOrigin(
  serverUrl: string,
  fetchFn: FetchLike
): Promise<string> {
  const origin = new URL('/', serverUrl).origin;

  for (const url of [
    `${origin}/.well-known/oauth-authorization-server`,
    `${origin}/.well-known/openid-configuration`,
  ]) {
    const document = await fetchJsonOrUndefined(url, fetchFn);
    const issuer = (document as AuthorizationServerMetadata | undefined)?.issuer;
    if (typeof issuer === 'string' && issuer !== '') return issuer;
  }

  throw new AuthFlowError(
    `The server's protected resource metadata lists no authorization server, and ${origin} publishes no authorization server metadata either. Its operator has to add "authorization_servers" to the protected resource metadata.`,
    'no-authorization-server'
  );
}

// ------------------------------------------------------ client registration

export interface ClientResolutionInput {
  /** Pre-registered client ID from the server config (priority 1). */
  configuredClientId?: string | undefined;
  /** URL of our hosted CIMD document (priority 2). */
  clientMetadataUrl: string;
  clientMetadata: Record<string, unknown>;
  metadata: AuthorizationServerMetadata;
  scope?: string | undefined;
  /** Only used to spell out the redirect URI when registration has to be manual. */
  redirectUri?: string | undefined;
  fetchFn: FetchLike;
}

/**
 * Registration priority from spec §7.3: pre-registration, then CIMD, then the
 * deprecated DCR, then give up and ask the user.
 */
export async function resolveClient(input: ClientResolutionInput): Promise<StoredClient> {
  if (input.configuredClientId) {
    return { client_id: input.configuredClientId, source: 'pre-registered' };
  }

  if (input.metadata.client_id_metadata_document_supported === true) {
    // The client ID *is* the URL of our metadata document. No round trip, and
    // portable across authorization servers.
    return { client_id: input.clientMetadataUrl, source: 'cimd' };
  }

  if (input.metadata.registration_endpoint) {
    const registered = await registerDynamically(input);
    if (registered.ok) return registered.client;

    // Saying "does not support dynamic registration" here would be false: the
    // server advertised the endpoint and then refused the request. Report what
    // actually happened, because the fix differs completely.
    throw new AuthFlowError(
      `${input.metadata.registration_endpoint} is advertised for dynamic client registration, but ${registered.reason}.\n\n${manualClientIdAdvice(input)}`,
      'registration-failed'
    );
  }

  throw new AuthFlowError(
    `This authorization server supports neither client ID metadata documents nor dynamic registration.\n\n${manualClientIdAdvice(input)}`,
    'no-client-id'
  );
}

/** What to do once no client ID can be obtained automatically. */
function manualClientIdAdvice(input: ClientResolutionInput): string {
  const origin = currentOrigin();
  const redirect = input.redirectUri ?? `${origin}/ctbx/oauth/callback.html`;

  const base = `Enter a client ID for this server under Edit → Advanced. It needs to be a public client (no secret, PKCE) with ${redirect} as a valid redirect URI.`;

  if (!looksLikeKeycloak(input.metadata.issuer)) return base;

  return `${base}

This looks like Keycloak, where anonymous client registration is normally disabled and the refusal comes back as 403 "Invalid origin" with no CORS headers — so a browser cannot even read the reason. Create the client in the realm, add ${origin} to its Web Origins, and enter its client ID here.`;
}

type RegistrationResult =
  | { ok: true; client: StoredClient }
  /** Phrased to complete "…, but <reason>". */
  | { ok: false; reason: string };

/**
 * Attempts RFC 7591 registration, and on failure says why in terms the operator
 * can act on. The distinction that matters from a browser: a rejection the page
 * can read (an HTTP status) versus one it cannot (the request never completed,
 * which for a registration endpoint almost always means it returns no CORS
 * headers on the error path).
 */
async function registerDynamically(input: ClientResolutionInput): Promise<RegistrationResult> {
  const endpoint = input.metadata.registration_endpoint!;

  let response: Response;
  try {
    response = await input.fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        ...input.clientMetadata,
        // Omitting application_type defaults to "web" under OIDC, which can
        // conflict with the redirect URIs we use (spec §7.3).
        application_type: 'web',
        ...(input.scope ? { scope: input.scope } : {}),
      }),
    });
  } catch {
    return {
      ok: false,
      reason: `the browser could not complete the request — the endpoint does not answer cross-origin requests from ${currentOrigin()}, so its response cannot be read`,
    };
  }

  if (!response.ok) {
    const detail = await registrationErrorDetail(response);
    return {
      ok: false,
      reason: `it answered HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
    };
  }

  const body = (await response.json().catch(() => undefined)) as
    { client_id?: string; client_secret?: string } | undefined;
  if (!body?.client_id) return { ok: false, reason: 'it answered without a client_id' };

  return {
    ok: true,
    client: {
      client_id: body.client_id,
      ...(body.client_secret ? { client_secret: body.client_secret } : {}),
      source: 'dynamic',
    },
  };
}

/** The `error`/`error_description` of a failed registration, when readable. */
async function registrationErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: string; error_description?: string };
    return body.error_description ?? body.error;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------- authorization request

export interface BeginAuthorizationInput {
  serverId: string;
  serverUrl: string;
  redirectUri: string;
  client: StoredClient;
  metadata: AuthorizationServerMetadata;
  resourceMetadata: ProtectedResourceMetadata;
  challengeScope?: string | undefined;
  configuredScopes?: readonly string[] | undefined;
  now?: number;
}

export interface BeginAuthorizationResult {
  authorizationUrl: string;
  state: string;
  resource: string;
  scope: string | undefined;
}

/**
 * Builds the authorization URL and records everything the callback will need to
 * validate the response — critically the expected issuer, which is what makes
 * RFC 9207 validation possible at all.
 */
export async function beginAuthorization(
  input: BeginAuthorizationInput
): Promise<BeginAuthorizationResult> {
  const now = input.now ?? Date.now();
  const pkce = await createPkcePair();
  const state = generateState();
  const resource = canonicalResourceUri(input.serverUrl);
  const scope = selectScopes(
    input.challengeScope,
    input.resourceMetadata.scopes_supported,
    input.configuredScopes
  );

  const url = new URL(input.metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.client.client_id);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('code_challenge', pkce.codeChallenge);
  url.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);
  url.searchParams.set('state', state);
  // RFC 8707: sent regardless of whether the server advertises support.
  url.searchParams.set('resource', resource);
  if (scope) url.searchParams.set('scope', scope);

  savePendingRequest({
    serverId: input.serverId,
    state,
    codeVerifier: pkce.codeVerifier,
    expectedIssuer: input.metadata.issuer,
    issParameterSupported: input.metadata.authorization_response_iss_parameter_supported === true,
    resource,
    ...(scope ? { scope } : {}),
    createdAt: now,
  });

  return { authorizationUrl: url.toString(), state, resource, scope };
}

// --------------------------------------------------------- token exchange

interface TokenRequestInput {
  metadata: AuthorizationServerMetadata;
  client: StoredClient;
  redirectUri: string;
  resource: string;
  fetchFn: FetchLike;
  now?: number;
}

async function requestToken(
  params: URLSearchParams,
  input: TokenRequestInput
): Promise<StoredTokens> {
  params.set('client_id', input.client.client_id);
  // Public client: no secret unless one was issued by dynamic registration.
  if (input.client.client_secret) params.set('client_secret', input.client.client_secret);
  params.set('resource', input.resource);

  let response: Response;
  try {
    response = await input.fetchFn(input.metadata.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });
  } catch {
    // The browser gives us nothing to distinguish "offline" from "blocked", so
    // state both and name the exact configuration that would fix the blocked
    // case. See src/mcp/cors-remedy.ts for why this is the best we can do.
    throw new AuthFlowError(
      `The browser could not complete the token request to ${input.metadata.token_endpoint}. Either the network is unavailable, or the authorization server refused the request because of its origin.\n\n${authorizationServerCorsRemedy(input.metadata.token_endpoint)}\n\n${NATIVE_CLIENT_NOTE}`,
      'token-request-failed'
    );
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; error_description?: string };
      if (body.error) {
        detail = body.error_description ? `${body.error_description} (${body.error})` : body.error;
      }
    } catch {
      /* keep the status-only detail */
    }
    throw new AuthFlowError(`The token request was rejected: ${detail}`, 'token-request-failed');
  }

  const body = (await response.json()) as {
    access_token?: string;
    token_type?: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
  };

  if (!body.access_token) {
    throw new AuthFlowError(
      'The token response contained no access token.',
      'token-request-failed'
    );
  }

  return toStoredTokens({ ...body, access_token: body.access_token }, input.now ?? Date.now());
}

export async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
  input: TokenRequestInput
): Promise<StoredTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: input.redirectUri,
  });
  return requestToken(params, input);
}

export async function refreshAccessToken(
  refreshToken: string,
  input: TokenRequestInput & { scope?: string | undefined }
): Promise<StoredTokens> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (input.scope) params.set('scope', input.scope);
  const tokens = await requestToken(params, input);
  // Servers may omit the refresh token on rotation-free renewals; keep the old
  // one so the session does not silently become non-renewable.
  return tokens.refresh_token ? tokens : { ...tokens, refresh_token: refreshToken };
}

export async function revokeToken(
  token: string,
  metadata: AuthorizationServerMetadata,
  client: StoredClient,
  fetchFn: FetchLike
): Promise<void> {
  if (!metadata.revocation_endpoint) return;
  try {
    await fetchFn(metadata.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: client.client_id }).toString(),
    });
  } catch {
    // Revocation is best-effort; local tokens are cleared regardless.
  }
}
