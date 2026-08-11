import { useEffect, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { MessageList } from '@/chat/MessageList';
import { ToolApprovalDialog } from '@/chat/ToolApprovalDialog';
import { ModelPicker } from '@/chat/ModelPicker';
import { mcpManager, useChatStore } from '@/state/chat';
import { configuredProviders, preferencesStore } from '@/config/stores';
import { Button, ErrorNote, cx } from '@/ui/primitives';

export function ChatPage() {
  const { conversations, current, streaming, error, load, select, startNew, remove, send, stop } =
    useChatStore();
  const [draft, setDraft] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Read once at mount: setting this from inside the effect would cascade renders.
  const [hasProviders] = useState(() => configuredProviders().length > 0);

  useEffect(() => {
    void load();
    mcpManager.sync();
    void mcpManager.resumeRedirectAuthorization().then(() => mcpManager.connectAutoStart());
  }, [load]);

  const submit = () => {
    const text = draft.trim();
    if (text === '' || streaming) return;
    setDraft('');
    void send(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const sendOnEnter = preferencesStore.get().sendOnEnter;
    if (event.key === 'Enter' && !event.shiftKey && sendOnEnter) {
      event.preventDefault();
      submit();
    }
  };

  if (!hasProviders) return <FirstRun />;

  const conversationList = (
    <>
      <div className="p-2">
        <Button
          className="w-full"
          onClick={() => {
            void startNew();
            setDrawerOpen(false);
          }}
        >
          New conversation
        </Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {conversations.map((conversation) => (
          <li key={conversation.id} className="group flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                void select(conversation.id);
                setDrawerOpen(false);
              }}
              className={cx(
                'min-w-0 flex-1 truncate rounded-lg px-2.5 py-1.5 text-left text-sm',
                conversation.id === current?.id ? 'bg-surface-3' : 'hover:bg-surface-2'
              )}
            >
              {conversation.title}
            </button>
            <button
              type="button"
              aria-label={`Delete ${conversation.title}`}
              onClick={() => void remove(conversation.id)}
              // Hover-reveal hides it permanently on a touch screen, where
              // there is no hover — so it stays visible without a pointer.
              className="rounded px-2 py-1.5 text-xs text-fg-muted md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border md:flex">
        {conversationList}
      </aside>

      {/*
        The sidebar is the only way to reach past conversations, and it is
        hidden below md — so on a phone it becomes a drawer rather than simply
        not existing.
      */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-30 md:hidden">
          <button
            type="button"
            aria-label="Close conversations"
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-2xl">
            {conversationList}
          </div>
        </div>
      ) : null}

      <section className="flex min-w-0 flex-1 flex-col">
        {/*
          No scroll container here: the transcript owns its own, because it has
          to know where the reader is before deciding whether to follow new
          output (see follow-scroll.ts).
        */}
        <div className="min-h-0 flex-1">
          <MessageList messages={current?.messages ?? []} streaming={streaming} />
        </div>

        <div
          className={cx(
            'shrink-0 border-t border-border p-3',
            // Clear the home indicator, which otherwise sits over the composer.
            'pb-[calc(0.75rem+env(safe-area-inset-bottom))]',
            'pl-[calc(0.75rem+env(safe-area-inset-left))] pr-[calc(0.75rem+env(safe-area-inset-right))]'
          )}
        >
          <div className="mx-auto max-w-3xl space-y-2">
            {error ? <ErrorNote>{error}</ErrorNote> : null}

            <div className="flex items-center gap-2">
              <Button
                className="shrink-0 md:hidden"
                size="sm"
                aria-label="Conversations"
                onClick={() => setDrawerOpen(true)}
              >
                ☰
              </Button>
              <ModelPicker />
              <span className="min-w-0 flex-1 text-right">
                <McpStatus />
              </span>
            </div>

            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                aria-label="Message"
                placeholder="Send a message…"
                className="max-h-48 min-h-[3rem] flex-1 resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              />
              {streaming ? (
                <Button variant="secondary" onClick={stop}>
                  Stop
                </Button>
              ) : (
                <Button variant="primary" onClick={submit} disabled={draft.trim() === ''}>
                  Send
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>

      <ToolApprovalDialog />
    </div>
  );
}

function McpStatus() {
  const connected = mcpManager.hasConnectedServers();
  const count = mcpManager.toolCount();
  if (!connected) return null;
  return (
    <span className="text-xs text-fg-muted">
      {count} tool{count === 1 ? '' : 's'} available
    </span>
  );
}

function FirstRun() {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold">Welcome to ctbx</h1>
        <p className="text-sm text-fg-muted">
          A chat client that runs entirely in your browser. Your API keys are stored in this browser
          only and are sent straight to the provider — there is no server in between.
        </p>
        <p className="text-sm text-fg-muted">
          Start with OpenRouter: one key reaches most models, and it works from a browser without
          per-vendor caveats.
        </p>
        <Link to="/settings/providers">
          <Button variant="primary">Add an API key</Button>
        </Link>
      </div>
    </div>
  );
}
