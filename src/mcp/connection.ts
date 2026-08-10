import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { z } from 'zod';
import type { McpServerConfig } from '@/config/schema';
import { defineStore } from '@/storage/local';
import { safeParser } from '@/config/schema';
import { diagnoseConnection, type Diagnosis } from './diagnostics';
import { mcpEndpointCorsRemedy } from './cors-remedy';
import {
  canonicalHeaderName,
  createNegotiatingFetch,
  type NegotiatingFetch,
} from './header-negotiation';
import type { McpToolDescriptor, McpToolResult } from './tool-adapter';
import {
  AuthFlowError,
  beginAuthorization,
  discoverAuthorizationServerMetadata,
  discoverIssuerAtResourceOrigin,
  discoverProtectedResourceMetadata,
  exchangeAuthorizationCode,
  refreshAccessToken,
  resolveClient,
  revokeToken,
  selectAuthorizationServer,
  type AuthorizationServerMetadata,
  type ProtectedResourceMetadata,
} from './auth/flow';
import {
  clearClient,
  clearTokens,
  findClientForIssuer,
  readClient,
  readTokens,
  shouldRefresh,
  tokensExpired,
  writeClient,
  writeTokens,
  type StoredClient,
  type StoredTokens,
} from './auth/token-store';
import {
  clientMetadataDocument,
  clientMetadataUrl,
  openAuthorizationPopup,
  redirectToAuthorization,
  redirectUri,
} from './auth/browser';
import { validateCallback, type CallbackParams } from './auth/validation';
import { takePendingRequest } from './auth/token-store';
import { unionScopes } from './auth/discovery';

export type ConnectionState =
  'disconnected' | 'connecting' | 'needs-auth' | 'authorizing' | 'connected' | 'error';

export interface ConnectionSnapshot {
  serverId: string;
  state: ConnectionState;
  tools: McpToolDescriptor[];
  error?: string;
  diagnosis?: Diagnosis;
  issuer?: string;
  grantedScopes?: string;
  tokenExpiresAt?: number;
  /** Whether an access token is stored, regardless of whether it works. */
  hasToken?: boolean;
  /**
   * MCP headers this server's CORS policy rejects, which the client dropped to
   * keep the connection alive. The connection works; the server is misconfigured
   * and its operator should hear about it.
   */
  droppedHeaders?: string[];
}

/**
 * Which authorization server each configured MCP server resolved to. Needed to
 * look up tokens on the next page load without re-running discovery, and to
 * detect an issuer change (spec §7.3 Authorization Server Binding).
 */
const issuerStore = defineStore<Record<string, string>>({
  name: 'mcp-issuers',
  version: 1,
  label: 'Discovered MCP authorization servers',
  fallback: () => ({}),
  parse: safeParser(z.record(z.string(), z.string())),
});

export class AuthorizationRequiredError extends Error {
  constructor() {
    super('The MCP server requires authorization.');
    this.name = 'AuthorizationRequiredError';
  }
}

const MAX_STEP_UP_ATTEMPTS = 3;

export class McpConnection {
  private client?: Client;
  private snapshot: ConnectionSnapshot;
  private listeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private stepUpAttempts = 0;
  private lastChallenge?: { header: string | null; scope?: string };
  private negotiating?: NegotiatingFetch;

  constructor(
    public config: McpServerConfig,
    private fetchFn: typeof fetch = (...args) => fetch(...args)
  ) {
    this.snapshot = { serverId: config.id, state: 'disconnected', tools: [] };
  }

  get state(): ConnectionState {
    return this.snapshot.state;
  }

  getSnapshot(): ConnectionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<ConnectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private issuer(): string | undefined {
    return issuerStore.get()[this.config.id];
  }

  private tokens(): StoredTokens | undefined {
    const issuer = this.issuer();
    return issuer ? readTokens(this.config.id, issuer) : undefined;
  }

