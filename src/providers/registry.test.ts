import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_CACHE_TTL_MS,
  filterModels,
  getDefinition,
  isCacheFresh,
  listModels,
  modelCacheStore,
} from './registry';
import { openrouterDefinition } from './definitions';
import { setProviderConfig, providerConfigStore } from '@/config/stores';
import type { ModelInfo } from './types';

const NOW = 1_700_000_000_000;

const NETWORK_MODELS: ModelInfo[] = [
  { id: 'a/one', label: 'One', supportsTools: true },
  { id: 'a/two', label: 'Two', supportsTools: false },
];

beforeEach(() => {
  localStorage.clear();
  modelCacheStore.remove();
  providerConfigStore.remove();
});

describe('isCacheFresh', () => {
  it('is fresh inside the TTL', () => {
    expect(isCacheFresh(NOW, NOW)).toBe(true);
    expect(isCacheFresh(NOW, NOW + MODEL_CACHE_TTL_MS - 1)).toBe(true);
  });

  it('is stale at and beyond the TTL', () => {
    expect(isCacheFresh(NOW, NOW + MODEL_CACHE_TTL_MS)).toBe(false);
  });

  it('treats a future timestamp as stale rather than trusting a skewed clock', () => {
    expect(isCacheFresh(NOW, NOW - 1)).toBe(false);
  });
});

describe('listModels', () => {
  it('fetches from the network and caches the result', async () => {
    const spy = vi.spyOn(openrouterDefinition, 'listModels').mockResolvedValue(NETWORK_MODELS);

    const result = await listModels('openrouter', { now: NOW });

    expect(result.source).toBe('network');
    expect(result.models).toEqual(NETWORK_MODELS);
    expect(modelCacheStore.get().openrouter).toEqual({ fetchedAt: NOW, models: NETWORK_MODELS });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('serves a fresh cache without touching the network', async () => {
    modelCacheStore.set({ openrouter: { fetchedAt: NOW, models: NETWORK_MODELS } });
    const spy = vi.spyOn(openrouterDefinition, 'listModels');

    const result = await listModels('openrouter', { now: NOW + 1000 });

    expect(result.source).toBe('cache');
    expect(spy).not.toHaveBeenCalled();
  });

  it('refetches once the cache is stale', async () => {
    modelCacheStore.set({ openrouter: { fetchedAt: NOW, models: [] } });
    const spy = vi.spyOn(openrouterDefinition, 'listModels').mockResolvedValue(NETWORK_MODELS);

    const result = await listModels('openrouter', { now: NOW + MODEL_CACHE_TTL_MS });

    expect(result.source).toBe('network');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('force bypasses a fresh cache', async () => {
    modelCacheStore.set({ openrouter: { fetchedAt: NOW, models: [] } });
    const spy = vi.spyOn(openrouterDefinition, 'listModels').mockResolvedValue(NETWORK_MODELS);

    await listModels('openrouter', { now: NOW, force: true });

    expect(spy).toHaveBeenCalledOnce();
  });

  it('falls back to a stale cache when the network fails, and reports the error', async () => {
    modelCacheStore.set({ openrouter: { fetchedAt: NOW, models: NETWORK_MODELS } });
    vi.spyOn(openrouterDefinition, 'listModels').mockRejectedValue(new Error('offline'));

    const result = await listModels('openrouter', { now: NOW + MODEL_CACHE_TTL_MS });

    expect(result.source).toBe('cache');
    expect(result.models).toEqual(NETWORK_MODELS);
    expect(result.error).toBe('offline');
  });

  it('falls back to the static list when there is no cache at all', async () => {
    vi.spyOn(openrouterDefinition, 'listModels').mockRejectedValue(new Error('offline'));

    const result = await listModels('openrouter', { now: NOW });

    expect(result.source).toBe('fallback');
    expect(result.models).toEqual(openrouterDefinition.fallbackModels);
    expect(result.error).toBe('offline');
  });

  it('treats an empty model list as a failure rather than caching nothing', async () => {
    vi.spyOn(openrouterDefinition, 'listModels').mockResolvedValue([]);

    const result = await listModels('openrouter', { now: NOW });

    expect(result.source).toBe('fallback');
    expect(modelCacheStore.get().openrouter).toBeUndefined();
  });

  it('passes the stored config to the definition', async () => {
    setProviderConfig({ providerId: 'openrouter', apiKey: 'sk-or-test', enabled: true });
    const spy = vi.spyOn(openrouterDefinition, 'listModels').mockResolvedValue(NETWORK_MODELS);

    await listModels('openrouter', { now: NOW });

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ apiKey: 'sk-or-test' });
  });
});

describe('filterModels', () => {
  it('keeps only tool-capable models when tools are required', () => {
    expect(filterModels(NETWORK_MODELS, true).map((m) => m.id)).toEqual(['a/one']);
  });

  it('keeps everything when tools are not required', () => {
    expect(filterModels(NETWORK_MODELS, false)).toHaveLength(2);
  });
});

describe('getDefinition', () => {
  it('resolves every declared provider', () => {
    for (const id of ['openrouter', 'openai', 'anthropic', 'google'] as const) {
      expect(getDefinition(id).id).toBe(id);
    }
  });

  it('throws on an unknown provider', () => {
    expect(() => getDefinition('nope' as never)).toThrow(/Unknown provider/);
  });

  it('marks Anthropic with a browser caveat', () => {
    expect(getDefinition('anthropic').browserNote).toMatch(/browser/i);
  });
});
