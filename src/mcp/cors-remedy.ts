/**
 * Actionable CORS remedies.
 *
 * A browser cannot read a blocked response, so ctbx can never *prove* which
 * header is missing from inside the page (an OPTIONS probe is itself subject to
 * the same preflight). What it can do is name the exact configuration the
 * operator has to add, including this app's origin — which turns an opaque
 * "failed to fetch" into a copy-pasteable fix.
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
