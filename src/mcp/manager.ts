import type { ToolSet } from 'ai';
import type { McpServerConfig, ToolApprovalMode } from '@/config/schema';
import { mcpServerStore, preferencesStore } from '@/config/stores';
import { McpConnection, type ConnectionSnapshot } from './connection';
import { buildTools, uniqueSlugs, type AdaptableServer, type ApprovalGate } from './tool-adapter';
import { takeRedirectResult } from './auth/browser';

/**
 * Owns one connection per configured MCP server and aggregates their tools
 * into a single ToolSet for the conversation engine (spec §6.3).
 */
export class McpManager {
  private connections = new Map<string, McpConnection>();
  private listeners = new Set<() => void>();

  constructor(private gate: ApprovalGate) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Reconciles live connections against the stored configuration.
   *
   * A disabled server is treated exactly like a removed one: its connection is
   * closed and dropped. That is what makes the toggle meaningful — leaving the
   * connection open would keep feeding the model tools the user just switched
   * off.
   */
  sync(): void {
    const configs = mcpServerStore.get();
    const seen = new Set<string>();

    for (const config of configs) {
      if (!config.enabled) continue;
      seen.add(config.id);
      const existing = this.connections.get(config.id);
      if (!existing) {
        const connection = new McpConnection(config);
        connection.subscribe(() => this.notify());
        this.connections.set(config.id, connection);
      } else {
        existing.config = config;
      }
    }

    for (const [id, connection] of this.connections) {
      if (!seen.has(id)) {
        void connection.disconnect();
        this.connections.delete(id);
      }
    }

    this.notify();
  }

  get(id: string): McpConnection | undefined {
    return this.connections.get(id);
  }

  list(): McpConnection[] {
    return [...this.connections.values()];
  }

  snapshots(): ConnectionSnapshot[] {
    return this.list().map((connection) => connection.getSnapshot());
  }

  async connect(id: string): Promise<void> {
    await this.connections.get(id)?.connect();
  }

  async connectAutoStart(): Promise<void> {
    await Promise.all(
      this.list()
        .filter((connection) => connection.config.enabled && connection.config.autoConnect)
        .map((connection) => connection.connect())
    );
  }

  async disconnect(id: string, revoke = false): Promise<void> {
    await this.connections.get(id)?.disconnect(revoke);
  }

  /**
   * Resumes an authorization that used the full-page redirect fallback. Called
   * once on boot, before connections are opened (spec §7.5).
   */
  async resumeRedirectAuthorization(): Promise<boolean> {
    const params = takeRedirectResult();
    if (!params) return false;

    // The pending record names the server, so the result is routed even though
    // the app has been reloaded and lost its in-memory state.
    for (const connection of this.list()) {
      await connection.completeAuthorization(params);
      if (connection.state === 'connected') return true;
    }
    return true;
  }

  /** Connected servers, in the shape the tool adapter consumes. */
  private adaptableServers(): AdaptableServer[] {
    const connected = this.list().filter(
      (connection) => connection.getSnapshot().state === 'connected'
    );
    const slugs = uniqueSlugs(
      connected.map((connection) => ({ id: connection.config.id, name: connection.config.name }))
    );

    return connected.map((connection) => ({
      id: connection.config.id,
      name: connection.config.name,
      slug: slugs.get(connection.config.id) ?? connection.config.id,
      tools: connection.getSnapshot().tools,
      callTool: (name, args, signal) => connection.callTool(name, args, signal),
    }));
  }

  /** The aggregated ToolSet handed to `streamText`. */
  tools(overrides?: { approvalMode?: ToolApprovalMode }): ToolSet {
    return buildTools(this.adaptableServers(), {
      // Re-read on every call: the ToolSet outlives any single preference
      // change, and a pre-approval made mid-turn has to take effect at once.
      policy: () => {
        const preferences = preferencesStore.get();
        return {
          mode: overrides?.approvalMode ?? preferences.toolApproval,
          alwaysAllowedTools: preferences.alwaysAllowedTools,
          alwaysAllowedCategories: preferences.alwaysAllowedToolCategories,
        };
      },
      gate: this.gate,
      onAlwaysAllow: (serverId, toolName) => {
        preferencesStore.update((current) => ({
          ...current,
          alwaysAllowedTools: [
            ...new Set([...current.alwaysAllowedTools, `${serverId}:${toolName}`]),
          ],
        }));
      },
    });
  }

  hasConnectedServers(): boolean {
    return this.list().some((connection) => connection.getSnapshot().state === 'connected');
  }

  toolCount(): number {
    return this.adaptableServers().reduce((total, server) => total + server.tools.length, 0);
  }
}

export function createServerConfig(partial: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: partial.id ?? globalThis.crypto.randomUUID(),
    name: partial.name ?? 'New server',
    url: partial.url ?? '',
    ...(partial.clientId ? { clientId: partial.clientId } : {}),
    ...(partial.scopes ? { scopes: partial.scopes } : {}),
    enabled: partial.enabled ?? true,
    autoConnect: partial.autoConnect ?? false,
  };
}
