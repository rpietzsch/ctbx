/**
 * OAuth token and client-registration storage, spec §7.6 and §7.3.
 *
 * Everything here is keyed by `(serverId, issuer)`. That composite key is the
 * client-side half of audience binding: a token obtained for one MCP server can
 * never be looked up for another, and a client ID registered with one
 * authorization server is never reused after the discovered issuer changes
 * (the "Authorization Server Binding" requirement).
 */
import { z } from 'zod';
import { defineStore } from '@/storage/local';
import { safeParser } from '@/config/schema';
import { storedAccountSchema } from './account';

export const storedTokensSchema = z.object({
  access_token: z.string(),
  token_type: z.string().default('Bearer'),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  /** Absolute epoch ms when the token was issued. */
  obtainedAt: z.number(),
  /** Absolute epoch ms of expiry, when the server told us. */
  expiresAt: z.number().optional(),
  /**
   * Who the token belongs to, when the authorization server said. Derived from
   * the login rather than returned by it, so it lives and dies with the token
   * it describes — which is what makes it trustworthy as a label for this slot.
   */
  account: storedAccountSchema.optional(),
  /**
   * The ID token, kept solely as `id_token_hint` for RP-initiated logout.
   *
   * Nothing reads it as an assertion — the account label is resolved once at
   * login and stored separately. It is here because ending the session at the
   * authorization server needs to name which session, and by then the response
   * that carried it is long gone.
   */
  id_token: z.string().optional(),
});
export type StoredTokens = z.infer<typeof storedTokensSchema>;

export const storedClientSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  /** How this client ID was obtained; drives the §7.3 priority order. */
  source: z.enum(['pre-registered', 'cimd', 'dynamic']),
});
export type StoredClient = z.infer<typeof storedClientSchema>;

const tokenRecordsSchema = z.record(z.string(), storedTokensSchema);
const clientRecordsSchema = z.record(z.string(), storedClientSchema);

export const tokenStore = defineStore<Record<string, StoredTokens>>({
  name: 'mcp-tokens',
  version: 1,
  label: 'MCP OAuth access tokens',
  secret: true,
  fallback: () => ({}),
  parse: safeParser(tokenRecordsSchema),
});

export const clientStore = defineStore<Record<string, StoredClient>>({
  name: 'mcp-clients',
  version: 1,
  label: 'MCP OAuth client registrations',
  secret: true,
  fallback: () => ({}),
  parse: safeParser(clientRecordsSchema),
});

/** The composite key. Both parts are required — see the module comment. */
export function bindingKey(serverId: string, issuer: string): string {
  return `${serverId}|${issuer}`;
}

export function readTokens(serverId: string, issuer: string): StoredTokens | undefined {
  return tokenStore.get()[bindingKey(serverId, issuer)];
}

export function writeTokens(serverId: string, issuer: string, tokens: StoredTokens): void {
  tokenStore.update((all) => ({ ...all, [bindingKey(serverId, issuer)]: tokens }));
}

export function clearTokens(serverId: string, issuer?: string): void {
  tokenStore.update((all) => {
    const next = { ...all };
    if (issuer) delete next[bindingKey(serverId, issuer)];
    // No issuer given: drop every binding for this server (used on disconnect).
    else for (const key of Object.keys(next)) if (key.startsWith(`${serverId}|`)) delete next[key];
    return next;
  });
}

export function readClient(serverId: string, issuer: string): StoredClient | undefined {
  return clientStore.get()[bindingKey(serverId, issuer)];
}

/**
 * A client registered with this authorization server for *any* MCP server.
 *
 * A client ID identifies the application to an authorization server; it is not
 * bound to a particular resource. So when two configured MCP servers sit behind
 * the same issuer — the normal case for a suite of services behind one realm —
 * the second can reuse what the first obtained instead of registering again, or
 * making the user paste the same client ID twice. The issuer half of the key is
 * still what scopes the lookup, so the §7.3 binding is preserved; only the
 * per-server half is relaxed.
 */
export function findClientForIssuer(issuer: string): StoredClient | undefined {
  const suffix = `|${issuer}`;
  const matches = Object.entries(clientStore.get())
    .filter(([key]) => key.endsWith(suffix))
    .map(([, client]) => client);

  // A client the user entered by hand beats one we registered dynamically.
  return matches.find((client) => client.source === 'pre-registered') ?? matches[0];
}

