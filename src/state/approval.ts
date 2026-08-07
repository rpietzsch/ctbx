import type { ApprovalDecision, ApprovalGate, PendingToolCall } from '@/mcp/tool-adapter';

export interface PendingApproval extends PendingToolCall {
  requestId: string;
}

/**
 * Bridges the tool adapter's async approval gate to the UI.
 *
 * `request()` returns a promise that stays unresolved until the user answers,
 * which is exactly the property the security boundary needs: the MCP call in
 * `buildTools` cannot proceed past the await (spec §6.4).
 */
export class UiApprovalGate implements ApprovalGate {
  private queue: {
    approval: PendingApproval;
    resolve: (decision: ApprovalDecision) => void;
  }[] = [];
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** The approval the UI should currently be showing, if any. */
  current(): PendingApproval | undefined {
    return this.queue[0]?.approval;
  }

  pendingCount(): number {
    return this.queue.length;
  }

  request(call: PendingToolCall): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      this.queue.push({
        approval: { ...call, requestId: globalThis.crypto.randomUUID() },
        resolve,
      });
      this.notify();
    });
  }

  respond(requestId: string, decision: ApprovalDecision): void {
    const index = this.queue.findIndex((entry) => entry.approval.requestId === requestId);
    if (index === -1) return;
    const [entry] = this.queue.splice(index, 1);
    entry!.resolve(decision);
    this.notify();
  }

  /** Denies everything outstanding — used when the user stops generation. */
  denyAll(reason = 'Generation was stopped.'): void {
    const outstanding = this.queue.splice(0, this.queue.length);
    for (const entry of outstanding) entry.resolve({ approved: false, reason });
    if (outstanding.length > 0) this.notify();
  }
}
