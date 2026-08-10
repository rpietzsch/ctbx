import { describe, expect, it, vi } from 'vitest';
import {
  canonicalHeaderName,
  createNegotiatingFetch,
  dropPlan,
  headerNames,
  isOpaqueNetworkFailure,
  withoutHeaders,
} from './header-negotiation';

describe('withoutHeaders', () => {
  it('removes headers case-insensitively', () => {
    const result = withoutHeaders(
      { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
      new Set(['mcp-protocol-version'])
    );
    expect(result.get('content-type')).toBe('application/json');
    expect(result.has('mcp-protocol-version')).toBe(false);
  });

  it('accepts a Headers instance and an array of tuples', () => {
    const fromHeaders = withoutHeaders(new Headers({ Accept: 'application/json' }), new Set());
    expect(fromHeaders.get('accept')).toBe('application/json');

    const fromTuples = withoutHeaders([['Accept', 'text/event-stream']], new Set());
    expect(fromTuples.get('accept')).toBe('text/event-stream');
  });
});

describe('headerNames', () => {
  it('lower-cases the names', () => {
    expect(headerNames({ 'Mcp-Session-Id': 'abc' })).toEqual(['mcp-session-id']);
  });

  it('is empty for a request without headers', () => {
    expect(headerNames(undefined)).toEqual([]);
  });
});

describe('dropPlan', () => {
  it('drops the cheapest header first, then widens', () => {
    expect(dropPlan(['mcp-protocol-version', 'mcp-session-id', 'content-type'], new Set())).toEqual(
      [['mcp-protocol-version'], ['mcp-protocol-version', 'mcp-session-id']]
    );
  });

  it('never proposes dropping a header the request does not carry', () => {
    expect(dropPlan(['content-type', 'authorization'], new Set())).toEqual([]);
  });

  it('skips headers already known to be dropped', () => {
    expect(
      dropPlan(['mcp-protocol-version', 'mcp-session-id'], new Set(['mcp-protocol-version']))
    ).toEqual([['mcp-session-id']]);
  });
});

describe('isOpaqueNetworkFailure', () => {
  it('recognises the TypeError every browser reports for a blocked request', () => {
    // Chrome and Firefox word it differently; both throw a TypeError.
    expect(isOpaqueNetworkFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(
      isOpaqueNetworkFailure(new TypeError('NetworkError when attempting to fetch resource.'))
    ).toBe(true);
  });

  it('does not treat an abort as retryable', () => {
    expect(isOpaqueNetworkFailure(new DOMException('aborted', 'AbortError'))).toBe(false);
  });
});

/**
 * The real-world case: a server whose Access-Control-Allow-Headers omits
 * MCP-Protocol-Version. `initialize` carries no such header and succeeds, the
 * request right after it carries one and is blocked by the browser.
 */
function serverRejecting(blocked: string[]) {
  return vi.fn(async (_input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    for (const name of blocked) {
      if (headers.has(name)) throw new TypeError('NetworkError when attempting to fetch resource.');
    }
    return new Response('{}', { status: 200 });
  });
}

describe('createNegotiatingFetch', () => {
  it('passes a request through untouched when nothing is blocked', async () => {
    const fetchFn = serverRejecting([]);
    const negotiating = createNegotiatingFetch({ fetchFn });

    await negotiating('https://mcp.example.com/mcp', {
      headers: { 'MCP-Protocol-Version': '2025-06-18' },
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(negotiating.dropped).toEqual([]);
  });

  it('retries without the blocked header and succeeds', async () => {
    const fetchFn = serverRejecting(['mcp-protocol-version']);
    const onDrop = vi.fn();
    const negotiating = createNegotiatingFetch({ fetchFn, onDrop });

    const response = await negotiating('https://mcp.example.com/mcp', {
      headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
    });

    expect(response.status).toBe(200);
    expect(negotiating.dropped).toEqual(['mcp-protocol-version']);
    expect(onDrop).toHaveBeenCalledWith(['mcp-protocol-version']);

    // The retry keeps every header that was not the problem.
    const retry = new Headers((fetchFn.mock.calls[1]![1] as RequestInit).headers);
    expect(retry.get('content-type')).toBe('application/json');
  });

  it('strips a known-blocked header from later requests without a failed attempt', async () => {
    const fetchFn = serverRejecting(['mcp-protocol-version']);
    const negotiating = createNegotiatingFetch({ fetchFn });

    await negotiating('https://mcp.example.com/mcp', {
      headers: { 'MCP-Protocol-Version': '2025-06-18' },
    });
    fetchFn.mockClear();

    await negotiating('https://mcp.example.com/mcp', {
      headers: { 'MCP-Protocol-Version': '2025-06-18' },
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('widens the reduction when dropping one header is not enough', async () => {
    const fetchFn = serverRejecting(['mcp-protocol-version', 'mcp-session-id']);
    const negotiating = createNegotiatingFetch({ fetchFn });

    const response = await negotiating('https://mcp.example.com/mcp', {
      headers: { 'MCP-Protocol-Version': '2025-06-18', 'Mcp-Session-Id': 'session-1' },
    });

    expect(response.status).toBe(200);
    expect(negotiating.dropped).toEqual(['mcp-protocol-version', 'mcp-session-id']);
  });

  it('reports the original failure when no reduction helps', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    });
    const negotiating = createNegotiatingFetch({ fetchFn });

    await expect(
      negotiating('https://mcp.example.com/mcp', {
        headers: { 'MCP-Protocol-Version': '2025-06-18' },
      })
    ).rejects.toThrow(/NetworkError/);
    expect(negotiating.dropped).toEqual([]);
  });

  it('stops re-sending the body once a full round of reductions has failed', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const negotiating = createNegotiatingFetch({ fetchFn });
    const init = { headers: { 'MCP-Protocol-Version': '2025-06-18' }, body: 'x' };

    // First call: the real attempt plus one reduction.
    await expect(negotiating('https://mcp.example.com/mcp', init)).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // Everything after it is a single attempt — a genuinely down network must
    // not make every tool call fire twice.
    fetchFn.mockClear();
    await expect(negotiating('https://mcp.example.com/mcp', init)).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not retry a request the caller aborted', async () => {
    const fetchFn = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    const negotiating = createNegotiatingFetch({ fetchFn });

    await expect(
      negotiating('https://mcp.example.com/mcp', {
        headers: { 'MCP-Protocol-Version': '2025-06-18' },
      })
    ).rejects.toThrow(/aborted/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the request carries nothing droppable', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const negotiating = createNegotiatingFetch({ fetchFn });

    await expect(
      negotiating('https://mcp.example.com/mcp', {
        headers: { 'Content-Type': 'application/json' },
      })
    ).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('canonicalHeaderName', () => {
  it('spells the headers the way a CORS configuration does', () => {
    expect(canonicalHeaderName('mcp-protocol-version')).toBe('MCP-Protocol-Version');
    expect(canonicalHeaderName('mcp-session-id')).toBe('Mcp-Session-Id');
  });

  it('leaves an unknown header alone', () => {
    expect(canonicalHeaderName('x-custom')).toBe('x-custom');
  });
});
