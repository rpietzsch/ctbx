import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpServerStore } from '@/config/stores';
import { McpManager, createServerConfig } from './manager';

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
