import { jsonSchema, tool, type Tool, type ToolSet } from 'ai';
import type { ToolApprovalMode } from '@/config/schema';
import {
  isBulkApprovable,
  toolCategory,
  type ToolAnnotations,
  type ToolCategory,
} from './tool-categories';

/**
 * Adapts MCP tools into AI SDK tools (spec §6.3) and enforces the approval
 * boundary (spec §6.4, §9.3).
 *
 * Approval is gated *inside* `execute` rather than through the AI SDK's
 * `needsApproval` option. The SDK's approval flow is built around a
 * client/server round trip where the loop halts and is resumed with approval
 * responses appended to the message list. This app owns the loop in the
 * browser, so awaiting the user's decision before touching the network is both
 * simpler and a stricter guarantee: no MCP call is issued until the user says
 * yes, and there is no serialized approval state that could be replayed.
 */

/** The separator between a server slug and a tool name. */
export const NAMESPACE_SEPARATOR = '__';

/**
 * Providers constrain tool names to roughly `[a-zA-Z0-9_-]`. Slugs are derived
 * from the user-visible server name, so they must be sanitized, and they must
 * not contain the separator or the round trip becomes ambiguous.
 */
export function serverSlug(name: string, fallbackId: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug === '' ? sanitizeFallback(fallbackId) : slug;
}

function sanitizeFallback(id: string): string {
  const cleaned = id.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return cleaned === '' ? 'server' : cleaned;
}

export function namespaceToolName(slug: string, toolName: string): string {
  return `${slug}${NAMESPACE_SEPARATOR}${toolName}`;
}

/**
 * Splits on the *first* separator only: server slugs never contain `__`, but
 * MCP tool names frequently do (`read__file`), so splitting greedily would
 * corrupt the name on the way back.
 */
export function parseNamespacedToolName(
  qualified: string
): { slug: string; toolName: string } | undefined {
  const index = qualified.indexOf(NAMESPACE_SEPARATOR);
  if (index <= 0) return undefined;
  const slug = qualified.slice(0, index);
  const toolName = qualified.slice(index + NAMESPACE_SEPARATOR.length);
  if (toolName === '') return undefined;
  return { slug, toolName };
}

/** Ensures slugs are unique across servers with the same display name. */
export function uniqueSlugs(servers: { id: string; name: string }[]): Map<string, string> {
  const used = new Set<string>();
  const bySeverId = new Map<string, string>();
  for (const server of servers) {
    const base = serverSlug(server.name, server.id);
    let candidate = base;
    let counter = 2;
    while (used.has(candidate)) candidate = `${base}-${counter++}`;
    used.add(candidate);
    bySeverId.set(server.id, candidate);
  }
  return bySeverId;
}

// ------------------------------------------------------------------- approval

export interface PendingToolCall {
  serverId: string;
  serverName: string;
  toolName: string;
  qualifiedName: string;
  args: unknown;
}

export type ApprovalDecision =
  { approved: true; remember?: boolean } | { approved: false; reason?: string };

export interface ApprovalGate {
  request(call: PendingToolCall): Promise<ApprovalDecision>;
}

export function alwaysAllowKey(serverId: string, toolName: string): string {
  return `${serverId}:${toolName}`;
}

/** Key for a whole risk category on one server, e.g. every read-only tool. */
export function alwaysAllowCategoryKey(serverId: string, category: ToolCategory): string {
  return `${serverId}:${category}`;
}

export interface ApprovalPolicy {
  mode: ToolApprovalMode;
  /** `serverId:toolName` entries. */
  alwaysAllowedTools: readonly string[];
  /** `serverId:category` entries. */
  alwaysAllowedCategories: readonly string[];
}

/**
 * Decides whether the user must be asked. `always` is the default; `never` is
 * an explicit, per-user opt-out and is the only path that skips the prompt
 * wholesale.
 *
 * A category-wide approval is honoured only for a category the server actually
 * annotated: `unannotated` tools are excluded, so "allow all read-only tools"
 * can never silently cover a tool whose behaviour the server never described.
 */
export function needsApproval(
  policy: ApprovalPolicy,
  serverId: string,
  tool: { name: string; annotations?: ToolAnnotations }
): boolean {
  if (policy.mode === 'never') return false;
  if (policy.alwaysAllowedTools.includes(alwaysAllowKey(serverId, tool.name))) return false;

  const category = toolCategory(tool.annotations);
  if (!isBulkApprovable(category)) return true;
  return !policy.alwaysAllowedCategories.includes(alwaysAllowCategoryKey(serverId, category));
}

// --------------------------------------------------------------- result shape

export interface McpToolResult {
  content?: unknown;
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * Flattens an MCP tool result into something a model can read. Text-only
 * results — the overwhelming majority — become a plain string; anything richer
 * is passed through structurally.
 */
export function normalizeToolResult(result: McpToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;

  const content = result.content;
  if (!Array.isArray(content)) return content ?? '';

  const parts = content as { type?: string; text?: string }[];
  if (parts.length > 0 && parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text ?? '').join('\n');
  }
  return content;
}

export class ToolDeniedError extends Error {
  constructor(readonly qualifiedName: string) {
    super(`The user declined the call to ${qualifiedName}.`);
    this.name = 'ToolDeniedError';
  }
}

// ------------------------------------------------------------------- adapter

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** The server's own risk hints, used for grouping and bulk approval. */
  annotations?: ToolAnnotations;
}

export interface AdaptableServer {
  id: string;
  name: string;
  slug: string;
  tools: McpToolDescriptor[];
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult>;
}

export interface BuildToolsOptions extends ApprovalPolicy {
  gate: ApprovalGate;
  onAlwaysAllow?: (serverId: string, toolName: string) => void;
}

export function buildTools(servers: AdaptableServer[], options: BuildToolsOptions): ToolSet {
  const tools: ToolSet = {};

  for (const server of servers) {
    for (const descriptor of server.tools) {
      const qualifiedName = namespaceToolName(server.slug, descriptor.name);

      tools[qualifiedName] = tool({
        description: descriptor.description ?? `${descriptor.name} (via ${server.name})`,
        // MCP already speaks JSON Schema; pass it through untouched rather than
        // round-tripping through zod and risking a lossy conversion.
        inputSchema: jsonSchema((descriptor.inputSchema ?? { type: 'object' }) as never),
        async execute(args: unknown, { abortSignal }: { abortSignal?: AbortSignal }) {
          if (needsApproval(options, server.id, descriptor)) {
            const decision = await options.gate.request({
              serverId: server.id,
              serverName: server.name,
              toolName: descriptor.name,
              qualifiedName,
              args,
            });

            if (!decision.approved) {
              // Surfaced to the model as a result, not an exception, so it can
              // adapt instead of the whole turn failing.
              return {
                error: 'call-denied',
                message: decision.reason ?? `The user declined the call to ${descriptor.name}.`,
              };
            }
            if (decision.remember) options.onAlwaysAllow?.(server.id, descriptor.name);
          }

          const result = await server.callTool(descriptor.name, args, abortSignal);
          const normalized = normalizeToolResult(result);
          return result.isError ? { error: 'tool-error', message: normalized } : normalized;
        },
      }) as Tool;
    }
  }

  return tools;
}
