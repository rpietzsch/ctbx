import { describe, expect, it } from 'vitest';
import {
  openAiSupportsTools,
  parseAnthropicModels,
  parseGoogleModels,
  parseOpenAIModels,
  parseOpenRouterEndpointStats,
  parseOpenRouterEndpoints,
  parseOpenRouterModels,
} from './parse';

describe('parseOpenRouterModels', () => {
  const payload = {
    data: [
      {
        id: 'anthropic/claude-opus-4',
        name: 'Anthropic: Claude Opus 4',
        context_length: 200000,
        pricing: { prompt: '0.000015', completion: '0.000075' },
        supported_parameters: ['tools', 'tool_choice', 'temperature'],
      },
      {
        id: 'meta-llama/llama-3-8b',
        name: 'Llama 3 8B',
        context_length: 8192,
        pricing: { prompt: '0.00000005', completion: '0.00000008' },
        supported_parameters: ['temperature'],
      },
    ],
  };

  it('maps id, label, context window and pricing', () => {
    const [opus] = parseOpenRouterModels(payload);
    expect(opus).toEqual({
      id: 'anthropic/claude-opus-4',
      label: 'Anthropic: Claude Opus 4',
      contextWindow: 200000,
      pricing: { prompt: 0.000015, completion: 0.000075 },
      supportsTools: true,
    });
  });

  it('derives tool support from supported_parameters', () => {
    const models = parseOpenRouterModels(payload);
    expect(models.map((m) => m.supportsTools)).toEqual([true, false]);
  });

  it('falls back to the id when name is missing', () => {
    const [model] = parseOpenRouterModels({ data: [{ id: 'x/y' }] });
    expect(model?.label).toBe('x/y');
  });

  it('omits pricing entirely when the provider reports none', () => {
    const [model] = parseOpenRouterModels({ data: [{ id: 'x/y', pricing: {} }] });
    expect(model?.pricing).toBeUndefined();
  });

  it('drops entries without a usable id', () => {
    expect(parseOpenRouterModels({ data: [{ name: 'no id' }, { id: '' }, { id: 'ok' }] })).toEqual([
      { id: 'ok', label: 'ok', contextWindow: undefined, pricing: undefined, supportsTools: false },
    ]);
  });

  it('tolerates junk payloads instead of throwing', () => {
    expect(parseOpenRouterModels(null)).toEqual([]);
    expect(parseOpenRouterModels({})).toEqual([]);
    expect(parseOpenRouterModels({ data: 'nope' })).toEqual([]);
    expect(parseOpenRouterModels([1, 2, 3])).toEqual([]);
  });
});

