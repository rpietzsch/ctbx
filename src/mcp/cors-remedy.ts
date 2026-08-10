/**
 * Actionable CORS remedies.
 *
 * A browser cannot read a blocked response, so most of what follows names the
 * exact configuration the operator has to add, including this app's origin —
 * which turns an opaque "failed to fetch" into a copy-pasteable fix, even when
 * ctbx can only infer the cause. The exception is
 * `blockedRequestHeaderRemedy`, which reports what a differential probe
 * measured rather than what it suspects.
 *
 * The Keycloak case is called out by name because it is the most common trap:
 * Keycloak answers the *preflight* for any origin, then rejects the actual
 * token POST with `403 {"error":"Invalid origin"}` and no CORS headers unless
 * the origin is listed in the client's Web Origins. The symptom is a failure
 * that looks like the network is down.
 */

export function currentOrigin(): string {
  if (typeof globalThis.location === 'undefined') return 'https://rpietzsch.github.io';
  return globalThis.location.origin;
}

/** Recognises a Keycloak realm endpoint from its URL shape. */
export function looksLikeKeycloak(url: string): boolean {
  return /\/realms\/[^/]+(\/|$)|\/protocol\/openid-connect\//.test(url);
}

/** Remedy text for an authorization server that blocked a browser request. */
export function authorizationServerCorsRemedy(url: string, origin = currentOrigin()): string {
  const base = `The authorization server must allow browser requests from ${origin}. That means returning Access-Control-Allow-Origin for this origin on the token endpoint — not only on the discovery documents.`;

  if (!looksLikeKeycloak(url)) return base;

  return `${base}

This looks like Keycloak. Keycloak answers the CORS preflight for any origin but then rejects the token request with 403 "Invalid origin" unless the origin is registered on the client. Add ${origin} to the client's "Web Origins", and ${origin}/ctbx/oauth/callback.html to its "Valid redirect URIs".`;
}

/**
 * Remedy for a token the resource server refused (`error="invalid_token"`).
 *
 * The token exists, so this is no longer an authorization-flow problem — the
 * MCP server looked at it and said no. By far the most common cause is audience
 * binding: the MCP specification requires a resource server to verify the token
 * was issued for *it*, and clients to send RFC 8707 `resource`. Keycloak does
 * not implement RFC 8707 — it ignores the parameter — so unless an audience
 * mapper is configured, the issued token's `aud` never names the MCP server and
 * the check fails.
 */
export function tokenRejectedRemedy(resource: string, issuer?: string): string {
  const keycloak = issuer !== undefined && looksLikeKeycloak(issuer);

  const base = `The authorization server issued a token but the MCP server rejected it. The token is most likely missing the required audience or scope for ${resource}.`;

  if (!keycloak) {
    return `${base}

MCP requires the access token's audience to identify the MCP server. Check that the authorization server honours the RFC 8707 "resource" parameter, or is otherwise configured to put ${resource} in the token's "aud" claim.`;
  }

  return `${base}

This looks like Keycloak, which does not implement RFC 8707 resource indicators — it ignores the "resource" parameter ctbx sends, so the token's "aud" claim will not name the MCP server on its own.

Fix it with an audience mapper: Client scopes → (a scope assigned to this client) → Mappers → Add mapper → By configuration → Audience, and set "Included Custom Audience" to ${resource}. Then confirm the resulting token's "aud" contains that value.`;
}

/** Remedy text for an MCP endpoint that a browser cannot use. */
export function mcpEndpointCorsRemedy(origin = currentOrigin()): string {
  return `The MCP server must allow browser requests from ${origin}:

  Access-Control-Allow-Origin: ${origin}
  Access-Control-Allow-Methods: POST, GET, OPTIONS
  Access-Control-Allow-Headers: Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version
  Access-Control-Expose-Headers: WWW-Authenticate, Mcp-Session-Id

Mcp-Session-Id and MCP-Protocol-Version in Allow-Headers are the ones most often missed: the MCP client sends MCP-Protocol-Version on every request after the handshake, so a server that omits it works for the first call and then fails.`;
}

/**
 * Why "it works in the CLI but not here" is expected. Worth stating plainly:
 * it is the single most common confusion for a browser-based MCP client.
 */
export const NATIVE_CLIENT_NOTE =
  'A command-line MCP client (such as Claude Code) is a native process and is not subject to CORS at all, so a server can work there and still be unusable from a browser. CORS is enforced by the browser, not the server.';

/**
 * Remedy for headers a differential probe *proved* the browser will not send:
 * the same request went through without them and was blocked with them, so this
 * is a measurement rather than the informed guess `mcpEndpointCorsRemedy` makes.
 */
export function blockedRequestHeaderRemedy(
  names: readonly string[],
  origin = currentOrigin()
): string {
  const list = names.join(', ');
  const fatal = names.some((name) => name.toLowerCase() === 'mcp-session-id');

  return `The MCP server's CORS policy does not accept ${list} from ${origin}. Its preflight response must list every header the MCP client sends:

  Access-Control-Allow-Headers: Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version

${
  fatal
    ? 'ctbx omits the headers it can do without, but a stateful server cannot be used from a browser without Mcp-Session-Id — every request after the handshake would start a new session.'
    : 'ctbx works around this by omitting the header; a server that does not receive MCP-Protocol-Version has to assume protocol version 2025-03-26, so this costs the newer protocol revision until the server is fixed.'
}

${NATIVE_CLIENT_NOTE}`;
}