export function writeClient(serverId: string, issuer: string, client: StoredClient): void {
  clientStore.update((all) => ({ ...all, [bindingKey(serverId, issuer)]: client }));
}

export function clearClient(serverId: string, issuer?: string): void {
  clientStore.update((all) => {
    const next = { ...all };
    if (issuer) delete next[bindingKey(serverId, issuer)];
    else for (const key of Object.keys(next)) if (key.startsWith(`${serverId}|`)) delete next[key];
    return next;
  });
}

/** Refresh once 80 % of the token's lifetime has elapsed (spec §7.6). */
export const REFRESH_AT_FRACTION = 0.8;

export function tokensExpired(tokens: StoredTokens, now: number): boolean {
  return tokens.expiresAt !== undefined && now >= tokens.expiresAt;
}

export function shouldRefresh(tokens: StoredTokens, now: number): boolean {
  if (tokens.expiresAt === undefined) return false;
  const lifetime = tokens.expiresAt - tokens.obtainedAt;
  if (lifetime <= 0) return true;
  return now >= tokens.obtainedAt + lifetime * REFRESH_AT_FRACTION;
}

/** Converts an OAuth token response into the stored shape. */
export function toStoredTokens(
  response: {
    access_token: string;
    token_type?: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
    id_token?: string;
  },
  now: number
): StoredTokens {
  return {
    access_token: response.access_token,
    token_type: response.token_type ?? 'Bearer',
    ...(response.refresh_token ? { refresh_token: response.refresh_token } : {}),
    ...(response.scope ? { scope: response.scope } : {}),
    ...(response.id_token ? { id_token: response.id_token } : {}),
    obtainedAt: now,
    ...(response.expires_in !== undefined ? { expiresAt: now + response.expires_in * 1000 } : {}),
  };
}

// ------------------------------------------------- pending authorization state

const pendingRequestSchema = z.object({
  serverId: z.string(),
  state: z.string(),
  codeVerifier: z.string(),
  expectedIssuer: z.string(),
  issParameterSupported: z.boolean(),
  resource: z.string(),
  scope: z.string().optional(),
  createdAt: z.number(),
});

/**
 * In-flight authorization requests, keyed by `state`.
 *
 * localStorage rather than sessionStorage: the full-page-redirect fallback
 * (spec §7.5) returns to a fresh document, and a popup does not reliably share
 * sessionStorage with its opener. Holds a PKCE verifier, so it is `secret` and
 * entries are deleted the moment they are consumed.
 */
export const pendingAuthStore = defineStore<Record<string, z.infer<typeof pendingRequestSchema>>>({
  name: 'mcp-pending-auth',
  version: 1,
  label: 'In-flight MCP authorization requests',
  secret: true,
  fallback: () => ({}),
  parse: safeParser(z.record(z.string(), pendingRequestSchema)),
});

export function savePendingRequest(record: z.infer<typeof pendingRequestSchema>): void {
  pendingAuthStore.update((all) => ({ ...all, [record.state]: record }));
}

/**
 * Reads a pending request without consuming it, so a caller can find out which
 * server an authorization response belongs to before acting on it. Consuming
 * first and asking afterwards is not equivalent: the record is single-use, so a
 * wrong guess destroys the response for the server that actually owns it.
 */
export function peekPendingRequest(
  state: string
): z.infer<typeof pendingRequestSchema> | undefined {
  return pendingAuthStore.get()[state];
}

export function takePendingRequest(
  state: string
): z.infer<typeof pendingRequestSchema> | undefined {
  const all = pendingAuthStore.get();
  const record = all[state];
  if (record) {
    // Single use: consuming it prevents an authorization code replay.
    const next = { ...all };
    delete next[state];
    pendingAuthStore.set(next);
  }
  return record;
}

/** Drops abandoned requests so the store cannot grow without bound. */
export function prunePendingRequests(now: number, ttlMs: number): void {
  pendingAuthStore.update((all) =>
    Object.fromEntries(Object.entries(all).filter(([, r]) => now - r.createdAt <= ttlMs))
  );
}
