import { useEffect, useMemo, useRef, useState } from 'react';
import type { StoredMessage, StoredToolCall } from '@/storage/db';
import { Badge, cx } from '@/ui/primitives';
import { formatToolResult, renderMarkdown } from './markdown';

function MarkdownBlock({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className="prose-sm max-w-none [&_a]:underline [&_code]:rounded [&_code]:bg-surface-3 [&_code]:px-1 [&_code]:py-0.5 [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface-3 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-3 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      // Sanitized in renderMarkdown: scripts, handlers, iframes and forms are
      // removed. Model output and tool results are untrusted (spec §9.3).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ToolCallCard({ call }: { call: StoredToolCall }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="my-2 rounded-lg border border-border bg-surface-2 text-sm">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span aria-hidden="true" className="text-fg-muted">
          {open ? '▾' : '▸'}
        </span>
        <span className="font-mono text-xs">{call.toolName}</span>
        {call.status === 'error' ? (
          <Badge tone="danger">error</Badge>
        ) : call.status === 'denied' ? (
          <Badge tone="warn">denied</Badge>
        ) : call.status === 'complete' ? (
          <Badge tone="ok">done</Badge>
        ) : (
          <Badge tone="accent">running</Badge>
        )}
      </button>

      {open ? (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <div>
            <p className="mb-1 text-xs text-fg-muted">Arguments</p>
            <pre className="overflow-x-auto rounded bg-surface-3 p-2 text-xs">
              {formatToolResult(call.args)}
            </pre>
          </div>
          {call.result !== undefined ? (
            <div>
              <p className="mb-1 text-xs text-fg-muted">Result</p>
              {/* Rendered as inert text, never as markup. */}
              <pre className="max-h-72 overflow-auto rounded bg-surface-3 p-2 text-xs">
                {formatToolResult(call.result)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MessageList({
  messages,
  streaming,
}: {
  messages: StoredMessage[];
  streaming: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming]);

  if (messages.length === 0) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="max-w-md space-y-2">
          <h2 className="text-lg font-semibold">Start a conversation</h2>
          <p className="text-sm text-fg-muted">
            Pick a model below and send a message. Connected MCP servers add their tools
            automatically.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
      {messages.map((message) => (
        <article
          key={message.id}
          className={cx('flex flex-col gap-1', message.role === 'user' && 'items-end')}
        >
          <div
            className={cx(
              'max-w-full rounded-2xl px-4 py-2.5',
              message.role === 'user' ? 'bg-accent text-accent-fg' : 'bg-surface-2'
            )}
          >
            {message.role === 'user' ? (
              <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
            ) : (
              <>
                {message.toolCalls?.map((call) => (
                  <ToolCallCard key={call.id} call={call} />
                ))}
                {message.content ? (
                  <MarkdownBlock source={message.content} />
                ) : streaming ? (
                  <p className="text-sm text-fg-muted">…</p>
                ) : null}
              </>
            )}
          </div>

          {message.error ? (
            <p role="alert" className="text-xs text-danger">
              {message.error}
            </p>
          ) : null}

          {message.role === 'assistant' && message.modelId ? (
            <p className="text-xs text-fg-muted">
              {message.modelId}
              {message.usage?.outputTokens ? ` · ${message.usage.outputTokens} output tokens` : ''}
            </p>
          ) : null}
        </article>
      ))}

      {/* Announces streamed output to assistive technology. */}
      <div aria-live="polite" className="sr-only">
        {streaming ? 'Generating a response' : 'Response complete'}
      </div>
      <div ref={endRef} />
    </div>
  );
}
