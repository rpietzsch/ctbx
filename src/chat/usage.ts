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

export interface RunningCost {
  usd: number;
  /**
   * How many turns the sum covers. Zero means nothing has been priced yet, and
   * a total of `$0` would claim the conversation was free when it is really
   * unknown — a turn that failed before it billed anything is the common case.
   */
  turns: number;
  /** Every turn in the sum was priced by the provider, none estimated. */
  exact: boolean;
  /**
   * No turn up to here was left unpriced. When false the real total is higher
   * than `usd`, and the figure has to be presented as a lower bound.
   */
  complete: boolean;
}

export interface TurnCost {
  /** This turn alone. Absent when it cannot be priced at all. */
  own?: MessageCost;
  /** This turn plus every priced turn before it. */
  running: RunningCost;
}

/**
 * Per-turn and running costs for a whole conversation, in one pass.
 *
 * A turn counts as unpriced — and so makes every later total a lower bound —
 * only when it reported token usage but no price. A turn with no usage at all
 * never produced a measurable generation, so it is passed over rather than
 * poisoning the total: an aborted turn should not permanently mark the
 * conversation's cost as unknown.
 *
 * Keyed by message id, because the footer renders one message at a time and
 * recomputing the prefix sum per message would be quadratic in the transcript.
 */
export function costTrail(
  messages: readonly StoredMessage[],
  pricingOf: (message: StoredMessage) => ModelInfo['pricing']
): Map<string, TurnCost> {
  const trail = new Map<string, TurnCost>();
  let usd = 0;
  let turns = 0;
  let exact = true;
  let complete = true;

  for (const message of messages) {
    if (message.role !== 'assistant') continue;

    const own = messageCost(message, pricingOf(message));
    if (own) {
      usd += own.usd;
      turns += 1;
      exact &&= own.exact;
    } else if (message.usage !== undefined) {
      complete = false;
    }

    trail.set(message.id, { ...(own ? { own } : {}), running: { usd, turns, exact, complete } });
  }

  return trail;
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
