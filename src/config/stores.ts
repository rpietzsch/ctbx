import { defineStore } from '@/storage/local';
import {
  DEFAULT_PREFERENCES,
  mcpServersSchema,
  preferencesSchema,
  providerConfigsSchema,
  safeParser,
  type McpServerConfig,
  type Preferences,
  type ProviderConfig,
  type ProviderConfigs,
  type ProviderId,
} from './schema';

/**
 * Provider API keys. Marked `secret`: this is the store that G3 is about, and
 * the one "forget keys" and the transparency screen key off.
 */
export const providerConfigStore = defineStore<ProviderConfigs>({
  name: 'providers',
  version: 1,
  label: 'Provider API keys and endpoints',
  secret: true,
  fallback: () => ({}),
  parse: safeParser(providerConfigsSchema),
});

export const mcpServerStore = defineStore<McpServerConfig[]>({
  name: 'mcp-servers',
  version: 1,
  label: 'Configured MCP servers',
  fallback: () => [],
  parse: safeParser(mcpServersSchema),
});

/** The `maxSteps` default before it was raised to 30. See the migration below. */
const PREVIOUS_DEFAULT_MAX_STEPS = 10;

export const preferencesStore = defineStore<Preferences>({
  name: 'preferences',
  version: 2,
  label: 'Application preferences',
  fallback: () => DEFAULT_PREFERENCES,
  parse: safeParser(preferencesSchema),
  /**
   * v1 → v2: the per-turn step budget went from 10 to 30.
   *
   * Raising the schema default alone would change nothing for anyone who has
   * already used the app: every write of any preference persists the whole
   * object, so an existing install has `maxSteps: 10` on disk and would keep it
   * forever. Nothing in the UI can set this value, so a stored 10 is the old
   * default rather than a decision — which makes raising it the point of the
   * bump. Any other value was set by hand and is left alone.
   */
  migrate: (previous, fromVersion) => {
    if (fromVersion >= 2 || typeof previous !== 'object' || previous === null) return previous;
    const record = previous as Record<string, unknown>;
    if (record.maxSteps !== PREVIOUS_DEFAULT_MAX_STEPS) return record;
    return { ...record, maxSteps: DEFAULT_PREFERENCES.maxSteps };
  },
});

export function getProviderConfig(id: ProviderId): ProviderConfig | undefined {
  return providerConfigStore.get()[id];
}

export function setProviderConfig(config: ProviderConfig): void {
  providerConfigStore.update((current) => ({ ...current, [config.providerId]: config }));
}

export function forgetProvider(id: ProviderId): void {
  providerConfigStore.update((current) => {
    const next = { ...current };
    delete next[id];
    return next;
  });
}

/** Providers that have a non-empty key and are enabled. */
export function configuredProviders(): ProviderConfig[] {
  return Object.values(providerConfigStore.get()).filter(
    (config): config is ProviderConfig => !!config && config.enabled && config.apiKey.length > 0
  );
}

export function upsertMcpServer(server: McpServerConfig): void {
  mcpServerStore.update((servers) => {
    const index = servers.findIndex((s) => s.id === server.id);
    if (index === -1) return [...servers, server];
    return servers.map((s, i) => (i === index ? server : s));
  });
}

export function removeMcpServer(id: string): void {
  mcpServerStore.update((servers) => servers.filter((s) => s.id !== id));
}

export function setMcpServerEnabled(id: string, enabled: boolean): void {
  mcpServerStore.update((servers) =>
    servers.map((server) => (server.id === id ? { ...server, enabled } : server))
  );
}

/**
 * Pre-approval toggles. Keys are opaque strings here — `serverId:toolName` and
 * `serverId:category`, built by the MCP layer that owns those shapes.
 */
function toggleIn(list: readonly string[], key: string, allowed: boolean): string[] {
  const without = list.filter((entry) => entry !== key);
  return allowed ? [...without, key] : without;
}

export function setToolAlwaysAllowed(key: string, allowed: boolean): void {
  preferencesStore.update((current) => ({
    ...current,
    alwaysAllowedTools: toggleIn(current.alwaysAllowedTools, key, allowed),
  }));
}

export function setModelPickerToolsOnly(toolsOnly: boolean): void {
  preferencesStore.update((current) => ({ ...current, modelPickerToolsOnly: toolsOnly }));
}

export function setToolCategoryAlwaysAllowed(key: string, allowed: boolean): void {
  preferencesStore.update((current) => ({
    ...current,
    alwaysAllowedToolCategories: toggleIn(current.alwaysAllowedToolCategories, key, allowed),
  }));
}
