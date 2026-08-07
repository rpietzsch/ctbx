import { describe, expect, it } from 'vitest';
import {
  formatContextWindow,
  formatPricePerMillion,
  groupByProvider,
  modelKey,
  parseModelKey,
  searchModels,
  type PickableModel,
} from './model-search';

function model(
  id: string,
  label = id,
  providerId: PickableModel['providerId'] = 'openrouter'
): PickableModel {
  return {
    id,
    label,
    providerId,
    providerLabel: providerId === 'openrouter' ? 'OpenRouter' : 'OpenAI',
    key: modelKey(providerId, id),
    supportsTools: true,
  };
}

const MODELS = [
  model('anthropic/claude-opus-4', 'Anthropic: Claude Opus 4'),
  model('anthropic/claude-sonnet-4', 'Anthropic: Claude Sonnet 4'),
  model('openai/gpt-4o', 'OpenAI: GPT-4o'),
  model('openai/gpt-4o-mini-2024-07-18', 'OpenAI: GPT-4o mini'),
  model('meta-llama/llama-3-70b', 'Meta: Llama 3 70B'),
  model('gpt-4o', 'gpt-4o', 'openai'),
];

describe('searchModels', () => {
  it('returns everything for an empty query', () => {
    expect(searchModels(MODELS, '')).toHaveLength(MODELS.length);
    expect(searchModels(MODELS, '   ')).toHaveLength(MODELS.length);
  });

  it('filters by a substring of the id', () => {
    expect(searchModels(MODELS, 'llama').map((m) => m.id)).toEqual(['meta-llama/llama-3-70b']);
  });

  it('filters by a substring of the label', () => {
    const ids = searchModels(MODELS, 'sonnet').map((m) => m.id);
    expect(ids).toEqual(['anthropic/claude-sonnet-4']);
  });

  it('requires every term to match, in any order', () => {
    expect(searchModels(MODELS, 'claude opus').map((m) => m.id)).toEqual([
      'anthropic/claude-opus-4',
    ]);
    expect(searchModels(MODELS, 'opus claude').map((m) => m.id)).toEqual([
      'anthropic/claude-opus-4',
    ]);
  });

  it('is case insensitive', () => {
    expect(searchModels(MODELS, 'OPUS')).toHaveLength(1);
  });

  it('ranks an exact id match first', () => {
    expect(searchModels(MODELS, 'gpt-4o')[0]?.id).toBe('gpt-4o');
  });

  it('ranks the shorter id above a dated variant', () => {
    const ids = searchModels(MODELS, 'gpt-4o').map((m) => m.id);
    expect(ids.indexOf('openai/gpt-4o')).toBeLessThan(ids.indexOf('openai/gpt-4o-mini-2024-07-18'));
  });

  it('matches the part after the provider slash', () => {
    expect(searchModels(MODELS, 'claude').map((m) => m.id)).toEqual([
      'anthropic/claude-opus-4',
      'anthropic/claude-sonnet-4',
    ]);
  });

  it('can search by provider name', () => {
    expect(searchModels(MODELS, 'openrouter').length).toBe(5);
  });

  it('returns nothing when no model matches', () => {
    expect(searchModels(MODELS, 'nonexistent-model')).toEqual([]);
  });

  it('handles a large list without breaking', () => {
    const many = Array.from({ length: 500 }, (_, i) => model(`vendor/model-${i}`));
    expect(searchModels(many, 'model-42').length).toBeGreaterThan(0);
    expect(searchModels(many, 'model-42')[0]?.id).toBe('vendor/model-42');
  });
});

describe('model keys', () => {
  it('round-trips', () => {
    expect(parseModelKey(modelKey('openrouter', 'anthropic/claude-opus-4'))).toEqual({
      providerId: 'openrouter',
      modelId: 'anthropic/claude-opus-4',
    });
  });

  it('handles model ids containing colons', () => {
    expect(parseModelKey(modelKey('openrouter', 'vendor/model:free'))?.modelId).toBe(
      'vendor/model:free'
    );
  });

  it('rejects malformed keys', () => {
    expect(parseModelKey('nokey')).toBeUndefined();
    expect(parseModelKey('::x')).toBeUndefined();
    expect(parseModelKey('openrouter::')).toBeUndefined();
  });
});

describe('formatting', () => {
  it('converts per-token price to per-million', () => {
    expect(formatPricePerMillion(0.000015)).toBe('$15.0/M');
    expect(formatPricePerMillion(0.0000005)).toBe('$0.50/M');
    expect(formatPricePerMillion(0.00075)).toBe('$750/M');
  });

  it('omits price when it is absent or free', () => {
    expect(formatPricePerMillion(undefined)).toBeUndefined();
    expect(formatPricePerMillion(0)).toBeUndefined();
  });

  it('abbreviates context windows', () => {
    expect(formatContextWindow(200000)).toBe('200K ctx');
    expect(formatContextWindow(1048576)).toBe('1.0M ctx');
    expect(formatContextWindow(2_000_000)).toBe('2M ctx');
    expect(formatContextWindow(512)).toBe('512 ctx');
    expect(formatContextWindow(undefined)).toBeUndefined();
  });
});

describe('groupByProvider', () => {
  it('groups while preserving rank order', () => {
    const groups = groupByProvider(searchModels(MODELS, 'gpt-4o'));
    expect(groups[0]?.[0]).toBe('OpenAI');
    expect(groups.map(([label]) => label)).toEqual(['OpenAI', 'OpenRouter']);
  });
});
