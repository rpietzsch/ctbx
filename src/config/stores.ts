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

export const preferencesStore = defineStore<Preferences>({
  name: 'preferences',
  version: 1,
  label: 'Application preferences',
  fallback: () => DEFAULT_PREFERENCES,
  parse: safeParser(preferencesSchema),
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
