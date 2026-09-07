import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredConversation } from '@/storage/db';
import type { TurnResult } from '@/engine/conversation';

/**
 * The store's contract while a reply is arriving: the transcript keeps growing
 * in the conversation it belongs to, and only reaches the view while that
 * conversation is the one on screen. Reading history mid-reply is the case
 * these tests exist for — it used to snap back on the next token.
 */

const saved = new Map<string, StoredConversation>();

vi.mock('@/storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/db')>();
  return {
    ...actual,
    listConversations: async () => [...saved.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    getConversation: async (id: string) => saved.get(id),
    putConversation: async (conversation: StoredConversation) => {
      saved.set(conversation.id, conversation);
    },
    deleteConversation: async (id: string) => {
      saved.delete(id);
    },
  };
});

vi.mock('@/providers/registry', () => ({ resolveModel: () => ({}) }));

/** The turn in flight, driven by hand so the test controls every token. */
let turn: {
  delta(text: string): void;
  end(result?: Partial<TurnResult>): void;
};

vi.mock('@/engine/conversation', () => ({
  toModelMessages: (messages: unknown) => messages,
  runTurn: (options: { onTextDelta?(delta: string): void }) =>
    new Promise<TurnResult>((resolve) => {
      turn = {
        delta: (text) => options.onTextDelta?.(text),
        end: (result) => resolve({ text: '', aborted: false, ...result }),
      };
    }),
}));

const { useChatStore } = await import('./chat');

function conversation(id: string, title: string): StoredConversation {
  return {
    id,
    title,
    createdAt: 0,
    updatedAt: 0,
    providerId: 'openrouter',
    modelId: 'a/model',
    messages: [],
  };
}

function textOf(target: StoredConversation | undefined): string {
  return (target?.messages ?? [])
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .join('');
}

describe('useChatStore streaming', () => {
  beforeEach(() => {
    saved.clear();
    const a = conversation('a', 'First');
    const b = conversation('b', 'Second');
    saved.set('a', a);
    saved.set('b', b);
    useChatStore.setState({
      conversations: [a, b],
      current: a,
      streaming: false,
      streamingId: undefined,
      error: undefined,
      abortController: undefined,
    });
  });

  it('keeps the reader where they navigated while the reply arrives', async () => {
    const sending = useChatStore.getState().send('hello');
    turn.delta('one ');

    await useChatStore.getState().select('b');
    turn.delta('two');

    // The view stays on the conversation the reader opened...
    expect(useChatStore.getState().current?.id).toBe('b');
    expect(useChatStore.getState().streamingId).toBe('a');

    turn.end();
    await sending;

    expect(useChatStore.getState().current?.id).toBe('b');
    // ...and the answer it was not watching arrived in full.
    expect(textOf(saved.get('a'))).toBe('one two');
  });

  it('shows what arrived while the reader was away when they come back', async () => {
    const sending = useChatStore.getState().send('hello');
    turn.delta('one ');
    await useChatStore.getState().select('b');
    turn.delta('two');

    await useChatStore.getState().select('a');
    expect(textOf(useChatStore.getState().current)).toBe('one two');

    // And the view resumes following the reply from there.
    turn.delta(' three');
    expect(textOf(useChatStore.getState().current)).toBe('one two three');

    turn.end();
    await sending;
    expect(useChatStore.getState().streamingId).toBeUndefined();
  });

  it('returns to the live reply, not the stored copy, when the chat remounts', async () => {
    const sending = useChatStore.getState().send('hello');
    turn.delta('one ');

    // What a visit to the settings pages and back does.
    await useChatStore.getState().load();
    expect(useChatStore.getState().current?.id).toBe('a');
    expect(textOf(useChatStore.getState().current)).toBe('one ');
    // The sidebar names it from the message that is not saved yet, too.
    expect(useChatStore.getState().conversations.find((c) => c.id === 'a')?.title).toBe('hello');

    turn.delta('two');
    expect(textOf(useChatStore.getState().current)).toBe('one two');

    turn.end();
    await sending;
  });

  it('keeps a name typed while the reply was arriving', async () => {
    const sending = useChatStore.getState().send('hello');
    turn.delta('one ');

    await useChatStore.getState().rename('a', 'Pricing investigation');

    turn.delta('two');
    turn.end();
    await sending;

    // The turn's copy predates the rename; saving it whole used to undo it.
    expect(saved.get('a')?.title).toBe('Pricing investigation');
    expect(saved.get('a')?.titleIsCustom).toBe(true);
    expect(textOf(saved.get('a'))).toBe('one two');
    expect(useChatStore.getState().conversations[0]?.title).toBe('Pricing investigation');
  });

  it('keeps a model switched while the reply was arriving', async () => {
    const sending = useChatStore.getState().send('hello');
    turn.delta('one ');

    await useChatStore.getState().setModel('openrouter', 'another/model');

    turn.end();
    await sending;

    // The reply itself is still attributed to the model that produced it.
    expect(saved.get('a')?.modelId).toBe('another/model');
    expect(saved.get('a')?.messages.at(-1)?.modelId).toBe('a/model');
  });

  it('does not resurrect a conversation deleted mid-reply', async () => {
    const sending = useChatStore.getState().send('hello');
    turn.delta('one ');

    await useChatStore.getState().remove('a');
    turn.end();
    await sending;

    expect(saved.has('a')).toBe(false);
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['b']);
  });
});
