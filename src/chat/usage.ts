import type { StoredMessage } from '@/storage/db';
import type { ModelInfo } from '@/providers/types';

/**
 * Thousands separators, because a tool-heavy turn re-sends the whole transcript
 * on every step: the input side routinely reaches six figures, where bare
 * digits stop being readable at a glance.
 */
function formatTokens(count: number): string {
  return count.toLocaleString('en-US');
}

/**
 * The per-message token footer: `12,480 in / 512 out tokens`.
 *
 * Both numbers are totals for the whole turn, not the final step — with MCP
 * tools one answer can span dozens of round trips, and the sum is the only
 * figure that reflects what the turn actually cost. Either side is dropped when
 * the provider does not report it, so older stored messages (output only) still
 * render.
 */
export function formatUsage(usage: StoredMessage['usage']): string | undefined {
  const parts = [
    usage?.inputTokens ? `${formatTokens(usage.inputTokens)} in` : undefined,
    usage?.outputTokens ? `${formatTokens(usage.outputTokens)} out` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : `${parts.join(' / ')} tokens`;
}

/**
 * What the turn cost in USD, from the provider's per-token prices.
 *
 * Deliberately all-or-nothing: a turn missing one token count or one rate would
 * still print a plausible-looking total while undercounting it, so anything
 * incomplete drops the tag instead. Zero is a real answer — free models price
 * at zero and that is worth saying.
 */
export function estimateCost(
  usage: StoredMessage['usage'],
  pricing: ModelInfo['pricing']
): number | undefined {
  const { inputTokens, outputTokens } = usage ?? {};
  const { prompt, completion } = pricing ?? {};
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  if (prompt === undefined || completion === undefined) return undefined;
  return inputTokens * prompt + outputTokens * completion;
}

export interface MessageCost {
  usd: number;
  /** Charged by the provider, as opposed to derived from published rates. */
  exact: boolean;
}

/**
 * The price to show under a turn, and whether it can be trusted as exact.
 *
 * The provider's own figure wins whenever there is one: it already reflects the
 * endpoint that served the turn and any cache discount, neither of which the
 * published per-token rates capture.
 *
 * Without it, the cached model price is used — except for a turn that was
 * pinned to a specific endpoint, where that price is known to be the wrong one.
 * The model list publishes the default route's rate, and a pinned endpoint can
 * charge many times it; on `openai/gpt-oss-120b` the spread runs from $0.04 to
 * $0.99 per million input tokens. Printing the default rate for a pinned turn
 * would not be an approximation, it would be a different endpoint's bill.
 */
export function messageCost(
  message: Pick<StoredMessage, 'usage' | 'costUsd' | 'endpointTag'>,
  pricing: ModelInfo['pricing']
): MessageCost | undefined {
  if (message.costUsd !== undefined) return { usd: message.costUsd, exact: true };
  if (message.endpointTag !== undefined) return undefined;

  const estimated = estimateCost(message.usage, pricing);
  return estimated === undefined ? undefined : { usd: estimated, exact: false };
}

/**
 * Costs span four orders of magnitude here — a short answer on a cheap model is
 * a fraction of a cent, a long tool-driven turn on a frontier model is dollars —
 * so precision follows the magnitude. Fixing at two decimals would print most
 * turns as `$0.00`, which reads as free rather than as cheap.
 */
export function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`;
  return usd > 0 ? '<$0.0001' : '$0';
}