  /**
   * Builds the transport, attaching a bearer token when one is held.
   *
   * No stored session id is restored, deliberately. `Client.connect()` returns
   * early when the transport already carries one — it skips `initialize`
   * entirely, so the client never learns the server's capabilities and the
   * `tools/list` right after it fails with "server does not support tools". A
   * fresh handshake on every page load costs one request and always works.
   *
   * Every request goes through a negotiating fetch, so a CORS policy that
   * rejects an optional MCP header degrades the connection instead of killing
   * it (see header-negotiation.ts).
   */
  private buildTransport(token?: string): StreamableHTTPClientTransport {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    return new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: { headers },
      fetch: this.negotiate(),
    });
  }

  /** A fresh negotiating fetch for one transport, reporting what it drops. */
  private negotiate(): NegotiatingFetch {
    const negotiating = createNegotiatingFetch({
      fetchFn: this.fetchFn,
      onDrop: (dropped) => this.emit({ droppedHeaders: [...dropped] }),
    });
    this.negotiating = negotiating;
    return negotiating;
  }

  async connect(): Promise<void> {
    this.emit({ state: 'connecting', error: undefined, diagnosis: undefined });

    let tokens = this.tokens();
    if (tokens && shouldRefresh(tokens, Date.now()) && tokens.refresh_token) {
      tokens = (await this.tryRefresh(tokens)) ?? tokens;
    }
    if (tokens && tokensExpired(tokens, Date.now())) {
      const refreshed = tokens.refresh_token ? await this.tryRefresh(tokens) : undefined;
      tokens = refreshed;
    }

    try {
      await this.open(tokens?.access_token);
      await this.loadTools();

      const issuer = this.issuer();
      this.emit({
        state: 'connected',
        error: undefined,
        hasToken: tokens !== undefined,
        droppedHeaders: [...(this.negotiating?.dropped ?? [])],
        ...(issuer ? { issuer } : {}),
        ...(tokens?.scope ? { grantedScopes: tokens.scope } : {}),
        ...(tokens?.expiresAt ? { tokenExpiresAt: tokens.expiresAt } : {}),
      });
      this.stepUpAttempts = 0;
    } catch (error) {
      await this.handleConnectFailure(error);
    }
  }

  private async open(token?: string): Promise<void> {
    // `capabilities` here describes what the *client* offers the server
    // (sampling, roots, elicitation). ctbx consumes tools; it offers none of
    // those yet, so the set is empty.
    const client = new Client({ name: 'ctbx', version: '0.1.0' }, { capabilities: {} });

    try {
      await client.connect(this.buildTransport(token));
      this.client = client;
    } catch (error) {
      // Deprecated HTTP+SSE servers reject the POST handshake (spec §6.1).
      if (isMethodNotAllowed(error)) {
        const transport = new SSEClientTransport(new URL(this.config.url), {
          requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
          fetch: this.negotiate(),
        });
        await client.connect(transport);
        this.client = client;
        return;
      }
      throw error;
    }
  }

  private async loadTools(): Promise<void> {
    if (!this.client) return;
    const result = await this.client.listTools();
    this.emit({
      tools: result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    });
  }

  private async handleConnectFailure(error: unknown): Promise<void> {
    const tokens = this.tokens();
    const issuer = this.issuer();

    if (isUnauthorized(error)) {
      this.lastChallenge = { header: challengeHeaderOf(error) };
    }

    // Always re-probe, and carry the stored token when we have one. Probing
    // unauthenticated would report "needs authorization" even for a token the
    // server actively rejected — exactly the case the user needs told apart.
    const diagnosis = await diagnoseConnection(this.config.url, this.fetchFn, {
      ...(tokens?.access_token ? { token: tokens.access_token } : {}),
      ...(issuer ? { issuer } : {}),
    });

    if (diagnosis.kind === 'needs-auth' || diagnosis.kind === 'token-rejected') {
      this.emit({
        state: 'needs-auth',
        error: diagnosis.message,
        diagnosis,
        hasToken: tokens !== undefined,
      });
      return;
    }

    // The probe says HTTP is fine, yet the MCP client could not connect. The
    // probe only does the `initialize` POST; the MCP client goes on to send
    // MCP-Protocol-Version (and Mcp-Session-Id) on every later request. If
    // those are not in Access-Control-Allow-Headers, the browser blocks
    // everything after the handshake — a server that looks healthy to a
    // one-shot probe and is still unusable. Report the transport's own error
    // rather than the misleading "ok" message.
    if (diagnosis.kind === 'ok') {
      this.emit({
        state: 'error',
        error: describeHandshakeOnlyFailure(error, this.negotiating?.dropped),
        diagnosis,
        hasToken: tokens !== undefined,
      });
      return;
    }

    this.emit({
      state: 'error',
      error: diagnosis.message,
      diagnosis,
      hasToken: tokens !== undefined,
    });
  }

  /** Runs the full authorization flow (spec §7) and reconnects on success. */
  async authorize(): Promise<void> {
    this.emit({ state: 'authorizing', error: undefined });

    try {
      const resourceMetadata = await this.discoverResource();

      // A resource that names no authorization server is not a dead end: MCP's
      // legacy fallback looks for one at the resource's own origin, which is
      // what every native client does and the only reason those servers work
      // anywhere. `discoverIssuerAtResourceOrigin` only learns the issuer; the
      // issuer-validated discovery below is still what decides to trust it.
      const issuer =
        selectAuthorizationServer(resourceMetadata) ??
        (await discoverIssuerAtResourceOrigin(this.config.url, this.fetchFn));
      const previousIssuer = this.issuer();
      if (previousIssuer && previousIssuer !== issuer) {
        // The authorization server changed: never reuse credentials bound to
        // the old one (spec §7.3 Authorization Server Binding).
        clearTokens(this.config.id, previousIssuer);
        clearClient(this.config.id, previousIssuer);
      }
      issuerStore.update((all) => ({ ...all, [this.config.id]: issuer }));

      const metadata = await discoverAuthorizationServerMetadata(issuer, this.fetchFn);
      const client = await this.resolveClientFor(issuer, metadata);

      const { authorizationUrl } = await beginAuthorization({
        serverId: this.config.id,
        serverUrl: this.config.url,
        redirectUri: redirectUri(),
        client,
        metadata,
        resourceMetadata,
        challengeScope: this.lastChallenge?.scope,
        configuredScopes: this.config.scopes,
      });

      const params = await this.presentAuthorization(authorizationUrl);
      if (!params) return; // redirect path: the app reloads and resumes

      await this.completeAuthorization(params, metadata, client);
    } catch (error) {
      this.emit({
        state: 'needs-auth',
        error: error instanceof Error ? error.message : 'Authorization failed.',
      });
    }
  }

  /**
   * RFC 9728 metadata for the endpoint, or an empty document when it publishes
   * none. Missing metadata is not fatal on its own — the origin fallback can
   * still find the authorization server — so it must not abort the flow before
   * that has been tried.
   */
  private async discoverResource(): Promise<ProtectedResourceMetadata> {
    try {
      const { metadata } = await discoverProtectedResourceMetadata(
        this.config.url,
        this.lastChallenge?.header ?? null,
        this.fetchFn
      );
      return metadata;
    } catch (error) {
      if (error instanceof AuthFlowError && error.code === 'no-protected-resource-metadata') {
        return {};
      }
      throw error;
    }
  }

  private async resolveClientFor(
    issuer: string,
    metadata: AuthorizationServerMetadata
  ): Promise<StoredClient> {
    const stored = readClient(this.config.id, issuer);
    if (stored && !this.config.clientId) return stored;
    if (stored && this.config.clientId === stored.client_id) return stored;

    // Nothing registered for this server yet — but another configured server
    // may already have a client for the same authorization server. Reusing it
    // is what makes the second MCP server behind one realm just work, instead
    // of failing on a registration endpoint that refuses browsers.
    if (!this.config.clientId) {
      const sibling = findClientForIssuer(issuer);
      if (sibling) {
        writeClient(this.config.id, issuer, sibling);
        return sibling;
      }
    }

    const client = await resolveClient({
      configuredClientId: this.config.clientId,
      clientMetadataUrl: clientMetadataUrl(),
      clientMetadata: clientMetadataDocument(),
      metadata,
      redirectUri: redirectUri(),
      fetchFn: this.fetchFn,
    });
    writeClient(this.config.id, issuer, client);
    return client;
  }

  private async presentAuthorization(url: string): Promise<CallbackParams | undefined> {
    try {
      return await openAuthorizationPopup(url);
    } catch (error) {
      if (error instanceof Error && error.message === 'popup-blocked') {
        redirectToAuthorization(url);
        return undefined;
      }
      throw error;
    }
  }

  /** Validates the authorization response and exchanges the code. */
  async completeAuthorization(
    params: CallbackParams,
    metadata?: AuthorizationServerMetadata,
    client?: StoredClient
  ): Promise<void> {
    const validation = validateCallback(params, (state) => takePendingRequest(state));
    if (!validation.ok) {
      this.emit({ state: 'needs-auth', error: validation.message });
      return;
    }

    const { record } = validation;
    const issuer = record.expectedIssuer;
    const resolvedMetadata =
      metadata ?? (await discoverAuthorizationServerMetadata(issuer, this.fetchFn));
    const resolvedClient = client ?? readClient(this.config.id, issuer);
    if (!resolvedClient) {
      this.emit({ state: 'needs-auth', error: 'The client registration was lost. Try again.' });
      return;
    }

    try {
      const tokens = await exchangeAuthorizationCode(validation.code, record.codeVerifier, {
        metadata: resolvedMetadata,
        client: resolvedClient,
        redirectUri: redirectUri(),
        resource: record.resource,
        fetchFn: this.fetchFn,
      });
      writeTokens(this.config.id, issuer, tokens);
      await this.connect();
    } catch (error) {
      this.emit({
        state: 'needs-auth',
        error: error instanceof Error ? error.message : 'The token exchange failed.',
      });
    }
  }

  private async tryRefresh(tokens: StoredTokens): Promise<StoredTokens | undefined> {
    const issuer = this.issuer();
    if (!issuer || !tokens.refresh_token) return undefined;
    const client = readClient(this.config.id, issuer);
    if (!client) return undefined;

    try {
      const metadata = await discoverAuthorizationServerMetadata(issuer, this.fetchFn);
      const refreshed = await refreshAccessToken(tokens.refresh_token, {
        metadata,
        client,
        redirectUri: redirectUri(),
        resource: this.config.url,
        fetchFn: this.fetchFn,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      });
      writeTokens(this.config.id, issuer, refreshed);
      return refreshed;
    } catch {
      return undefined;
    }
  }

  /**
   * Step-up authorization (spec §7.2): on `insufficient_scope`, re-authorize
   * with the union of granted and challenged scopes, bounded by a retry cap.
   */
  async handleInsufficientScope(challengeHeader: string | null): Promise<boolean> {
    if (this.stepUpAttempts >= MAX_STEP_UP_ATTEMPTS) return false;
    this.stepUpAttempts += 1;

    const current = this.tokens()?.scope;
    const challenged = challengeHeader
      ? ((await import('./auth/discovery')).extractChallengeScope(challengeHeader) ?? undefined)
      : undefined;

    this.lastChallenge = {
      header: challengeHeader,
      ...(unionScopes(current, challenged) ? { scope: unionScopes(current, challenged)! } : {}),
    };
    await this.authorize();
    return true;
  }

  /** Probes the endpoint using whatever token is stored for this server. */
  async diagnose(): Promise<Diagnosis> {
    const tokens = this.tokens();
    const issuer = this.issuer();
    const diagnosis = await diagnoseConnection(this.config.url, this.fetchFn, {
      ...(tokens?.access_token ? { token: tokens.access_token } : {}),
      ...(issuer ? { issuer } : {}),
    });
    this.emit({ diagnosis, hasToken: tokens !== undefined });
    return diagnosis;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    if (!this.client) throw new Error(`${this.config.name} is not connected.`);
    const result = await this.client.callTool(
      { name, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      signal ? { signal } : undefined
    );
    return result as McpToolResult;
  }

  async disconnect(revoke = false): Promise<void> {
    const issuer = this.issuer();
    if (revoke && issuer) {
      const tokens = readTokens(this.config.id, issuer);
      const client = readClient(this.config.id, issuer);
      if (tokens && client) {
        try {
          const metadata = await discoverAuthorizationServerMetadata(issuer, this.fetchFn);
          await revokeToken(tokens.access_token, metadata, client, this.fetchFn);
        } catch {
          /* revocation is best effort */
        }
      }
      clearTokens(this.config.id);
      clearClient(this.config.id);
    }

    try {
      await this.client?.close();
    } catch {
      /* already gone */
    }
    this.client = undefined;
    this.negotiating = undefined;
    this.emit({ state: 'disconnected', tools: [], error: undefined, droppedHeaders: [] });
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Message for the case where a plain `initialize` POST succeeds but the MCP
 * client still cannot connect. The post-handshake headers are the usual cause,
 * but the client now retries without the ones it can drop — so when that
 * happened and the connection still failed, saying so rules the theory out
 * instead of sending the operator after a header that is already handled.
 */
export function describeHandshakeOnlyFailure(
  error: unknown,
  dropped: readonly string[] = []
): string {
  if (dropped.length > 0) {
    const names = dropped.map(canonicalHeaderName).join(', ');
    return [
      'The endpoint answered the initial handshake, but the MCP session could not be established.',
      '',
      `This is not the usual CORS header problem: the browser refused ${names}, and retrying without ${dropped.length === 1 ? 'it' : 'them'} did not help either. Something later in the session is failing — check the server log for what it did with the request after the handshake.`,
      '',
      `Transport error: ${errorText(error)}`,
    ].join('\n');
  }

  return [
    'The endpoint answered the initial handshake, but the MCP session could not be established.',
    '',
    'The usual cause is that the MCP client sends MCP-Protocol-Version — and Mcp-Session-Id once a session exists — on every request after the handshake. If those are not listed in Access-Control-Allow-Headers, the browser blocks them, so the first request appears to succeed and everything after it fails.',
    '',
    mcpEndpointCorsRemedy(),
    '',
    `Transport error: ${errorText(error)}`,
  ].join('\n');
}

export function isUnauthorized(error: unknown): boolean {
  const text = errorText(error);
  if (/\b401\b|unauthorized/i.test(text)) return true;
  const status = (error as { code?: number; status?: number })?.status;
  return status === 401;
}

export function isMethodNotAllowed(error: unknown): boolean {
  const text = errorText(error);
  return /\b405\b|method not allowed/i.test(text);
}

export function challengeHeaderOf(error: unknown): string | null {
  const record = error as { headers?: Headers; response?: { headers?: Headers } } | null;
  const headers = record?.headers ?? record?.response?.headers;
  return headers?.get?.('WWW-Authenticate') ?? null;
}

export { issuerStore };
