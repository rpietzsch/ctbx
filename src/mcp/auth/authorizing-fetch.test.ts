import { describe, expect, it, vi } from 'vitest';
import { createAuthorizingFetch, isRenewableRejection } from './authorizing-fetch';

function json(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 202 ? null : '{}', { status, headers });
}

const CHALLENGE = 'WWW-Authenticate';

describe('isRenewableRejection', () => {
  it('treats a 401 as a credential problem even with no readable challenge', () => {
    // Servers that omit WWW-Authenticate from Access-Control-Expose-Headers
    // leave the browser nothing to read, and they are common (spec §9.1).
    expect(isRenewableRejection(401, null)).toBe(true);
  });

  it('renews on a 403 that names an invalid token', () => {
    expect(isRenewableRejection(403, 'Bearer error="invalid_token"')).toBe(true);
    expect(isRenewableRejection(403, 'Bearer error="expired_token"')).toBe(true);
  });

  it('leaves a plain 403 alone, because the caller is known and still refused', () => {
    expect(isRenewableRejection(403, null)).toBe(false);
    expect(isRenewableRejection(403, 'Bearer error="insufficient_scope"')).toBe(false);
  });

  it('ignores statuses that say nothing about the token', () => {
    expect(isRenewableRejection(404, null)).toBe(false);
    expect(isRenewableRejection(500, null)).toBe(false);
  });
});

describe('createAuthorizingFetch', () => {
  it('resolves the token per request rather than once per connection', async () => {
    const seen: (string | null)[] = [];
    const tokens = ['first', 'second', 'third'];
    const authorizing = createAuthorizingFetch({
      token: async () => tokens.shift(),
      fetchFn: async (_url, init) => {
        seen.push(new Headers(init?.headers).get('Authorization'));
        return json(200);
      },
    });

    await authorizing('https://mcp.example.com/', { method: 'POST', body: '{}' });
    await authorizing('https://mcp.example.com/', { method: 'POST', body: '{}' });
    await authorizing('https://mcp.example.com/', { method: 'POST', body: '{}' });

    expect(seen).toEqual(['Bearer first', 'Bearer second', 'Bearer third']);
  });

  it('preserves the headers the transport set', async () => {
    let seen: Headers | undefined;
    const authorizing = createAuthorizingFetch({
      token: async () => 'tok',
      fetchFn: async (_url, init) => {
        seen = new Headers(init?.headers);
        return json(200);
      },
    });

    await authorizing('https://mcp.example.com/', {
      headers: { 'mcp-protocol-version': '2025-06-18', 'content-type': 'application/json' },
    });

    expect(seen?.get('mcp-protocol-version')).toBe('2025-06-18');
    expect(seen?.get('Authorization')).toBe('Bearer tok');
  });

  it('sends nothing when no token is held, so an open server stays anonymous', async () => {
    let seen: string | null = 'unset';
    const authorizing = createAuthorizingFetch({
      token: async () => undefined,
      fetchFn: async (_url, init) => {
        seen = new Headers(init?.headers).get('Authorization');
        return json(200);
      },
    });

    await authorizing('https://mcp.example.com/');
    expect(seen).toBeNull();
  });

  /**
   * The failure this module exists for: the token dies between two tool calls
   * of one turn. Recovering in place is what keeps the model from having to
   * explain a rejection it has no way to account for.
   */
  describe('when the server rejects the token', () => {
    it('renews it and retries the call', async () => {
      const sent: (string | null)[] = [];
      const authorizing = createAuthorizingFetch({
        token: async (force) => (force ? 'renewed' : 'expired'),
        fetchFn: async (_url, init) => {
          const header = new Headers(init?.headers).get('Authorization');
          sent.push(header);
          return json(header === 'Bearer renewed' ? 200 : 401);
        },
      });

      const response = await authorizing('https://mcp.example.com/', {
        method: 'POST',
        body: '{"method":"tools/call"}',
      });

      expect(sent).toEqual(['Bearer expired', 'Bearer renewed']);
      expect(response.status).toBe(200);
    });

    it('replays the request body, so the retry is the same call', async () => {
      const bodies: unknown[] = [];
      const authorizing = createAuthorizingFetch({
        token: async (force) => (force ? 'renewed' : 'expired'),
        fetchFn: async (_url, init) => {
          bodies.push(init?.body);
          return json(bodies.length === 1 ? 401 : 200);
        },
      });

      await authorizing('https://mcp.example.com/', { method: 'POST', body: '{"id":7}' });
      expect(bodies).toEqual(['{"id":7}', '{"id":7}']);
    });

    it('reports the connection as unauthorized when no renewal is possible', async () => {
      const onRejected = vi.fn();
      const authorizing = createAuthorizingFetch({
        // The same token back means the renewal did not happen.
        token: async () => 'expired',
        onRejected,
        fetchFn: async () => json(401, { [CHALLENGE]: 'Bearer error="invalid_token"' }),
      });

      const response = await authorizing('https://mcp.example.com/', { body: '{}' });

      expect(response.status).toBe(401);
      expect(onRejected).toHaveBeenCalledWith(401, 'Bearer error="invalid_token"');
    });

    it('does not retry a second time when the renewed token is rejected too', async () => {
      const onRejected = vi.fn();
      const fetchFn = vi.fn(async () => json(401));
      const authorizing = createAuthorizingFetch({
        token: async (force) => (force ? 'renewed' : 'expired'),
        onRejected,
        fetchFn,
      });

      await authorizing('https://mcp.example.com/', { body: '{}' });

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(onRejected).toHaveBeenCalledTimes(1);
    });

    it('leaves a genuine permission failure alone', async () => {
      const onRejected = vi.fn();
      const fetchFn = vi.fn(async () => json(403));
      const authorizing = createAuthorizingFetch({
        token: async () => 'valid',
        onRejected,
        fetchFn,
      });

      const response = await authorizing('https://mcp.example.com/', { body: '{}' });

      // Retrying here would double every denied request, and reporting it would
      // send the user to re-authorize a connection that is working.
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(onRejected).not.toHaveBeenCalled();
      expect(response.status).toBe(403);
    });

    it('does not replay a streamed body, which the first attempt consumed', async () => {
      const fetchFn = vi.fn(async () => json(401));
      const authorizing = createAuthorizingFetch({
        token: async (force) => (force ? 'renewed' : 'expired'),
        fetchFn,
      });

      await authorizing('https://mcp.example.com/', {
        method: 'POST',
        body: new ReadableStream(),
      });

      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });
});
