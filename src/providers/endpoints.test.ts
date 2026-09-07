import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENDPOINT_CACHE_TTL_MS,
  clearEndpointCache,
  findEndpoint,
  listEndpoints,
  defaultDirectionFor,
  oppositeOf,
  searchEndpoints,
  sortEndpoints,
} from './endpoints';
import { anthropicDefinition, openrouterDefinition } from './definitions';
import { modelCacheStore } from './registry';
import type { ModelEndpoint } from './types';

const NOW = 1_700_000_000_000;

function endpoint(
  tag: string,
  prompt?: number,
  completion?: number,
  extra: Partial<ModelEndpoint> = {}
): ModelEndpoint {
  return {
    tag,
    providerName: tag,
    degraded: false,
    supportsTools: true,
    ...(prompt === undefined && completion === undefined
      ? {}
      : { pricing: { prompt, completion } }),
    ...extra,
  };
}

beforeEach(() => {
  clearEndpointCache();
  localStorage.clear();
  modelCacheStore.remove();
  vi.restoreAllMocks();
  // The slug lookup goes through the model list; stub it so no test reaches
  // the network to answer a question it does not care about.
  vi.spyOn(openrouterDefinition, 'listModels').mockResolvedValue([
    { id: 'm', label: 'M', supportsTools: true },
  ]);
});

