import { useEffect, useState } from 'react';
import {
  clearAllStores,
  clearSecretStores,
  summarizeStorage,
  type StoredItemSummary,
} from '@/storage/local';
import { clearConversations, countConversations } from '@/storage/db';
import { Badge, Button, Card } from '@/ui/primitives';

/**
 * Data transparency (spec §9.2). Lists everything this app has stored, without
 * ever showing a stored value, and offers targeted deletion.
 */
export function DataPage() {
  const [items, setItems] = useState<StoredItemSummary[]>(() => summarizeStorage());
  const [conversationCount, setConversationCount] = useState(0);

  const refresh = async () => {
    // Await before touching state: a synchronous setState in the mount effect
    // cascades renders.
    const count = await countConversations();
    setItems(summarizeStorage());
    setConversationCount(count);
  };

  useEffect(() => {
    // Fetch-on-mount: the IndexedDB count is only available asynchronously.
    // State is set after the await, but the rule cannot see through the call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Stored data</h1>
        <p className="text-sm text-fg-muted">
          Everything ctbx keeps, all of it in this browser. Nothing is sent anywhere except to the
          providers and MCP servers you configure.
        </p>
      </header>

      <Card className="space-y-3">
        <h2 className="font-medium">Local storage</h2>
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.name} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{item.label}</p>
                <p className="text-xs text-fg-muted">
                  <code>{item.name}</code>
                  {item.present ? ` · ${formatBytes(item.bytes)}` : ' · empty'}
                </p>
              </div>
              {item.secret ? <Badge tone="warn">credentials</Badge> : null}
            </li>
          ))}
          {items.length === 0 ? (
            <li className="py-2 text-sm text-fg-muted">Nothing stored yet.</li>
          ) : null}
        </ul>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-medium">Conversations</h2>
        <p className="text-sm text-fg-muted">
          {conversationCount} conversation{conversationCount === 1 ? '' : 's'} in IndexedDB.
        </p>
        <Button
          variant="ghost"
          onClick={async () => {
            await clearConversations();
            await refresh();
          }}
        >
          Delete all conversations
        </Button>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-medium">Forget</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              clearSecretStores();
              void refresh();
            }}
          >
            Forget all keys and tokens
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              clearAllStores();
              await clearConversations();
              await refresh();
            }}
          >
            Forget everything
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
