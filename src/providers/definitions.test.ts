import { afterEach, describe, expect, it, vi } from 'vitest';
import { openrouterDefinition } from './definitions';

const ENDPOINTS_RESPONSE = {
  data: {
    id: 'z-ai/glm-5.3',
    endpoints: [
      {
        provider_name: 'Reka',
        tag: 'reka/fp8',
        pricing: { prompt: '0.00000115', completion: '0.0000035' },
        quantization: 'fp8',
        status: 0,
        supported_parameters: ['tools'],
      },
      {
        provider_name: 'Wafer',
        tag: 'wafer',
        pricing: { prompt: '0.00000119', completion: '0.0000044' },
        status: 0,
        supported_parameters: ['tools'],
      },
    ],
  },
};

const STATS_RESPONSE = {
  data: [
    {
      provider_slug: 'reka/fp8',
      stats: { p50_throughput: 38, p50_latency: 3285, request_count: 341 },
    },
  ],
};

/** Answers each of the two URLs the endpoint list is built from. */
function stubFetch(stats: { ok: boolean } = { ok: true }) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      calls.push(url);
      if (url.includes('/api/frontend/')) {
        return Promise.resolve(
          stats.ok
            ? new Response(JSON.stringify(STATS_RESPONSE))
            : new Response('nope', { status: 500 })
        );
      }
      return Promise.resolve(new Response(JSON.stringify(ENDPOINTS_RESPONSE)));
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openrouterDefinition.listEndpoints', () => {
  it('merges the speed figures onto the endpoint they belong to', async () => {
    stubFetch();
    const endpoints = await openrouterDefinition.listEndpoints!('z-ai/glm-5.3', {
      canonicalSlug: 'z-ai/glm-5.3-20260816',
    });

    expect(endpoints.map((e) => e.tag)).toEqual(['reka/fp8', 'wafer']);
    expect(endpoints[0]).toMatchObject({ throughput: 38, latency: 3285, sampleCount: 341 });
    // Measured endpoints must not lend their numbers to unmeasured ones.
    expect(endpoints[1]?.throughput).toBeUndefined();
  });

  it('keys the statistics request by the versioned slug', async () => {
    const calls = stubFetch();
    await openrouterDefinition.listEndpoints!('z-ai/glm-5.3', {
      canonicalSlug: 'z-ai/glm-5.3-20260816',
    });
    expect(calls).toContain(
      'https://openrouter.ai/api/frontend/v1/stats/endpoint?permaslug=z-ai%2Fglm-5.3-20260816'
    );
  });

  it('skips the statistics request when there is no slug to key it by', async () => {
    const calls = stubFetch();
    const endpoints = await openrouterDefinition.listEndpoints!('z-ai/glm-5.3');

    expect(calls.some((url) => url.includes('/api/frontend/'))).toBe(false);
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]?.throughput).toBeUndefined();
  });

  it('keeps the endpoints when the undocumented statistics API fails', async () => {
    stubFetch({ ok: false });
    const endpoints = await openrouterDefinition.listEndpoints!('z-ai/glm-5.3', {
      canonicalSlug: 'z-ai/glm-5.3-20260816',
    });

    expect(endpoints.map((e) => e.tag)).toEqual(['reka/fp8', 'wafer']);
    expect(endpoints[0]?.throughput).toBeUndefined();
    expect(endpoints[0]?.pricing).toEqual({ prompt: 0.00000115, completion: 0.0000035 });
  });
});