describe('listEndpoints', () => {
  it('reports providers that do not route instead of calling out', async () => {
    const result = await listEndpoints('anthropic', 'claude-opus-4');
    expect(result).toEqual({ endpoints: [], source: 'unsupported' });
    expect(anthropicDefinition.listEndpoints).toBeUndefined();
  });

  it('caches within the TTL and refetches after it', async () => {
    const spy = vi
      .spyOn(openrouterDefinition, 'listEndpoints')
      .mockResolvedValue([endpoint('reka/fp8', 1e-6)]);

    expect((await listEndpoints('openrouter', 'm', { now: NOW })).source).toBe('network');
    expect((await listEndpoints('openrouter', 'm', { now: NOW + 1 })).source).toBe('cache');
    expect(spy).toHaveBeenCalledTimes(1);

    expect(
      (await listEndpoints('openrouter', 'm', { now: NOW + ENDPOINT_CACHE_TTL_MS })).source
    ).toBe('network');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('passes the versioned slug down so the speed figures can be looked up', async () => {
    vi.spyOn(openrouterDefinition, 'listModels').mockResolvedValue([
      { id: 'm', label: 'M', supportsTools: true, canonicalSlug: 'author/m-20260101' },
    ]);
    const spy = vi
      .spyOn(openrouterDefinition, 'listEndpoints')
      .mockResolvedValue([endpoint('reka/fp8', 1e-6)]);

    await listEndpoints('openrouter', 'm', { now: NOW });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ canonicalSlug: 'author/m-20260101' });
  });

  it('asks for the endpoints anyway when the model has no versioned slug', async () => {
    const spy = vi
      .spyOn(openrouterDefinition, 'listEndpoints')
      .mockResolvedValue([endpoint('reka/fp8', 1e-6)]);

    const result = await listEndpoints('openrouter', 'm', { now: NOW });
    expect(result.endpoints).toHaveLength(1);
    expect(spy.mock.calls[0]?.[1]?.canonicalSlug).toBeUndefined();
  });

  it('caches per model, so one model does not answer for another', async () => {
    const spy = vi
      .spyOn(openrouterDefinition, 'listEndpoints')
      .mockResolvedValue([endpoint('reka/fp8', 1e-6)]);

    await listEndpoints('openrouter', 'one', { now: NOW });
    await listEndpoints('openrouter', 'two', { now: NOW });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('returns the error rather than throwing, so the model stays usable', async () => {
    vi.spyOn(openrouterDefinition, 'listEndpoints').mockRejectedValue(new Error('offline'));
    const result = await listEndpoints('openrouter', 'm', { now: NOW });
    expect(result).toEqual({ endpoints: [], source: 'network', error: 'offline' });
  });

  it('falls back to a stale list when the refresh fails', async () => {
    const spy = vi
      .spyOn(openrouterDefinition, 'listEndpoints')
      .mockResolvedValue([endpoint('reka/fp8', 1e-6)]);
    await listEndpoints('openrouter', 'm', { now: NOW });

    spy.mockRejectedValue(new Error('offline'));
    const result = await listEndpoints('openrouter', 'm', { now: NOW, force: true });
    expect(result.source).toBe('cache');
    expect(result.endpoints).toHaveLength(1);
    expect(result.error).toBe('offline');
  });

  it('treats a future timestamp as stale rather than trusting a skewed clock', async () => {
    const spy = vi
      .spyOn(openrouterDefinition, 'listEndpoints')
      .mockResolvedValue([endpoint('reka/fp8', 1e-6)]);
    await listEndpoints('openrouter', 'm', { now: NOW });
    expect((await listEndpoints('openrouter', 'm', { now: NOW - 1 })).source).toBe('network');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('sortEndpoints', () => {
  it('defaults to the cheapest input price first', () => {
    const sorted = sortEndpoints([
      endpoint('c', 3e-6, 1e-6),
      endpoint('a', 1e-6, 4e-6),
      endpoint('b', 2e-6, 1e-6),
    ]);
    expect(sorted.map((e) => e.tag)).toEqual(['a', 'b', 'c']);
  });

  it('breaks an input-price tie on output price', () => {
    const sorted = sortEndpoints([endpoint('b', 1e-6, 9e-6), endpoint('a', 1e-6, 2e-6)]);
    expect(sorted.map((e) => e.tag)).toEqual(['a', 'b']);
  });

  it('sorts by provider name, not by tag', () => {
    const sorted = sortEndpoints(
      [
        { ...endpoint('zeta/fp8'), providerName: 'Alpha' },
        { ...endpoint('alpha/fp8'), providerName: 'Zeta' },
      ],
      'name'
    );
    expect(sorted.map((e) => e.providerName)).toEqual(['Alpha', 'Zeta']);
  });

  it('puts the biggest context window first', () => {
    const sorted = sortEndpoints(
      [
        endpoint('small', 1e-6, 1e-6, { contextWindow: 128_000 }),
        endpoint('big', 2e-6, 1e-6, { contextWindow: 1_000_000 }),
      ],
      'context'
    );
    expect(sorted.map((e) => e.tag)).toEqual(['big', 'small']);
  });

  it('puts the fastest endpoint first', () => {
    const sorted = sortEndpoints(
      [
        endpoint('slow', 1e-6, 1e-6, { throughput: 12 }),
        endpoint('fast', 2e-6, 1e-6, { throughput: 94 }),
      ],
      'throughput'
    );
    expect(sorted.map((e) => e.tag)).toEqual(['fast', 'slow']);
  });

  it('puts the most available endpoint first', () => {
    const sorted = sortEndpoints(
      [
        endpoint('flaky', 1e-6, 1e-6, { uptime: 78.2 }),
        endpoint('solid', 2e-6, 1e-6, { uptime: 99.9 }),
      ],
      'uptime'
    );
    expect(sorted.map((e) => e.tag)).toEqual(['solid', 'flaky']);
  });

  it('sorts unreported values last whichever way the sort runs', () => {
    // Ascending: an unpriced endpoint must not read as the cheapest.
    expect(
      sortEndpoints([endpoint('unknown'), endpoint('priced', 1e-6)]).map((e) => e.tag)
    ).toEqual(['priced', 'unknown']);
    // Descending: nor as the fastest.
    expect(
      sortEndpoints(
        [endpoint('unmeasured', 1e-6), endpoint('measured', 1e-6, 1e-6, { throughput: 40 })],
        'throughput'
      ).map((e) => e.tag)
    ).toEqual(['measured', 'unmeasured']);
  });

  it('does not mutate its input', () => {
    const input = [endpoint('b', 2e-6), endpoint('a', 1e-6)];
    sortEndpoints(input);
    expect(input.map((e) => e.tag)).toEqual(['b', 'a']);
  });
});

describe('sortEndpoints direction', () => {
  const priced = [endpoint('a', 1e-6), endpoint('b', 2e-6), endpoint('c', 3e-6)];

  it('reverses a price sort into most expensive first', () => {
    expect(sortEndpoints(priced, 'price', 'desc').map((e) => e.tag)).toEqual(['c', 'b', 'a']);
  });

  it('reverses a descending-by-default sort into slowest first', () => {
    const measured = [
      endpoint('slow', 1e-6, 1e-6, { throughput: 12 }),
      endpoint('fast', 1e-6, 1e-6, { throughput: 94 }),
    ];
    expect(sortEndpoints(measured, 'throughput', 'asc').map((e) => e.tag)).toEqual([
      'slow',
      'fast',
    ]);
  });

  it('reverses names into Z–A', () => {
    const named = [
      { ...endpoint('a'), providerName: 'Alpha' },
      { ...endpoint('z'), providerName: 'Zeta' },
    ];
    expect(sortEndpoints(named, 'name', 'desc').map((e) => e.providerName)).toEqual([
      'Zeta',
      'Alpha',
    ]);
  });

  it('keeps unreported values last even when the sort is inverted', () => {
    const mixed = [endpoint('unknown'), endpoint('cheap', 1e-6), endpoint('dear', 3e-6)];
    expect(sortEndpoints(mixed, 'price', 'desc').map((e) => e.tag)).toEqual([
      'dear',
      'cheap',
      'unknown',
    ]);
  });

  it('orders two endpoints that both omit the output price', () => {
    // Both output prices absent used to reach Infinity - Infinity, and a NaN
    // from a comparator leaves the whole ordering undefined.
    const sameInput = [
      { ...endpoint('b'), pricing: { prompt: 1e-6 } },
      { ...endpoint('a'), pricing: { prompt: 1e-6 } },
    ];
    expect(sortEndpoints(sameInput, 'price').map((e) => e.tag)).toEqual(['a', 'b']);
    expect(sortEndpoints(sameInput, 'price', 'desc').map((e) => e.tag)).toEqual(['a', 'b']);
  });

  it('is a true inversion for a list with no ties', () => {
    const forward = sortEndpoints(priced, 'price', 'asc').map((e) => e.tag);
    const backward = sortEndpoints(priced, 'price', 'desc').map((e) => e.tag);
    expect(backward).toEqual([...forward].reverse());
  });
});

describe('sort direction defaults', () => {
  it('opens price ascending and the comparative keys descending', () => {
    expect(defaultDirectionFor('price')).toBe('asc');
    expect(defaultDirectionFor('name')).toBe('asc');
    expect(defaultDirectionFor('context')).toBe('desc');
    expect(defaultDirectionFor('throughput')).toBe('desc');
    expect(defaultDirectionFor('uptime')).toBe('desc');
  });

  it('flips', () => {
    expect(oppositeOf('asc')).toBe('desc');
    expect(oppositeOf('desc')).toBe('asc');
  });
});

describe('searchEndpoints', () => {
  const endpoints = [
    { ...endpoint('deepinfra/fp4'), providerName: 'DeepInfra', quantization: 'fp4' },
    { ...endpoint('deepinfra/fp8'), providerName: 'DeepInfra', quantization: 'fp8' },
    { ...endpoint('cerebras'), providerName: 'Cerebras', quantization: 'fp16' },
  ];

  it('returns everything for an empty query', () => {
    expect(searchEndpoints(endpoints, '   ')).toHaveLength(3);
  });

  it('matches the provider name case-insensitively', () => {
    expect(searchEndpoints(endpoints, 'CEREBRAS').map((e) => e.tag)).toEqual(['cerebras']);
  });

  it('matches the quantization, which is how endpoints are told apart', () => {
    expect(searchEndpoints(endpoints, 'fp8').map((e) => e.tag)).toEqual(['deepinfra/fp8']);
  });

  it('narrows on every term rather than widening', () => {
    expect(searchEndpoints(endpoints, 'deep fp4').map((e) => e.tag)).toEqual(['deepinfra/fp4']);
    expect(searchEndpoints(endpoints, 'deep cerebras')).toEqual([]);
  });

  it('preserves the order it was given, leaving the sort in charge', () => {
    expect(searchEndpoints(endpoints, 'deep').map((e) => e.tag)).toEqual([
      'deepinfra/fp4',
      'deepinfra/fp8',
    ]);
  });
});

describe('findEndpoint', () => {
  const endpoints = [endpoint('reka/fp8'), endpoint('wafer')];

  it('finds the pinned endpoint by tag', () => {
    expect(findEndpoint(endpoints, 'wafer')?.tag).toBe('wafer');
  });

  it('reports a pin that no longer matches any endpoint', () => {
    expect(findEndpoint(endpoints, 'gone/eu-west-1')).toBeUndefined();
  });

  it('treats no pin as no endpoint', () => {
    expect(findEndpoint(endpoints, undefined)).toBeUndefined();
  });
});
