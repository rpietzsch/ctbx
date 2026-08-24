import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpServerStore } from '@/config/stores';
import { McpManager, createServerConfig } from './manager';
import { REDIRECT_RESULT_KEY } from './auth/browser';
import { peekPendingRequest, savePendingRequest } from './auth/token-store';
import { AUTHORIZATION_REQUEST_TTL_MS } from './auth/validation';

const gate = { request: vi.fn(async () => ({ approved: true as const })) };

function server(overrides: Partial<ReturnType<typeof createServerConfig>> = {}) {
  return createServerConfig({
    id: 'srv-1',
    name: 'Corporate Memory',
    url: 'https://x/mcp',
    ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
  mcpServerStore.remove();
});

describe('McpManager.sync', () => {
  it('opens a connection slot for an enabled server', () => {
    mcpServerStore.set([server()]);
    const manager = new McpManager(gate);
    manager.sync();
    expect(manager.list()).toHaveLength(1);
  });

  /**
   * The point of the toggle: a disabled server must not keep a live connection,
   * because its tools would still reach the model.
   */
  it('drops the connection when a server is disabled', () => {
    mcpServerStore.set([server()]);
    const manager = new McpManager(gate);
    manager.sync();

    mcpServerStore.set([server({ enabled: false })]);
    manager.sync();

    expect(manager.list()).toHaveLength(0);
    expect(manager.get('srv-1')).toBeUndefined();
    expect(manager.toolCount()).toBe(0);
  });

  it('never creates one for a server that starts out disabled', () => {
    mcpServerStore.set([server({ enabled: false })]);
    const manager = new McpManager(gate);
    manager.sync();
    expect(manager.list()).toHaveLength(0);
  });

  it('restores the connection slot when the server is enabled again', () => {
    mcpServerStore.set([server({ enabled: false })]);
    const manager = new McpManager(gate);
    manager.sync();

    mcpServerStore.set([server({ enabled: true })]);
    manager.sync();

    expect(manager.get('srv-1')).toBeDefined();
  });

  it('leaves other servers alone', () => {
    mcpServerStore.set([server(), server({ id: 'srv-2', name: 'Other' })]);
    const manager = new McpManager(gate);
    manager.sync();

    mcpServerStore.set([server({ enabled: false }), server({ id: 'srv-2', name: 'Other' })]);
    manager.sync();

    expect(manager.list().map((c) => c.config.id)).toEqual(['srv-2']);
  });
});

/**
 * Routing the OAuth callback. The record is single-use, so a response handed to
 * the wrong connection is not merely ignored — it is destroyed for the server
 * that owns it, and when one endpoint is configured twice under two accounts
 * the token it yields is audience-valid for the wrong slot.
 */
describe('McpManager.resumeRedirectAuthorization', () => {
  const STATE = 'state-for-the-second-server';

  /** Two configs on one endpoint: the same-account-twice setup. */
  function twoAccountsOnOneEndpoint() {
    mcpServerStore.set([
      server({ id: 'srv-1', name: 'Corporate Memory (A)' }),
      server({ id: 'srv-2', name: 'Corporate Memory (B)' }),
    ]);
    const manager = new McpManager(gate);
    manager.sync();
    return manager;
  }

  function pendingFor(serverId: string) {
    savePendingRequest({
      serverId,
      state: STATE,
      codeVerifier: 'verifier',
      expectedIssuer: 'https://auth.example.com',
      issParameterSupported: false,
      resource: 'https://x/mcp',
      createdAt: Date.now(),
    });
  }

  function redirectResult(search: string) {
    sessionStorage.setItem(REDIRECT_RESULT_KEY, JSON.stringify({ search }));
  }

  function spyOnCompletions(manager: McpManager) {
    return new Map(
      manager
        .list()
        .map((connection) => [
          connection.config.id,
          vi.spyOn(connection, 'completeAuthorization').mockResolvedValue(undefined),
        ])
    );
  }

  it('hands the response to the server that started it, not the first one', async () => {
    const manager = twoAccountsOnOneEndpoint();
    const spies = spyOnCompletions(manager);
    pendingFor('srv-2');
    redirectResult(`?code=abc&state=${STATE}`);

    await manager.resumeRedirectAuthorization();

    expect(spies.get('srv-1')).not.toHaveBeenCalled();
    expect(spies.get('srv-2')).toHaveBeenCalledOnce();
  });

  it('leaves the pending record intact for its owner', async () => {
    const manager = twoAccountsOnOneEndpoint();
    spyOnCompletions(manager);
    pendingFor('srv-2');
    redirectResult(`?code=abc&state=${STATE}`);

    await manager.resumeRedirectAuthorization();

    expect(peekPendingRequest(STATE)?.serverId).toBe('srv-2');
  });

  it('touches nobody when the state matches no pending request', async () => {
    const manager = twoAccountsOnOneEndpoint();
    const spies = spyOnCompletions(manager);
    redirectResult('?code=abc&state=unknown');

    expect(await manager.resumeRedirectAuthorization()).toBe(true);
    for (const spy of spies.values()) expect(spy).not.toHaveBeenCalled();
  });

  it('touches nobody when the response carries no state at all', async () => {
    const manager = twoAccountsOnOneEndpoint();
    const spies = spyOnCompletions(manager);
    redirectResult('?error=access_denied');

    await manager.resumeRedirectAuthorization();

    for (const spy of spies.values()) expect(spy).not.toHaveBeenCalled();
  });

  it('reports nothing to resume when no redirect happened', async () => {
    const manager = twoAccountsOnOneEndpoint();
    expect(await manager.resumeRedirectAuthorization()).toBe(false);
  });

  it('drops a response whose server is no longer configured', async () => {
    const manager = twoAccountsOnOneEndpoint();
    const spies = spyOnCompletions(manager);
    pendingFor('srv-removed');
    redirectResult(`?code=abc&state=${STATE}`);

    await manager.resumeRedirectAuthorization();

    for (const spy of spies.values()) expect(spy).not.toHaveBeenCalled();
  });
});

describe('McpManager pending-request hygiene', () => {
  it('drops abandoned requests, which hold a PKCE verifier', async () => {
    mcpServerStore.set([server()]);
    const manager = new McpManager(gate);
    manager.sync();

    savePendingRequest({
      serverId: 'srv-1',
      state: 'abandoned',
      codeVerifier: 'verifier',
      expectedIssuer: 'https://auth.example.com',
      issParameterSupported: false,
      resource: 'https://x/mcp',
      createdAt: Date.now() - AUTHORIZATION_REQUEST_TTL_MS - 1,
    });
    sessionStorage.setItem(REDIRECT_RESULT_KEY, JSON.stringify({ search: '?state=unknown' }));

    await manager.resumeRedirectAuthorization();

    expect(peekPendingRequest('abandoned')).toBeUndefined();
  });

  it('keeps a request that is still within its lifetime', async () => {
    mcpServerStore.set([server()]);
    const manager = new McpManager(gate);
    manager.sync();

    savePendingRequest({
      serverId: 'srv-1',
      state: 'fresh',
      codeVerifier: 'verifier',
      expectedIssuer: 'https://auth.example.com',
      issParameterSupported: false,
      resource: 'https://x/mcp',
      createdAt: Date.now(),
    });
    sessionStorage.setItem(REDIRECT_RESULT_KEY, JSON.stringify({ search: '?state=unknown' }));

    await manager.resumeRedirectAuthorization();

    expect(peekPendingRequest('fresh')).toBeDefined();
  });
});
