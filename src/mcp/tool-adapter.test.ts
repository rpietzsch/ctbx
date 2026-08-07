import { describe, expect, it, vi } from 'vitest';
import {
  alwaysAllowKey,
  buildTools,
  namespaceToolName,
  needsApproval,
  normalizeToolResult,
  parseNamespacedToolName,
  serverSlug,
  uniqueSlugs,
  type AdaptableServer,
  type ApprovalGate,
} from './tool-adapter';

const approveAll: ApprovalGate = { request: async () => ({ approved: true }) };
const denyAll: ApprovalGate = { request: async () => ({ approved: false }) };

function makeServer(overrides: Partial<AdaptableServer> = {}): AdaptableServer {
  return {
    id: 'srv-1',
    name: 'Corporate Memory',
    slug: 'corporate-memory',
    tools: [{ name: 'query', description: 'Run a query', inputSchema: { type: 'object' } }],
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    ...overrides,
  };
}

describe('serverSlug', () => {
  it('slugifies a display name', () => {
    expect(serverSlug('Corporate Memory', 'id')).toBe('corporate-memory');
  });

  it('collapses runs of punctuation and trims separators', () => {
    expect(serverSlug('  My!!  Server ++ ', 'id')).toBe('my-server');
  });

  it('never produces the tool-name separator', () => {
    expect(serverSlug('a__b', 'id')).not.toContain('__');
  });

  it('falls back to the id when the name has no usable characters', () => {
    expect(serverSlug('!!!', 'srv-42')).toBe('srv42');
  });

  it('falls back to a constant when both are unusable', () => {
    expect(serverSlug('!!!', '???')).toBe('server');
  });
});

describe('tool name namespacing', () => {
  it('round-trips a simple name', () => {
    const qualified = namespaceToolName('memory', 'query');
    expect(qualified).toBe('memory__query');
    expect(parseNamespacedToolName(qualified)).toEqual({ slug: 'memory', toolName: 'query' });
  });

  it('round-trips a tool name that itself contains the separator', () => {
    const qualified = namespaceToolName('memory', 'read__file');
    expect(qualified).toBe('memory__read__file');
    expect(parseNamespacedToolName(qualified)).toEqual({ slug: 'memory', toolName: 'read__file' });
  });

  it('round-trips a tool name containing single underscores', () => {
    const qualified = namespaceToolName('cmem', 'workflow_execute');
    expect(parseNamespacedToolName(qualified)).toEqual({
      slug: 'cmem',
      toolName: 'workflow_execute',
    });
  });

  it('rejects malformed qualified names', () => {
    expect(parseNamespacedToolName('noseparator')).toBeUndefined();
    expect(parseNamespacedToolName('__leading')).toBeUndefined();
    expect(parseNamespacedToolName('trailing__')).toBeUndefined();
  });

  it('produces provider-safe characters only', () => {
    expect(namespaceToolName(serverSlug('Corporate Memory', 'x'), 'query_all')).toMatch(
      /^[a-zA-Z0-9_-]+$/
    );
  });
});

describe('uniqueSlugs', () => {
  it('disambiguates servers sharing a display name', () => {
    const slugs = uniqueSlugs([
      { id: 'a', name: 'Memory' },
      { id: 'b', name: 'Memory' },
      { id: 'c', name: 'Memory' },
    ]);
    expect([...slugs.values()]).toEqual(['memory', 'memory-2', 'memory-3']);
  });

  it('leaves distinct names alone', () => {
    const slugs = uniqueSlugs([
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ]);
    expect([...slugs.values()]).toEqual(['alpha', 'beta']);
  });
});

describe('needsApproval', () => {
  it('asks by default', () => {
    expect(needsApproval('always', [], 'srv', 'query')).toBe(true);
  });

  it('does not ask for a tool the user marked always-allow', () => {
    expect(needsApproval('always', [alwaysAllowKey('srv', 'query')], 'srv', 'query')).toBe(false);
  });

  it('scopes always-allow to a single server', () => {
    expect(needsApproval('always', [alwaysAllowKey('other', 'query')], 'srv', 'query')).toBe(true);
  });

  it('skips only under the explicit never mode', () => {
    expect(needsApproval('never', [], 'srv', 'query')).toBe(false);
  });
});

