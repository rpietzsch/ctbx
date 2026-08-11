/**
 * Deciding whether the transcript should follow new output.
 *
 * A chat that always scrolls to the newest token makes reading back through a
 * long answer impossible: every chunk yanks the view to the bottom. The rule is
 * that the transcript only follows while the reader is already at the live edge
 * — scroll up and it holds still until you come back.
 *
 * The measurement is kept pure here so the threshold behaviour is testable
 * without a layout engine.
 */

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * How close to the bottom still counts as "at the live edge".
 *
 * Not zero: sub-pixel rounding, a partly-scrolled last line and the growth of
 * the streaming message itself all leave a few pixels of slack, and demanding
 * an exact bottom would drop the reader out of follow mode for no reason they
 * could perceive.
 */
export const LIVE_EDGE_THRESHOLD_PX = 64;

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

export function isAtLiveEdge(metrics: ScrollMetrics, threshold = LIVE_EDGE_THRESHOLD_PX): boolean {
  // Content shorter than the viewport cannot be scrolled away from, so it is
  // always at the edge; the subtraction would otherwise go negative and still
  // pass, but stating it makes the intent obvious.
  if (metrics.scrollHeight <= metrics.clientHeight) return true;
  return distanceFromBottom(metrics) <= threshold;
}
