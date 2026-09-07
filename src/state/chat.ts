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

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  streaming: false,

  async load() {
    const conversations = await listConversations();
    const current = conversations[0] ?? newConversation();
    if (conversations.length === 0) await putConversation(current);
    set({ conversations: conversations.length > 0 ? conversations : [current], current });
  },

  async select(id) {
    const conversation = await getConversation(id);
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
    const target =
      get().current?.id === id ? get().current : get().conversations.find((c) => c.id === id);
    if (!target) return;

    // Clearing the name is how the user gets the automatic title back, so an
    // empty input is a valid instruction rather than something to reject.
    const trimmed = title.trim();
    const { titleIsCustom: _was, ...rest } = target;
    const updated: StoredConversation =
      trimmed === ''
        ? { ...rest, title: deriveTitle(target.messages) }
        : { ...rest, title: trimmed, titleIsCustom: true };

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

    let working = touch({
      ...conversation,
      messages: [...conversation.messages, userMessage, assistantMessage],
    });
    set({ current: working, streaming: true, error: undefined });

    const abortController = new AbortController();
    set({ abortController });

    const update = (mutate: (message: StoredMessage) => StoredMessage) => {
      working = {
        ...working,
        messages: working.messages.map((message) =>
          message.id === assistantMessage.id ? mutate(message) : message
        ),
      };
      set({ current: working });
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
        set({ error: result.failure.message });
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
      set({ error: failure.message });
    } finally {
      approvalGate.denyAll();
      working = touch(working);
      await putConversation(working);
      const conversations = await listConversations();
      set({ streaming: false, abortController: undefined, current: working, conversations });
    }
  },

  stop() {
    get().abortController?.abort();
    approvalGate.denyAll('Generation was stopped.');
    set({ streaming: false });
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
