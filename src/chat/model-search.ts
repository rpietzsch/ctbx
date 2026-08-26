import type { ProviderId } from '@/config/schema';
import type { ModelInfo } from '@/providers/types';

export interface PickableModel extends ModelInfo {
  providerId: ProviderId;
  providerLabel: string;
  /** `providerId::modelId`, the picker's value. */
  key: string;
}

/**
 * USD-per-token as a bare per-million amount, with the precision scaled to the
 * magnitude so cheap models keep their cents and expensive ones stay short.
 */
function perMillionAmount(perToken: number | undefined): string | undefined {
  if (perToken === undefined || perToken <= 0) return undefined;
  const perMillion = perToken * 1_000_000;
  if (perMillion < 1) return perMillion.toFixed(2);
  if (perMillion < 100) return perMillion.toFixed(1);
  return perMillion.toFixed(0);
}

/** Formats USD-per-token as the more readable USD per million tokens. */
export function formatPricePerMillion(perToken: number | undefined): string | undefined {
  const amount = perMillionAmount(perToken);
  return amount === undefined ? undefined : `$${amount}/M`;
}

/**
 * Input and output price as a single picker fact: `$15/$75/M` is in/out per
 * million tokens. Only OpenRouter reports both, so the one-sided fallbacks are
 * suffixed — an unlabelled lone number would read as the input price.
 */
export function formatPricing(pricing: ModelInfo['pricing']): string | undefined {
  const input = perMillionAmount(pricing?.prompt);
  const output = perMillionAmount(pricing?.completion);
  if (input !== undefined && output !== undefined) return `$${input}/$${output}/M`;
  if (input !== undefined) return `$${input}/M in`;
  if (output !== undefined) return `$${output}/M out`;
  return undefined;
}

/** Spells the combined fact out for the hover title, which has room for words. */
export function formatPricingTitle(pricing: ModelInfo['pricing']): string | undefined {
  const parts = [
    formatPricePerMillion(pricing?.prompt) && `Input ${formatPricePerMillion(pricing?.prompt)}`,
    formatPricePerMillion(pricing?.completion) &&
      `Output ${formatPricePerMillion(pricing?.completion)}`,
  ].filter((part): part is string => Boolean(part));
  return parts.length === 0 ? undefined : parts.join(' · ');
}

export function formatContextWindow(tokens: number | undefined): string | undefined {
  if (tokens === undefined || tokens <= 0) return undefined;
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K ctx`;
  return `${tokens} ctx`;
}

export function modelKey(providerId: ProviderId, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function parseModelKey(
  key: string
): { providerId: ProviderId; modelId: string } | undefined {
  const index = key.indexOf('::');
  if (index <= 0) return undefined;
  const providerId = key.slice(0, index) as ProviderId;
  const modelId = key.slice(index + 2);
  if (modelId === '') return undefined;
  return { providerId, modelId };
}

/**
 * Ranked substring search over the model list.
 *
 * OpenRouter alone exposes 400+ models, so the picker is unusable without
 * filtering. Every whitespace-separated term must match somewhere (so
 * "claude opus" and "opus claude" both work), and matches are ranked so exact
 * and prefix hits float to the top rather than being buried alphabetically.
 */
export function searchModels(models: PickableModel[], query: string): PickableModel[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return models;

  const scored: { model: PickableModel; score: number }[] = [];

  for (const model of models) {
    const id = model.id.toLowerCase();
    const label = model.label.toLowerCase();
    const provider = model.providerLabel.toLowerCase();
    const haystack = `${id} ${label} ${provider}`;

    if (!terms.every((term) => haystack.includes(term))) continue;

    let score = 0;
    for (const term of terms) {
      if (id === term || label === term) score += 100;
      else if (id.startsWith(term) || label.startsWith(term)) score += 50;
      else if (afterSlash(id).startsWith(term)) score += 40;
      else if (id.includes(term)) score += 20;
      else if (label.includes(term)) score += 15;
      else score += 5;
    }
    // Prefer shorter ids on ties: "openai/gpt-4o" over "openai/gpt-4o-2024-11".
    score -= Math.min(id.length / 20, 5);
    scored.push({ model, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id))
    .map((entry) => entry.model);
}

function afterSlash(id: string): string {
  const index = id.indexOf('/');
  return index === -1 ? id : id.slice(index + 1);
}

/** Groups a flat result list by provider, preserving rank order. */
export function groupByProvider(models: PickableModel[]): [string, PickableModel[]][] {
  const groups = new Map<string, PickableModel[]>();
  for (const model of models) {
    const existing = groups.get(model.providerLabel);
    if (existing) existing.push(model);
    else groups.set(model.providerLabel, [model]);
  }
  return [...groups.entries()];
}
