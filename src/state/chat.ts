import { create } from 'zustand';
import type { ProviderId } from '@/config/schema';
import { preferencesStore } from '@/config/stores';
import { resolveModel } from '@/providers/registry';
import { runTurn, toModelMessages } from '@/engine/conversation';
import { describeFailure } from '@/engine/errors';
import {
  deleteConversation as dbDelete,
  deriveTitle,
  titleFor,
  getConversation,
  listConversations,
  newConversation,
  newId,
  putConversation,
  type StoredConversation,
  type StoredMessage,
  type StoredToolCall,
} from '@/storage/db';
import { McpManager } from '@/mcp/manager';
import { parseNamespacedToolName } from '@/mcp/tool-adapter';
import { UiApprovalGate } from './approval';

export const approvalGate = new UiApprovalGate();
export const mcpManager = new McpManager(approvalGate);

interface ChatState {
  conversations: StoredConversation[];
  current?: StoredConversation;
  streaming: boolean;
  /**
   * The conversation a reply is arriving in, which is not necessarily the one
   * on screen: reading another conversation must not interrupt the answer, and
   * the answer must not drag the reader back (see `send`).
   */
  streamingId?: string;
  error?: string;
  abortController?: AbortController;

  load(): Promise<void>;
  select(id: string): Promise<void>;
  startNew(): Promise<void>;
  remove(id: string): Promise<void>;
  setModel(providerId: ProviderId, modelId: string): Promise<void>;
  /** Pins the conversation to one OpenRouter endpoint; `undefined` unpins. */
  setEndpoint(endpointTag: string | undefined): Promise<void>;
  /** Names a conversation. A blank name restores the derived one. */
  rename(id: string, title: string): Promise<void>;
  send(text: string): Promise<void>;
  stop(): void;
}

function touch(conversation: StoredConversation): StoredConversation {
  return { ...conversation, updatedAt: Date.now(), title: titleFor(conversation) };
}

/**
 * A turn in flight, held outside the store so that streaming into a
 * conversation nobody is looking at costs no renders at all. Until the turn
 * ends this copy is newer than the one in IndexedDB, which is why `select`,
 * `load` and every edit to the record go through it.
 */
interface Draft {
  /** The turn that owns it: a stopped turn must not write over its successor. */
  turn: number;
  conversation: StoredConversation;
}

const drafts = new Map<string, Draft>();

function draftFor(id: string): StoredConversation | undefined {
  return drafts.get(id)?.conversation;
}

/**
 * Folds an edit of the conversation record into the reply arriving in it.
 *
 * The turn holds a copy taken before the edit, and saving that copy when the
 * reply ends would put the old value straight back — the name the reader just
 * typed, the model they just switched to, the pin they just set. The turn owns
 * the transcript; everything else about the conversation is taken from here.
 */
function patchDraft(updated: StoredConversation): void {
  const draft = drafts.get(updated.id);
  if (draft) draft.conversation = { ...updated, messages: draft.conversation.messages };
}

/** Counts turns, so a stopped one can tell that a newer turn has taken over. */
let turns = 0;

