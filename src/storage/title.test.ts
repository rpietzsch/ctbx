import { describe, expect, it } from 'vitest';
import { deriveTitle, titleFor } from './db';
import type { StoredMessage } from './db';

function user(content: string): StoredMessage {
  return { id: 'u', role: 'user', content, createdAt: 0 };
}

describe('deriveTitle', () => {
  it('uses the first user message', () => {
    expect(deriveTitle([user('Explain the routing bug')])).toBe('Explain the routing bug');
  });

  it('falls back before anything has been said', () => {
    expect(deriveTitle([])).toBe('New conversation');
    expect(deriveTitle([user('   ')])).toBe('New conversation');
  });

  it('truncates a long opening message', () => {
    const title = deriveTitle([user('x'.repeat(200))]);
    expect(title).toHaveLength(58);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('titleFor', () => {
  it('keeps a name the user typed, whatever is said next', () => {
    // Without this the derived title overwrites the name on the very next turn.
    expect(
      titleFor({
        title: 'Pricing investigation',
        titleIsCustom: true,
        messages: [user('something else entirely')],
      })
    ).toBe('Pricing investigation');
  });

  it('re-derives a title the user never set', () => {
    expect(
      titleFor({ title: 'New conversation', messages: [user('Explain the routing bug')] })
    ).toBe('Explain the routing bug');
  });

  it('re-derives once a custom name is cleared', () => {
    expect(
      titleFor({ title: 'Pricing investigation', titleIsCustom: false, messages: [user('Hello')] })
    ).toBe('Hello');
  });
});
