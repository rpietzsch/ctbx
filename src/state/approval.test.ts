import { describe, expect, it, vi } from 'vitest';
import { UiApprovalGate } from './approval';

const CALL = {
  serverId: 'srv',
  serverName: 'Memory',
  toolName: 'query',
  qualifiedName: 'memory__query',
  args: { q: 1 },
};

describe('UiApprovalGate', () => {
  it('leaves the promise pending until the user answers', async () => {
    const gate = new UiApprovalGate();
    const settled = vi.fn();

    void gate.request(CALL).then(settled);
    await Promise.resolve();

    // This is the security property: the tool call cannot proceed.
    expect(settled).not.toHaveBeenCalled();
    expect(gate.current()).toMatchObject({ toolName: 'query' });
  });

  it('resolves with the approval decision', async () => {
    const gate = new UiApprovalGate();
    const promise = gate.request(CALL);

    gate.respond(gate.current()!.requestId, { approved: true });

    await expect(promise).resolves.toEqual({ approved: true });
    expect(gate.current()).toBeUndefined();
  });

  it('resolves with a denial and its reason', async () => {
    const gate = new UiApprovalGate();
    const promise = gate.request(CALL);

    gate.respond(gate.current()!.requestId, { approved: false, reason: 'no' });

    await expect(promise).resolves.toEqual({ approved: false, reason: 'no' });
  });

  it('carries the remember flag through', async () => {
    const gate = new UiApprovalGate();
    const promise = gate.request(CALL);
    gate.respond(gate.current()!.requestId, { approved: true, remember: true });
    await expect(promise).resolves.toMatchObject({ remember: true });
  });

  it('queues concurrent requests and surfaces them one at a time', async () => {
    const gate = new UiApprovalGate();
    const first = gate.request({ ...CALL, toolName: 'one' });
    const second = gate.request({ ...CALL, toolName: 'two' });

    expect(gate.pendingCount()).toBe(2);
    expect(gate.current()?.toolName).toBe('one');

    gate.respond(gate.current()!.requestId, { approved: true });
    expect(gate.current()?.toolName).toBe('two');

    gate.respond(gate.current()!.requestId, { approved: false });
    await expect(first).resolves.toEqual({ approved: true });
    await expect(second).resolves.toEqual({ approved: false });
  });

  it('denies everything outstanding when generation is stopped', async () => {
    const gate = new UiApprovalGate();
    const first = gate.request(CALL);
    const second = gate.request(CALL);

    gate.denyAll('stopped');

    await expect(first).resolves.toEqual({ approved: false, reason: 'stopped' });
    await expect(second).resolves.toEqual({ approved: false, reason: 'stopped' });
    expect(gate.pendingCount()).toBe(0);
  });

  it('notifies subscribers when the queue changes', () => {
    const gate = new UiApprovalGate();
    const listener = vi.fn();
    const off = gate.subscribe(listener);

    void gate.request(CALL);
    expect(listener).toHaveBeenCalledTimes(1);

    gate.respond(gate.current()!.requestId, { approved: true });
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    void gate.request(CALL);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores a response for an unknown request', () => {
    const gate = new UiApprovalGate();
    void gate.request(CALL);
    expect(() => gate.respond('not-a-real-id', { approved: true })).not.toThrow();
    expect(gate.pendingCount()).toBe(1);
  });
});