/** A conversation deleted mid-reply, which the turn must not write back. */
let discardedId: string | undefined;

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  streaming: false,

  async load() {
    // Visiting the settings pages remounts the chat, and a reply started before
    // that is still arriving. Its draft is ahead of what IndexedDB holds — which
    // is written only when the turn ends — so the stored copy would rewind the
    // answer on the way back, and the reader would watch it replay.
    const stored = await listConversations();
    const conversations = stored.map((c) => draftFor(c.id) ?? c);
    const streamingId = get().streamingId;
    const current =
      (streamingId === undefined ? undefined : draftFor(streamingId)) ??
      conversations[0] ??
      newConversation();
    if (conversations.length === 0) await putConversation(current);
    set({ conversations: conversations.length > 0 ? conversations : [current], current });
  },

  async select(id) {
    // The stored copy of a conversation being streamed into is a turn behind,
    // so returning to it would show the answer truncated at wherever it stood
    // when the reader left. The draft holds what has arrived since.
    const conversation = draftFor(id) ?? (await getConversation(id));
    if (conversation) set({ current: conversation, error: undefined });
  },

  async startNew() {
    const conversation = newConversation();
    const previous = get().current;
    // Carry the model choice forward; re-picking it every time is tedious.
    // The endpoint pin rides along with it: it belongs to that exact model, so
    // it stays valid for exactly as long as the model does.
    if (previous?.providerId && previous.modelId) {
      conversation.providerId = previous.providerId;
      conversation.modelId = previous.modelId;
      if (previous.endpointTag !== undefined) conversation.endpointTag = previous.endpointTag;
    }
    await putConversation(conversation);
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      current: conversation,
      error: undefined,
    }));
  },

  async remove(id) {
    // Deleting the conversation a reply is arriving in has to stop that reply
    // and mark it, or the turn's own write-back resurrects what was deleted.
    if (get().streamingId === id) {
      discardedId = id;
      get().stop();
    }
    await dbDelete(id);
    const conversations = await listConversations();
    set({
      conversations,
      current: get().current?.id === id ? conversations[0] : get().current,
    });
    if (conversations.length === 0) await get().startNew();
  },

  async setModel(providerId, modelId) {
    const current = get().current;
    if (!current) return;
    // A pin names an endpoint serving one model, so changing the model has to
    // drop it. Keeping it would either fail the request or, worse, silently
    // route to a provider that happens to share the tag.
    const { endpointTag: _dropped, ...rest } = current;
    const updated = { ...rest, providerId, modelId };
    patchDraft(updated);
    await putConversation(updated);
    preferencesStore.update((preferences) => {
      const { defaultEndpointTag: _cleared, ...others } = preferences;
      return { ...others, defaultProviderId: providerId, defaultModelId: modelId };
    });
    set((state) => ({
      current: updated,
      conversations: state.conversations.map((c) => (c.id === updated.id ? updated : c)),
    }));
  },

  async setEndpoint(endpointTag) {
    const current = get().current;
    if (!current) return;
    const { endpointTag: _previous, ...rest } = current;
    const updated = endpointTag === undefined ? rest : { ...rest, endpointTag };
    patchDraft(updated);
    await putConversation(updated);
    preferencesStore.update((preferences) => {
      const { defaultEndpointTag: _cleared, ...others } = preferences;
      return endpointTag === undefined ? others : { ...others, defaultEndpointTag: endpointTag };
    });
    set((state) => ({
      current: updated,
      conversations: state.conversations.map((c) => (c.id === updated.id ? updated : c)),
    }));
  },

  async rename(id, title) {
    // The draft first: a conversation with a reply arriving in it is one turn
    // ahead of both the list and the database, and renaming from a stale copy
    // would save a transcript missing everything that has arrived.
    const target =
      draftFor(id) ??
      (get().current?.id === id ? get().current : get().conversations.find((c) => c.id === id));
    if (!target) return;

    // Clearing the name is how the user gets the automatic title back, so an
    // empty input is a valid instruction rather than something to reject.
    const trimmed = title.trim();
    const { titleIsCustom: _was, ...rest } = target;
    const updated: StoredConversation =
      trimmed === ''
        ? { ...rest, title: deriveTitle(target.messages) }
        : { ...rest, title: trimmed, titleIsCustom: true };

    patchDraft(updated);
    await putConversation(updated);
    set((state) => ({
      conversations: state.conversations.map((c) => (c.id === id ? updated : c)),
      ...(state.current?.id === id ? { current: updated } : {}),
    }));
  },

  async send(text) {
    const state = get();
    const conversation = state.current;
    if (!conversation || state.streaming) return;
    if (!conversation.providerId || !conversation.modelId) {
      set({ error: 'Choose a model before sending.' });
      return;
    }

    const userMessage: StoredMessage = {
      id: newId(),
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };
    const assistantMessage: StoredMessage = {
      id: newId(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      providerId: conversation.providerId,
      modelId: conversation.modelId,
      toolCalls: [],
    };

    const started = touch({
      ...conversation,
      messages: [...conversation.messages, userMessage, assistantMessage],
    });

    /*
      The reply is assembled in the draft and only published to the store while
      this conversation is the one on screen. That is what lets the reader open
      another conversation without either interrupting the answer or being
      yanked back here by the next token; `select` reads the draft back, so
      returning shows everything that arrived while they were away.
    */
    const turn = ++turns;
    drafts.set(conversation.id, { turn, conversation: started });
    const viewing = () => get().current?.id === conversation.id;

    const abortController = new AbortController();
    set({
      current: started,
      streaming: true,
      streamingId: conversation.id,
      abortController,
      error: undefined,
      // The sidebar title is derived from the first user message, so publishing
      // the list entry now names a brand-new conversation as it is sent rather
      // than leaving it as "New conversation" until the reply lands.
      conversations: state.conversations.map((c) => (c.id === started.id ? started : c)),
    });

    const update = (mutate: (message: StoredMessage) => StoredMessage) => {
      // Not `turns`: what matters is whether this turn still owns the draft, so
      // that a stopped turn cannot write into the one that replaced it.
      const draft = drafts.get(conversation.id);
      if (draft?.turn !== turn) return;
      draft.conversation = {
        ...draft.conversation,
        messages: draft.conversation.messages.map((message) =>
          message.id === assistantMessage.id ? mutate(message) : message
        ),
      };
      if (viewing()) set({ current: draft.conversation });
    };

    // A failure in a conversation the reader has left would otherwise surface
    // under the composer of the one they are reading. It is recorded on the
    // message either way, so it is waiting for them when they come back.
    const report = (message: string) => {
      if (viewing()) set({ error: message });
    };

    try {
      const model = resolveModel(conversation.providerId, conversation.modelId, {
        ...(conversation.endpointTag === undefined
          ? {}
          : { endpointTag: conversation.endpointTag }),
      });
      const preferences = preferencesStore.get();

      const result = await runTurn({
        model,
        messages: toModelMessages([...conversation.messages, userMessage]),
        tools: mcpManager.hasConnectedServers() ? mcpManager.tools() : undefined,
        maxSteps: preferences.maxSteps,
        abortSignal: abortController.signal,
        onTextDelta: (delta) =>
          update((message) => ({ ...message, content: message.content + delta })),
        onToolCall: (call) =>
          update((message) => ({
            ...message,
            toolCalls: [...(message.toolCalls ?? []), toolCallRecord(call)],
          })),
        onToolResult: (toolResult) =>
          update((message) => ({
            ...message,
            toolCalls: (message.toolCalls ?? []).map((call) =>
              call.id === toolResult.toolCallId
                ? { ...call, status: 'complete', result: toolResult.output }
                : call
            ),
          })),
      });

      if (result.failure) {
        update((message) => ({ ...message, error: result.failure!.message }));
        report(result.failure.message);
      } else if (result.usage || result.costUsd !== undefined || result.route) {
        // The pin is recorded alongside the accounting because it is what tells
        // the footer whether the cached model price may be used as a fallback.
        update((message) => ({
          ...message,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
          ...(result.route === undefined ? {} : { route: result.route }),
          ...(conversation.endpointTag === undefined
            ? {}
            : { endpointTag: conversation.endpointTag }),
        }));
      }
    } catch (error) {
      const failure = describeFailure(error);
      update((message) => ({ ...message, error: failure.message }));
      report(failure.message);
    } finally {
      approvalGate.denyAll();

      // Stopping a turn frees the composer at once, so the next turn can begin
      // before this one has finished unwinding. What that one owns is no longer
      // this turn's to write: neither the flags below nor, when it continues
      // the same conversation, the draft it has already claimed.
      const draft = drafts.get(conversation.id);
      const mine = draft?.turn === turn;
      if (mine) drafts.delete(conversation.id);
      const superseded = turn !== turns;
      const discarded = discardedId === conversation.id;
      if (discarded) discardedId = undefined;

      // A conversation deleted mid-reply must stay deleted: saving it here
      // would resurrect it in the sidebar.
      const saved = mine && !discarded ? touch(draft.conversation) : undefined;
      if (saved) await putConversation(saved);

      const conversations = await listConversations();
      set({
        conversations,
        ...(superseded
          ? {}
          : { streaming: false, streamingId: undefined, abortController: undefined }),
        ...(saved && viewing() ? { current: saved } : {}),
      });
    }
  },

  stop() {
    get().abortController?.abort();
    approvalGate.denyAll('Generation was stopped.');
    set({ streaming: false, streamingId: undefined });
  },
}));

function toolCallRecord(call: {
  toolCallId: string;
  toolName: string;
  args: unknown;
}): StoredToolCall {
  const parsed = parseNamespacedToolName(call.toolName);
  return {
    id: call.toolCallId,
    serverId: parsed?.slug ?? '',
    serverName: parsed?.slug ?? '',
    toolName: parsed?.toolName ?? call.toolName,
    qualifiedName: call.toolName,
    args: call.args,
    status: 'approved',
  };
}
