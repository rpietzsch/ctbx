import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MessageList } from './MessageList';
import type { StoredMessage } from '@/storage/db';

/**
 * The behaviour under test is "follow the stream only while the reader is at
 * the end of it", which is a question about scroll geometry — and jsdom has no
 * layout, so every element reports zero height. These helpers give the scroll
 * container the dimensions a real one would have, and record the scrolls the
 * component asks for.
 */
const VIEWPORT = 800;
const CONTENT = 5000;
const BOTTOM = CONTENT - VIEWPORT;

function message(id: string, role: 'user' | 'assistant', content: string): StoredMessage {
  return { id, role, content, createdAt: 0 } as StoredMessage;
}

/** The scroller is the element carrying the overflow class. */
function scroller(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('.overflow-y-auto');
  if (!element) throw new Error('no scroll container rendered');
  return element;
}

function giveLayout(element: HTMLElement, scrollTop: number) {
  Object.defineProperty(element, 'scrollHeight', { value: CONTENT, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: VIEWPORT, configurable: true });
  Object.defineProperty(element, 'scrollTop', {
    value: scrollTop,
    writable: true,
    configurable: true,
  });
}

let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollTo = vi.fn();
  // jsdom implements neither, and the component calls scrollTo on the element.
  Element.prototype.scrollTo = scrollTo as unknown as Element['scrollTo'];
});

const history = [
  message('1', 'user', 'first question'),
  message('2', 'assistant', 'a long answer'),
];

describe('MessageList following behaviour', () => {
  it('follows new output while the reader is at the end', () => {
    const { container, rerender } = render(<MessageList messages={history} streaming={true} />);
    const element = scroller(container);
    giveLayout(element, BOTTOM);
    fireEvent.scroll(element);
    scrollTo.mockClear();

    rerender(
      <MessageList
        messages={[...history.slice(0, 1), message('2', 'assistant', 'a long answer, extended')]}
        streaming={true}
      />
    );

    expect(scrollTo).toHaveBeenCalled();
  });

  /**
   * The reported problem: reading back through a long answer, every streamed
   * chunk dragged the view to the bottom again.
   */
  it('holds position once the reader has scrolled back', () => {
    const { container, rerender } = render(<MessageList messages={history} streaming={true} />);
    const element = scroller(container);
    giveLayout(element, 500); // far from the bottom
    fireEvent.scroll(element);
    scrollTo.mockClear();

    rerender(
      <MessageList
        messages={[...history.slice(0, 1), message('2', 'assistant', 'a long answer, extended')]}
        streaming={true}
      />
    );

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('offers a way back to the live edge only while scrolled away', () => {
    const { container, getByRole, queryByRole } = render(
      <MessageList messages={history} streaming={true} />
    );
    const element = scroller(container);

    giveLayout(element, BOTTOM);
    fireEvent.scroll(element);
    expect(queryByRole('button', { name: /jump to latest/i })).toBeNull();

    giveLayout(element, 500);
    fireEvent.scroll(element);
    expect(getByRole('button', { name: /jump to latest/i })).toBeInTheDocument();
  });

  it('resumes following when the reader jumps back', () => {
    const { container, getByRole, rerender } = render(
      <MessageList messages={history} streaming={true} />
    );
    const element = scroller(container);
    giveLayout(element, 500);
    fireEvent.scroll(element);

    fireEvent.click(getByRole('button', { name: /jump to latest/i }));
    scrollTo.mockClear();

    rerender(
      <MessageList
        messages={[...history.slice(0, 1), message('2', 'assistant', 'more text')]}
        streaming={true}
      />
    );

    expect(scrollTo).toHaveBeenCalled();
  });

  /**
   * Sending is an explicit move to the end of the transcript, so it re-anchors
   * even from far up the history.
   */
  it('re-anchors when the reader sends a message from up the history', () => {
    const { container, rerender } = render(<MessageList messages={history} streaming={false} />);
    const element = scroller(container);
    giveLayout(element, 500);
    fireEvent.scroll(element);
    scrollTo.mockClear();

    rerender(
      <MessageList
        messages={[...history, message('3', 'user', 'another question')]}
        streaming={false}
      />
    );

    expect(scrollTo).toHaveBeenCalled();
  });

  it('does not re-anchor when the arriving message is from the assistant', () => {
    const { container, rerender } = render(<MessageList messages={history} streaming={false} />);
    const element = scroller(container);
    giveLayout(element, 500);
    fireEvent.scroll(element);
    scrollTo.mockClear();

    rerender(
      <MessageList
        messages={[...history, message('3', 'assistant', 'unprompted follow-up')]}
        streaming={false}
      />
    );

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
