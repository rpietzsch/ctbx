import { create } from 'zustand';
import type { ProviderId } from '@/config/schema';
import { preferencesStore } from '@/config/stores';
import { resolveModel } from '@/providers/registry';
import { runTurn, toModelMessages } from '@/engine/conversation';
import { describeFailure } from '@/engine/errors';
import {
  deleteConversation as dbDelete,
  deriveTitle,
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
  send(text: string): Promise<void>;
  stop(): void;
}

function touch(conversation: StoredConversation): StoredConversation {
  return { ...conversation, updatedAt: Date.now(), title: deriveTitle(conversation.messages) };
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
    if (previous?.providerId && previous.modelId) {
      conversation.providerId = previous.providerId;
      conversation.modelId = previous.modelId;
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
    const updated = { ...current, providerId, modelId };
    await putConversation(updated);
    preferencesStore.update((preferences) => ({
      ...preferences,
      defaultProviderId: providerId,
      defaultModelId: modelId,
    }));
    set((state) => ({
      current: updated,
      conversations: state.conversations.map((c) => (c.id === updated.id ? updated : c)),
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
      const model = resolveModel(conversation.providerId, conversation.modelId);
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
      } else if (result.usage) {
        update((message) => ({ ...message, usage: result.usage }));
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
