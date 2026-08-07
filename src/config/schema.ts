import { z } from 'zod';

/** Providers with a first-class definition. See tasks/spec.md §5.2. */
export const PROVIDER_IDS = ['openrouter', 'openai', 'anthropic', 'google'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const providerIdSchema = z.enum(PROVIDER_IDS);

export const providerConfigSchema = z.object({
  providerId: providerIdSchema,
  apiKey: z.string().default(''),
  /** Override for gateways or self-hosted OpenAI-compatible endpoints. */
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

// `z.record` with an enum key is exhaustive in zod 4 — it would reject a config
// holding only some providers. `partialRecord` is the one that models "any
// subset of providers may be configured".
export const providerConfigsSchema = z.partialRecord(providerIdSchema, providerConfigSchema);
export type ProviderConfigs = Partial<Record<ProviderId, ProviderConfig>>;

/**
 * An MCP server as the user configures it: name, endpoint IRI, and an optional
 * pre-registered client ID. Everything else is discovered. See spec §6.2 / §7.3.
 */
export const mcpServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  /** Priority-1 pre-registration; omitted means CIMD or DCR. */
  clientId: z.string().min(1).optional(),
  /** Manual scope override; normally discovered. */
  scopes: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  autoConnect: z.boolean().default(false),
});
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const mcpServersSchema = z.array(mcpServerConfigSchema);

/**
 * How tool calls are gated. `always` is the default and the security boundary
 * described in spec §6.4 / §9.3 — it is deliberately the safest option.
 */
export const toolApprovalModeSchema = z.enum(['always', 'session', 'never']);
export type ToolApprovalMode = z.infer<typeof toolApprovalModeSchema>;

export const preferencesSchema = z.object({
  defaultProviderId: providerIdSchema.optional(),
  defaultModelId: z.string().optional(),
  /** Upper bound on tool-call round trips per turn (spec §6.4). */
  maxSteps: z.number().int().min(1).max(50).default(10),
  toolApproval: toolApprovalModeSchema.default('always'),
  /** Tools the user marked "always allow", as `serverId:toolName`. */
  alwaysAllowedTools: z.array(z.string()).default([]),
  sendOnEnter: z.boolean().default(true),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = preferencesSchema.parse({});

/** Parses with a zod schema, returning `undefined` instead of throwing. */
export function safeParser<T>(schema: z.ZodType<T>): (raw: unknown) => T | undefined {
  return (raw) => {
    const result = schema.safeParse(raw);
    return result.success ? result.data : undefined;
  };
}
