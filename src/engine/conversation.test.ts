import { describe, expect, it } from 'vitest';
import { summarizeAccounting } from './conversation';

/** One step's worth of what the OpenRouter provider puts in provider metadata. */
function step(provider?: string, cost?: number) {
  return {
    providerMetadata: {
      openrouter: {
        ...(provider === undefined ? {} : { provider }),
        ...(cost === undefined ? {} : { usage: { cost } }),
      },
    },
  };
}

describe('summarizeAccounting', () => {
  it('sums the cost of every step, not just the last', () => {
    // A tool-heavy turn is many billed generations; taking the final step alone
    // would under-report this one by more than an order of magnitude.
    const result = summarizeAccounting([
      step('Cerebras', 0.4),
      step('Cerebras', 0.15),
      step('Cerebras', 0.033),
    ]);
    expect(result.costUsd).toBeCloseTo(0.583, 10);
  });

  it('names the provider that served the turn', () => {
    expect(summarizeAccounting([step('Cerebras', 0.1)]).route).toBe('Cerebras');
  });

  it('refuses a partial sum, which would read as a total', () => {
    expect(summarizeAccounting([step('Cerebras', 0.4), step('Cerebras')]).costUsd).toBeUndefined();
  });

  it('still names the route when no step reported a cost', () => {
    const result = summarizeAccounting([step('Cerebras')]);
    expect(result).toEqual({ route: 'Cerebras' });
  });

  it('reports a genuinely free turn as zero rather than as unknown', () => {
    expect(summarizeAccounting([step('Chutes', 0), step('Chutes', 0)]).costUsd).toBe(0);
  });

  it('says nothing for providers that report no metadata at all', () => {
    expect(summarizeAccounting([{}, { providerMetadata: undefined }])).toEqual({});
  });

  it('survives metadata that is not the shape it expects', () => {
    expect(
      summarizeAccounting([
        { providerMetadata: { openrouter: { provider: 42, usage: 'nope' } } },
        { providerMetadata: 'nope' },
      ])
    ).toEqual({});
  });

  it('ignores a non-finite cost rather than propagating NaN into the total', () => {
    expect(summarizeAccounting([step('X', Number.NaN), step('X', 0.1)]).costUsd).toBeUndefined();
  });

  it('has nothing to report for a turn with no steps', () => {
    expect(summarizeAccounting([])).toEqual({});
  });
});
