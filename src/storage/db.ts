import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ProviderId } from '@/config/schema';

/**
 * Conversation history lives in IndexedDB, not localStorage: transcripts grow
 * without bound and would blow the ~5 MB localStorage budget that the API keys
 * also depend on (spec §4).
 */

export interface StoredToolCall {
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  qualifiedName: string;
  args: unknown;
  status: 'pending' | 'approved' | 'denied' | 'complete' | 'error';
  result?: unknown;
  error?: string;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  /** Model that produced this message, for the per-message badge. */
  modelId?: string;
  providerId?: ProviderId;
  toolCalls?: StoredToolCall[];
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId?: ProviderId;
  modelId?: string;
  messages: StoredMessage[];
}

interface CtbxDB extends DBSchema {
  conversations: {
    key: string;
    value: StoredConversation;
    indexes: { 'by-updated': number };
  };
}

const DB_NAME = 'ctbx';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<CtbxDB>> | undefined;

function db(): Promise<IDBPDatabase<CtbxDB>> {
  dbPromise ??= openDB<CtbxDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const store = database.createObjectStore('conversations', { keyPath: 'id' });
      store.createIndex('by-updated', 'updatedAt');
    },
  });
  return dbPromise;
}

export async function listConversations(): Promise<StoredConversation[]> {
  const all = await (await db()).getAllFromIndex('conversations', 'by-updated');
  return all.reverse();
}

export async function getConversation(id: string): Promise<StoredConversation | undefined> {
  return (await db()).get('conversations', id);
}

export async function putConversation(conversation: StoredConversation): Promise<void> {
  await (await db()).put('conversations', conversation);
}

export async function deleteConversation(id: string): Promise<void> {
  await (await db()).delete('conversations', id);
}

export async function clearConversations(): Promise<void> {
  await (await db()).clear('conversations');
}

export async function countConversations(): Promise<number> {
  return (await db()).count('conversations');
}

/** Derives a conversation title from its first user message. */
export function deriveTitle(messages: StoredMessage[]): string {
  const first = messages.find((message) => message.role === 'user');
  if (!first) return 'New conversation';
  const text = first.content.trim().replace(/\s+/g, ' ');
  if (text === '') return 'New conversation';
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function newConversation(): StoredConversation {
  const now = Date.now();
  return { id: newId(), title: 'New conversation', createdAt: now, updatedAt: now, messages: [] };
}
