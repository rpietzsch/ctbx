import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { defineStore } from '@/storage/local';
import { safeParser, type ProviderId } from '@/config/schema';
import { getProviderConfig } from '@/config/stores';
import { PROVIDER_DEFINITIONS } from './definitions';
import { ProviderRequestError, type ModelInfo, type ProviderDefinition } from './types';

const definitionsById = new Map<ProviderId, ProviderDefinition>(
  PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition])
);

export function getDefinition(id: ProviderId): ProviderDefinition {
  const definition = definitionsById.get(id);
  if (!definition) throw new Error(`Unknown provider: ${id}`);
  return definition;
}

export function allDefinitions(): ProviderDefinition[] {
  return PROVIDER_DEFINITIONS;
}

/**
 * Builds the AI SDK model. This is the only place provider differences are
 * allowed to matter; everything downstream sees a plain `LanguageModel`
 * (spec §5.1).
 */
export function resolveModel(providerId: ProviderId, modelId: string): LanguageModel {
  const config = getProviderConfig(providerId);
  if (!config || config.apiKey === '') {
    throw new ProviderRequestError(`No API key configured for ${getDefinition(providerId).label}.`);
  }
  return getDefinition(providerId).createModel(config, modelId);
}

// ---------------------------------------------------------------- model cache

export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const modelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  contextWindow: z.number().optional(),
  pricing: z
    .object({ prompt: z.number().optional(), completion: z.number().optional() })
    .optional(),
  supportsTools: z.boolean(),
});

const modelCacheSchema = z.record(
  z.string(),
  z.object({ fetchedAt: z.number(), models: z.array(modelInfoSchema) })
);

type ModelCache = z.infer<typeof modelCacheSchema>;

export const modelCacheStore = defineStore<ModelCache>({
  name: 'model-cache',
  version: 1,
  label: 'Cached provider model lists',
  fallback: () => ({}),
  parse: safeParser(modelCacheSchema),
});

export function isCacheFresh(fetchedAt: number, now: number): boolean {
  return now - fetchedAt < MODEL_CACHE_TTL_MS && now >= fetchedAt;
}

export interface ListModelsResult {
  models: ModelInfo[];
  source: 'cache' | 'network' | 'fallback';
  error?: string;
}

/**
 * Returns the provider's models, preferring a fresh cache. On network failure
 * it degrades to a stale cache, then to the definition's static fallback list,
 * so the picker is never empty. The `source` field lets the UI be honest about
 * which of those happened.
 */
export async function listModels(
  providerId: ProviderId,
  options: { force?: boolean; now?: number; signal?: AbortSignal } = {}
): Promise<ListModelsResult> {
  const definition = getDefinition(providerId);
  const now = options.now ?? Date.now();
  const cached = modelCacheStore.get()[providerId];

  if (!options.force && cached && isCacheFresh(cached.fetchedAt, now)) {
    return { models: cached.models, source: 'cache' };
  }

  const config = getProviderConfig(providerId) ?? {
    providerId,
    apiKey: '',
    enabled: true,
  };

  try {
    const models = await definition.listModels(config, options.signal);
    if (models.length === 0) throw new ProviderRequestError('The provider returned no models.');
    modelCacheStore.update((cache) => ({ ...cache, [providerId]: { fetchedAt: now, models } }));
    return { models, source: 'network' };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'Could not load the model list.';
    if (cached) return { models: cached.models, source: 'cache', error };
    return { models: definition.fallbackModels, source: 'fallback', error };
  }
}

/**
 * Confirms a key works by making the cheapest authenticated call the provider
 * offers. OpenRouter's model list is unauthenticated, so it is validated
 * against the credits endpoint instead.
 */
export async function validateKey(
  providerId: ProviderId,
  apiKey: string,
  signal?: AbortSignal
): Promise<{ ok: true } | { ok: false; error: string }> {
  const definition = getDefinition(providerId);
  const config = { providerId, apiKey, enabled: true };

  try {
    if (providerId === 'openrouter') {
      const response = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: signal ?? null,
      });
      if (!response.ok) {
        const { describeHttpError } = await import('./definitions');
        return { ok: false, error: describeHttpError(response.status) };
      }
      return { ok: true };
    }

    await definition.listModels(config, signal);
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : 'The key could not be validated.',
    };
  }
}

/** Filters to tool-capable models when MCP tools are in play (spec §5.3). */
export function filterModels(models: ModelInfo[], requireTools: boolean): ModelInfo[] {
  return requireTools ? models.filter((model) => model.supportsTools) : models;
}