describe('parseOpenAIModels', () => {
  it('filters out non-chat model families', () => {
    const models = parseOpenAIModels({
      data: [
        { id: 'gpt-4o' },
        { id: 'text-embedding-3-large' },
        { id: 'whisper-1' },
        { id: 'dall-e-3' },
        { id: 'tts-1' },
        { id: 'omni-moderation-latest' },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(['gpt-4o']);
  });

  it('infers tool support conservatively', () => {
    expect(openAiSupportsTools('gpt-4o')).toBe(true);
    expect(openAiSupportsTools('gpt-5.2')).toBe(true);
    expect(openAiSupportsTools('o3-mini')).toBe(true);
    expect(openAiSupportsTools('babbage-002')).toBe(false);
  });

  it('sorts by id for a stable picker', () => {
    const models = parseOpenAIModels({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4-turbo' }] });
    expect(models.map((m) => m.id)).toEqual(['gpt-4-turbo', 'gpt-4o']);
  });

  it('tolerates junk payloads', () => {
    expect(parseOpenAIModels(undefined)).toEqual([]);
  });
});

describe('parseAnthropicModels', () => {
  it('uses display_name and marks every model tool-capable', () => {
    expect(
      parseAnthropicModels({
        data: [{ id: 'claude-opus-4-20250514', display_name: 'Claude Opus 4' }],
      })
    ).toEqual([{ id: 'claude-opus-4-20250514', label: 'Claude Opus 4', supportsTools: true }]);
  });

  it('falls back to the id when display_name is absent', () => {
    const [model] = parseAnthropicModels({ data: [{ id: 'claude-x' }] });
    expect(model?.label).toBe('claude-x');
  });

  it('tolerates junk payloads', () => {
    expect(parseAnthropicModels({ data: null })).toEqual([]);
  });
});

describe('parseGoogleModels', () => {
  it('strips the models/ prefix and reads the token limit', () => {
    expect(
      parseGoogleModels({
        models: [
          {
            name: 'models/gemini-2.0-flash',
            displayName: 'Gemini 2.0 Flash',
            inputTokenLimit: 1048576,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
        ],
      })
    ).toEqual([
      {
        id: 'gemini-2.0-flash',
        label: 'Gemini 2.0 Flash',
        contextWindow: 1048576,
        supportsTools: true,
      },
    ]);
  });

  it('drops models that cannot generate content', () => {
    const models = parseGoogleModels({
      models: [
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(['gemini-2.0-flash']);
  });

  it('keeps models that do not declare generation methods', () => {
    const models = parseGoogleModels({ models: [{ name: 'models/gemini-3-pro' }] });
    expect(models.map((m) => m.id)).toEqual(['gemini-3-pro']);
  });

  it('tolerates junk payloads', () => {
    expect(parseGoogleModels({})).toEqual([]);
  });
});

describe('parseOpenRouterEndpoints', () => {
  const payload = {
    data: {
      id: 'z-ai/glm-5.3',
      endpoints: [
        {
          name: 'Reka | z-ai/glm-5.3',
          provider_name: 'Reka',
          tag: 'reka/fp8',
          context_length: 262144,
          max_completion_tokens: 32768,
          pricing: { prompt: '0.00000115', completion: '0.0000035' },
          quantization: 'fp8',
          uptime_last_1d: 78.21933123284886,
          status: 0,
          supported_parameters: ['tools', 'tool_choice', 'temperature'],
        },
        {
          provider_name: 'Wafer',
          tag: 'wafer',
          context_length: 1048576,
          pricing: { prompt: '0.00000119', completion: '0.0000044' },
          quantization: 'unknown',
          status: -2,
          supported_parameters: ['temperature'],
        },
      ],
    },
  };

  it('reads pricing, capacity and tool support per endpoint', () => {
    const [reka] = parseOpenRouterEndpoints(payload);
    expect(reka).toEqual({
      tag: 'reka/fp8',
      providerName: 'Reka',
      contextWindow: 262144,
      maxCompletionTokens: 32768,
      pricing: { prompt: 0.00000115, completion: 0.0000035 },
      quantization: 'fp8',
      uptime: 78.21933123284886,
      degraded: false,
      supportsTools: true,
    });
  });

  it('drops the placeholder quantization rather than showing "unknown"', () => {
    const [, wafer] = parseOpenRouterEndpoints(payload);
    expect(wafer?.quantization).toBeUndefined();
    expect(wafer?.supportsTools).toBe(false);
  });

  it('marks a negative status as degraded', () => {
    const [, wafer] = parseOpenRouterEndpoints(payload);
    expect(wafer?.degraded).toBe(true);
  });

  it('collapses a repeated tag, which names one routing target', () => {
    // openai/gpt-oss-120b really does list baseten/fp4 twice. Two rows pinning
    // to the same endpoint is a choice the user cannot make, and a duplicate
    // React key multiplied the rows on every re-render.
    const parsed = parseOpenRouterEndpoints({
      data: {
        endpoints: [
          { provider_name: 'BaseTen', tag: 'baseten/fp4', context_length: 128072 },
          { provider_name: 'BaseTen', tag: 'baseten/fp4', context_length: 128072 },
          { provider_name: 'Cerebras', tag: 'cerebras/fp16' },
        ],
      },
    });
    expect(parsed.map((endpoint) => endpoint.tag)).toEqual(['baseten/fp4', 'cerebras/fp16']);
  });

  it('keeps the first of a repeated tag, which OpenRouter ranks highest', () => {
    const parsed = parseOpenRouterEndpoints({
      data: {
        endpoints: [
          { provider_name: 'BaseTen', tag: 'baseten/fp8', max_completion_tokens: 943718 },
          { provider_name: 'BaseTen', tag: 'baseten/fp8', max_completion_tokens: 384000 },
        ],
      },
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.maxCompletionTokens).toBe(943718);
  });

  it('skips endpoints without a tag, since they cannot be routed to', () => {
    const parsed = parseOpenRouterEndpoints({
      data: { endpoints: [{ provider_name: 'Nameless' }, { provider_name: 'Ok', tag: 'ok' }] },
    });
    expect(parsed.map((endpoint) => endpoint.tag)).toEqual(['ok']);
  });

  it('survives a shape it does not recognise', () => {
    expect(parseOpenRouterEndpoints({})).toEqual([]);
    expect(parseOpenRouterEndpoints({ data: { endpoints: 'nope' } })).toEqual([]);
    expect(parseOpenRouterEndpoints(null)).toEqual([]);
  });
});

describe('parseOpenRouterEndpointStats', () => {
  const payload = {
    data: [
      {
        id: 'd99be598-65f7-4ff0-9c18-92be7290f06e',
        provider_name: 'Reka',
        provider_slug: 'reka/fp8',
        stats: { p50_throughput: 38, p50_latency: 3285, request_count: 341, window_minutes: 30 },
      },
      {
        provider_name: 'Cold',
        provider_slug: 'cold',
        stats: null,
      },
    ],
  };

  it('keys the medians by the tag the endpoint list uses', () => {
    const stats = parseOpenRouterEndpointStats(payload);
    expect(stats.get('reka/fp8')).toEqual({ throughput: 38, latency: 3285, sampleCount: 341 });
  });

  it('omits endpoints with no measurement rather than reporting a zero', () => {
    const stats = parseOpenRouterEndpointStats(payload);
    expect(stats.has('cold')).toBe(false);
  });

  it('survives the undocumented shape changing under it', () => {
    expect(parseOpenRouterEndpointStats({}).size).toBe(0);
    expect(parseOpenRouterEndpointStats({ data: [{ provider_slug: 'x' }] }).size).toBe(0);
    expect(parseOpenRouterEndpointStats(null).size).toBe(0);
  });
});

describe('parseOpenRouterModels canonical slug', () => {
  it('keeps the versioned slug the statistics API is keyed by', () => {
    const [model] = parseOpenRouterModels({
      data: [{ id: 'z-ai/glm-5.3', canonical_slug: 'z-ai/glm-5.3-20260816' }],
    });
    expect(model?.canonicalSlug).toBe('z-ai/glm-5.3-20260816');
  });

  it('omits it when the provider does not report one', () => {
    const [model] = parseOpenRouterModels({ data: [{ id: 'z-ai/glm-5.3' }] });
    expect(model?.canonicalSlug).toBeUndefined();
  });
});
