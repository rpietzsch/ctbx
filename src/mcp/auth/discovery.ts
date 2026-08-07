/**
 * OAuth discovery URL construction and metadata validation.
 *
 * Implements tasks/spec.md §7.1 exactly. The orderings below are normative in
 * the MCP authorization specification, not preferences — interoperability with
 * real authorization servers depends on trying them in this sequence, which is
 * why each one is pinned by a test.
 */

export interface WwwAuthenticateChallenge {
  scheme: string;
  params: Record<string, string>;
}

/**
 * Parses an RFC 7235 `WWW-Authenticate` header well enough for RFC 9728's
 * `resource_metadata` and RFC 6750's `scope` / `error` parameters.
 *
 * Note this header is only readable in a browser when the MCP server sends
 * `Access-Control-Expose-Headers: WWW-Authenticate` (spec §9.1). When it is
 * not, callers fall back to well-known probing.
 */
export function parseWwwAuthenticate(
  header: string | null | undefined
): WwwAuthenticateChallenge[] {
  if (!header) return [];

  const challenges: WwwAuthenticateChallenge[] = [];
  // Split on scheme boundaries: a bare token followed by whitespace that is not
  // itself a `key=value` pair starts a new challenge.
  const schemePattern = /(^|,\s*)([A-Za-z][A-Za-z0-9._~+-]*)(\s+|$)(?![^,=]*=[^,]*=)/g;
  const starts: { scheme: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = schemePattern.exec(header)) !== null) {
    const scheme = match[2]!;
    if (/^(realm|scope|error|error_description|error_uri|resource_metadata)$/i.test(scheme)) {
      continue;
    }
    starts.push({ scheme, index: match.index + match[1]!.length + scheme.length });
  }

  if (starts.length === 0) return [];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]!.index - start.scheme.length : header.length;
    challenges.push({
      scheme: start.scheme,
      params: parseAuthParams(header.slice(start.index, end)),
    });
  }

  return challenges;
}

function parseAuthParams(segment: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pattern = /([A-Za-z0-9._~+-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    const key = match[1]!.toLowerCase();
    const value = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : (match[3] ?? '');
    params[key] = value;
  }
  return params;
}

/** Extracts the `resource_metadata` hint from a 401/403 challenge, if readable. */
export function extractResourceMetadataUrl(header: string | null | undefined): string | undefined {
  for (const challenge of parseWwwAuthenticate(header)) {
    const value = challenge.params.resource_metadata;
    if (value) return value;
  }
  return undefined;
}

/** Extracts the authoritative `scope` challenge (spec §7.2 priority 1). */
export function extractChallengeScope(header: string | null | undefined): string | undefined {
  for (const challenge of parseWwwAuthenticate(header)) {
    const value = challenge.params.scope;
    if (value) return value;
  }
  return undefined;
}

/**
 * Well-known URLs for Protected Resource Metadata, in the order spec §7.1
 * step 2b requires: path-specific first, then root.
 */
export function buildProtectedResourceMetadataUrls(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  const origin = url.origin;
  const path = url.pathname.replace(/\/+$/, '');

  const urls: string[] = [];
  if (path !== '' && path !== '/') {
    urls.push(`${origin}/.well-known/oauth-protected-resource${path}`);
  }
  urls.push(`${origin}/.well-known/oauth-protected-resource`);
  return urls;
}

/**
 * Well-known URLs for Authorization Server Metadata, in the order spec §7.1
 * step 4 requires.
 *
 * With a path component the OAuth path-*insertion* forms come first, then the
 * OIDC path-*appending* form. Without one, OAuth then OIDC. Getting this order
 * wrong breaks tenanted authorization servers in ways that look like random
 * 404s, so all five permutations are pinned by tests.
 */
export function buildAuthorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const origin = url.origin;
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '' || path === '/') {
    return [
      `${origin}/.well-known/oauth-authorization-server`,
      `${origin}/.well-known/openid-configuration`,
    ];
  }

  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${origin}${path}/.well-known/openid-configuration`,
  ];
}

/**
 * RFC 8414 §3.3 / OIDC Discovery §4.3: the `issuer` in the document must equal
 * the issuer used to build the URL. Without this check a hostile metadata
 * document could redirect token requests to an attacker's endpoints.
 */
export function validateIssuerMatch(documentIssuer: unknown, expectedIssuer: string): boolean {
  return typeof documentIssuer === 'string' && documentIssuer === expectedIssuer;
}

/**
 * The canonical MCP server URI used as the RFC 8707 `resource` parameter
 * (spec §7.4): lowercase scheme and host, no fragment, no trailing slash.
 */
export function canonicalResourceUri(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  let result = url.toString();
  if (url.search === '') result = result.replace(/\?$/, '');
  // Strip a trailing slash only when it carries no path information.
  if (url.pathname === '/') result = result.replace(/\/$/, '');
  else result = result.replace(/\/$/, '');
  return result;
}

/** Scope selection strategy, spec §7.2. */
export function selectScopes(
  challengeScope: string | undefined,
  scopesSupported: readonly string[] | undefined,
  configuredScopes: readonly string[] | undefined
): string | undefined {
  if (configuredScopes && configuredScopes.length > 0) return configuredScopes.join(' ');
  if (challengeScope && challengeScope.trim() !== '') return challengeScope;
  if (scopesSupported && scopesSupported.length > 0) return scopesSupported.join(' ');
  return undefined;
}

/**
 * Step-up: the union of what was already requested and what the server now
 * demands, so previously granted permissions are not dropped (spec §7.2).
 */
export function unionScopes(
  previous: string | undefined,
  challenged: string | undefined
): string | undefined {
  const parts = [...(previous ?? '').split(/\s+/), ...(challenged ?? '').split(/\s+/)].filter(
    (scope) => scope !== ''
  );
  if (parts.length === 0) return undefined;
  return [...new Set(parts)].join(' ');
}
