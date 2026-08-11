import { describe, expect, it } from 'vitest';
import { distanceFromBottom, isAtLiveEdge, LIVE_EDGE_THRESHOLD_PX } from './follow-scroll';

/** A transcript taller than its viewport, scrolled to `scrollTop`. */
function scrolledTo(scrollTop: number) {
  return { scrollTop, scrollHeight: 5000, clientHeight: 800 };
}

describe('distanceFromBottom', () => {
  it('is zero at the very bottom', () => {
    expect(distanceFromBottom(scrolledTo(4200))).toBe(0);
  });

  it('grows as the reader scrolls back', () => {
    expect(distanceFromBottom(scrolledTo(3200))).toBe(1000);
  });
});

describe('isAtLiveEdge', () => {
  it('follows at the bottom', () => {
    expect(isAtLiveEdge(scrolledTo(4200))).toBe(true);
  });

  /**
   * The case the whole thing exists for: someone reading back through a long
   * answer must not be dragged to the newest token.
   */
  it('does not follow once the reader has scrolled back', () => {
    expect(isAtLiveEdge(scrolledTo(1000))).toBe(false);
  });

  it('tolerates a few pixels of slack at the edge', () => {
    expect(isAtLiveEdge(scrolledTo(4200 - LIVE_EDGE_THRESHOLD_PX))).toBe(true);
  });

  it('stops following just past the threshold', () => {
    expect(isAtLiveEdge(scrolledTo(4200 - LIVE_EDGE_THRESHOLD_PX - 1))).toBe(false);
  });

  it('honours an explicit threshold', () => {
    expect(isAtLiveEdge(scrolledTo(4100), 200)).toBe(true);
    expect(isAtLiveEdge(scrolledTo(4100), 50)).toBe(false);
  });

  /** Nothing to scroll means there is nowhere to be but the edge. */
  it('follows when the content is shorter than the viewport', () => {
    expect(isAtLiveEdge({ scrollTop: 0, scrollHeight: 300, clientHeight: 800 })).toBe(true);
  });

  it('follows an empty transcript', () => {
    expect(isAtLiveEdge({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(true);
  });

  /**
   * Elastic scrolling on iOS reports a scrollTop past the end while the rubber
   * band is stretched; that is still the live edge.
   */
  it('treats an overscrolled position as the edge', () => {
    expect(isAtLiveEdge(scrolledTo(4260))).toBe(true);
  });
});
