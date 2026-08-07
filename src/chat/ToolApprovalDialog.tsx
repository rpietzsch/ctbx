import { useSyncExternalStore } from 'react';
import { approvalGate } from '@/state/chat';
import { Button } from '@/ui/primitives';
import { formatToolResult } from './markdown';

/**
 * The approval prompt. This is the security boundary for prompt injection
 * reaching real tools (spec §6.4, §9.3), so it always names the server and the
 * exact arguments — a user cannot consent to something they cannot see.
 */
export function ToolApprovalDialog() {
  const pending = useSyncExternalStore(
    (listener) => approvalGate.subscribe(listener),
    () => approvalGate.current(),
    () => undefined
  );

  if (!pending) return null;

  const respond = (approved: boolean, remember = false) => {
    approvalGate.respond(
      pending.requestId,
      approved ? { approved: true, remember } : { approved: false }
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface p-5 shadow-xl">
        <h2 id="approval-title" className="text-base font-semibold">
          Allow this tool call?
        </h2>

        <dl className="mt-3 space-y-1.5 text-sm">
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-fg-muted">Server</dt>
            <dd className="font-medium">{pending.serverName}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-fg-muted">Tool</dt>
            <dd className="font-mono text-xs">{pending.toolName}</dd>
          </div>
        </dl>

        <p className="mt-3 text-xs text-fg-muted">Arguments</p>
        <pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-surface-2 p-3 text-xs">
          {formatToolResult(pending.args)}
        </pre>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => respond(false)}>
            Reject
          </Button>
          <Button variant="secondary" onClick={() => respond(true, true)}>
            Always allow this tool
          </Button>
          <Button variant="primary" onClick={() => respond(true)}>
            Approve once
          </Button>
        </div>

        {approvalGate.pendingCount() > 1 ? (
          <p className="mt-3 text-xs text-fg-muted">
            {approvalGate.pendingCount() - 1} more waiting.
          </p>
        ) : null}
      </div>
    </div>
  );
}