describe('normalizeToolResult', () => {
  it('joins text-only content into a string', () => {
    expect(
      normalizeToolResult({
        content: [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ],
      })
    ).toBe('line one\nline two');
  });

  it('prefers structuredContent when present', () => {
    expect(
      normalizeToolResult({ content: [{ type: 'text', text: 'x' }], structuredContent: { a: 1 } })
    ).toEqual({ a: 1 });
  });

  it('passes mixed content through structurally', () => {
    const content = [
      { type: 'text', text: 'x' },
      { type: 'image', data: '…' },
    ];
    expect(normalizeToolResult({ content })).toBe(content);
  });

  it('handles an absent content field', () => {
    expect(normalizeToolResult({})).toBe('');
  });
});

describe('buildTools', () => {
  const options = { approvalMode: 'always' as const, alwaysAllowed: [], gate: approveAll };

  it('namespaces every tool', () => {
    const tools = buildTools([makeServer()], options);
    expect(Object.keys(tools)).toEqual(['corporate-memory__query']);
  });

  it('keeps tools from different servers apart even when names collide', () => {
    const tools = buildTools(
      [makeServer({ id: 'a', slug: 'alpha' }), makeServer({ id: 'b', slug: 'beta', name: 'Beta' })],
      options
    );
    expect(Object.keys(tools).sort()).toEqual(['alpha__query', 'beta__query']);
  });

  it('calls the MCP server and returns normalized output when approved', async () => {
    const server = makeServer();
    const tools = buildTools([server], options);

    const result = await tools['corporate-memory__query']!.execute!({ q: 1 }, {} as never);

    expect(server.callTool).toHaveBeenCalledWith('query', { q: 1 }, undefined);
    expect(result).toBe('ok');
  });

  it('does not call the server when the user denies', async () => {
    const server = makeServer();
    const tools = buildTools([server], { ...options, gate: denyAll });

    const result = await tools['corporate-memory__query']!.execute!({}, {} as never);

    expect(server.callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: 'call-denied' });
  });

  it('asks for approval before every call by default', async () => {
    const gate = { request: vi.fn(async () => ({ approved: true as const })) };
    const tools = buildTools([makeServer()], { ...options, gate });

    await tools['corporate-memory__query']!.execute!({ a: 1 }, {} as never);

    expect(gate.request).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'srv-1',
        serverName: 'Corporate Memory',
        toolName: 'query',
        qualifiedName: 'corporate-memory__query',
        args: { a: 1 },
      })
    );
  });

  it('skips the gate for an always-allowed tool', async () => {
    const gate = { request: vi.fn(async () => ({ approved: true as const })) };
    const tools = buildTools([makeServer()], {
      ...options,
      alwaysAllowed: [alwaysAllowKey('srv-1', 'query')],
      gate,
    });

    await tools['corporate-memory__query']!.execute!({}, {} as never);

    expect(gate.request).not.toHaveBeenCalled();
  });

  it('records an always-allow decision', async () => {
    const onAlwaysAllow = vi.fn();
    const tools = buildTools([makeServer()], {
      ...options,
      gate: { request: async () => ({ approved: true, remember: true }) },
      onAlwaysAllow,
    });

    await tools['corporate-memory__query']!.execute!({}, {} as never);

    expect(onAlwaysAllow).toHaveBeenCalledWith('srv-1', 'query');
  });

  it('reports a tool error as a result rather than throwing', async () => {
    const server = makeServer({
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true })),
    });
    const tools = buildTools([server], options);

    await expect(tools['corporate-memory__query']!.execute!({}, {} as never)).resolves.toEqual({
      error: 'tool-error',
      message: 'boom',
    });
  });

  it('defaults the input schema when a server omits it', () => {
    const tools = buildTools([makeServer({ tools: [{ name: 'ping' }] })], options);
    expect(tools['corporate-memory__ping']).toBeDefined();
  });
});
