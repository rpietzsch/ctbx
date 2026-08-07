import { describe, expect, it } from 'vitest';
import {
  openAiSupportsTools,
  parseAnthropicModels,
  parseGoogleModels,
  parseOpenAIModels,
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
