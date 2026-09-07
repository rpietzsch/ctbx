import { describe, expect, it } from 'vitest';
import { estimateCost, formatCost, formatUsage, messageCost } from './usage';

describe('formatUsage', () => {
  it('shows input and output side by side', () => {
    expect(formatUsage({ inputTokens: 12480, outputTokens: 512 })).toBe(
      '12,480 in / 512 out tokens'
    );
  });

  it('separates thousands in the large counts a tool-heavy turn produces', () => {
    expect(formatUsage({ inputTokens: 1234567, outputTokens: 89 })).toBe(
      '1,234,567 in / 89 out tokens'
    );
  });

  it('renders the side a provider does report', () => {
    expect(formatUsage({ outputTokens: 512 })).toBe('512 out tokens');
    expect(formatUsage({ inputTokens: 12480 })).toBe('12,480 in tokens');
  });

  it('omits the footer when nothing is reported', () => {
    expect(formatUsage(undefined)).toBeUndefined();
    expect(formatUsage({})).toBeUndefined();
    expect(formatUsage({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  });
});

describe('estimateCost', () => {
  const pricing = { prompt: 0.000015, completion: 0.000075 };

  it('sums both sides at their own rate', () => {
    // 84,392 input at $15/M plus 517 output at $75/M.
    expect(estimateCost({ inputTokens: 84392, outputTokens: 517 }, pricing)).toBeCloseTo(
      1.304655,
      6
    );
  });

  it('prices a free model at zero rather than dropping the tag', () => {
    expect(
      estimateCost({ inputTokens: 5000, outputTokens: 200 }, { prompt: 0, completion: 0 })
    ).toBe(0);
  });

  it('refuses to guess when a count or a rate is missing', () => {
    expect(estimateCost({ outputTokens: 517 }, pricing)).toBeUndefined();
    expect(estimateCost({ inputTokens: 84392 }, pricing)).toBeUndefined();
    expect(estimateCost({ inputTokens: 1, outputTokens: 1 }, { prompt: 0.000015 })).toBeUndefined();
    expect(estimateCost({ inputTokens: 1, outputTokens: 1 }, undefined)).toBeUndefined();
    expect(estimateCost(undefined, pricing)).toBeUndefined();
  });
});

describe('formatCost', () => {
  it('scales precision to the magnitude', () => {
    expect(formatCost(1.304655)).toBe('$1.30');
    expect(formatCost(12.5)).toBe('$12.50');
    expect(formatCost(0.052)).toBe('$0.052');
    expect(formatCost(0.0003)).toBe('$0.0003');
  });

  it('never prints a nonzero cost as nothing', () => {
    expect(formatCost(0.00000004)).toBe('<$0.0001');
    expect(formatCost(0)).toBe('$0');
  });
});

describe('messageCost', () => {
  // openai/gpt-oss-120b: the default route is cheap, Cerebras is not.
  const listPricing = { prompt: 0.00000004, completion: 0.00000015 };
  const usage = { inputTokens: 577_567, outputTokens: 8_155 };

  it('prefers what the provider actually charged', () => {
    expect(messageCost({ usage, costUsd: 0.5893 }, listPricing)).toEqual({
      usd: 0.5893,
      exact: true,
    });
  });

  it('reports a free turn rather than dropping the tag', () => {
    expect(messageCost({ usage, costUsd: 0 }, listPricing)).toEqual({ usd: 0, exact: true });
  });

  it('falls back to the list price for an unpinned turn, marked inexact', () => {
    const cost = messageCost({ usage }, listPricing);
    expect(cost?.exact).toBe(false);
    expect(cost?.usd).toBeCloseTo(577_567 * 0.00000004 + 8_155 * 0.00000015, 10);
  });

  it('refuses to price a pinned turn from the default route’s rate', () => {
    // The list says $0.04/M in; Cerebras charges $0.99/M. Printing the former
    // would be a different endpoint's bill, not an approximation of this one.
    expect(messageCost({ usage, endpointTag: 'cerebras' }, listPricing)).toBeUndefined();
  });

  it('still prices a pinned turn when the provider reported the charge', () => {
    expect(messageCost({ usage, endpointTag: 'cerebras', costUsd: 0.583 }, listPricing)).toEqual({
      usd: 0.583,
      exact: true,
    });
  });

  it('has nothing to show when neither the charge nor a rate is known', () => {
    expect(messageCost({ usage }, undefined)).toBeUndefined();
  });
});
