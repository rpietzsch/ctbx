/**
 * Risk categories derived from MCP tool annotations.
 *
 * A server may describe each tool with `readOnlyHint`, `destructiveHint`,
 * `idempotentHint` and `openWorldHint`. Collapsing those into one category is
 * what makes bulk approval possible — "allow every read-only tool on this
 * server" is a decision a user can actually reason about, where forty
 * individual checkboxes is not.
 *
 * The spec's defaults (`readOnlyHint` false, `destructiveHint` true) only apply
 * when the server said *something*. A server that sends no annotations at all
 * has made no claim, and labelling its tools "destructive" would present a
 * guess as a fact — so those are `unannotated`, and they are never covered by a
 * category-wide approval. The annotations are hints from the server anyway:
 * useful for grouping, never a security boundary.
 */

export type ToolCategory = 'read-only' | 'write' | 'destructive' | 'unannotated';

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Display order: safest first, so the inventory reads as a risk gradient. */
export const TOOL_CATEGORY_ORDER: readonly ToolCategory[] = [
  'read-only',
  'write',
  'destructive',
  'unannotated',
];

export const TOOL_CATEGORY_LABEL: Record<ToolCategory, string> = {
  'read-only': 'read-only',
  write: 'write',
  destructive: 'destructive',
  unannotated: 'not annotated',
};

export const TOOL_CATEGORY_DESCRIPTION: Record<ToolCategory, string> = {
  'read-only': 'The server states these do not modify anything.',
  write: 'These modify state, but the server states they are not destructive.',
  destructive: 'These may perform irreversible updates or deletions.',
  unannotated: 'The server published no annotations for these, so nothing is known about them.',
};

/** Tone for the category badge, matching the risk gradient. */
export const TOOL_CATEGORY_TONE: Record<ToolCategory, 'ok' | 'accent' | 'danger' | 'neutral'> = {
  'read-only': 'ok',
  write: 'accent',
  destructive: 'danger',
  unannotated: 'neutral',
};

function hasAnyHint(annotations: ToolAnnotations): boolean {
  return (
    annotations.readOnlyHint !== undefined ||
    annotations.destructiveHint !== undefined ||
    annotations.idempotentHint !== undefined ||
    annotations.openWorldHint !== undefined
  );
}

export function toolCategory(annotations: ToolAnnotations | undefined): ToolCategory {
  if (!annotations || !hasAnyHint(annotations)) return 'unannotated';
  if (annotations.readOnlyHint === true) return 'read-only';
  // Spec default: a tool that is not read-only is destructive unless it says
  // otherwise.
  return annotations.destructiveHint === false ? 'write' : 'destructive';
}

/** Categories that a blanket "always allow" may cover. */
export function isBulkApprovable(category: ToolCategory): boolean {
  return category !== 'unannotated';
}

/** Groups tools by category, in `TOOL_CATEGORY_ORDER`, skipping empty groups. */
export function groupByCategory<T extends { annotations?: ToolAnnotations }>(
  tools: readonly T[]
): { category: ToolCategory; tools: T[] }[] {
  const groups = new Map<ToolCategory, T[]>();
  for (const tool of tools) {
    const category = toolCategory(tool.annotations);
    const bucket = groups.get(category);
    if (bucket) bucket.push(tool);
    else groups.set(category, [tool]);
  }

  return TOOL_CATEGORY_ORDER.filter((category) => groups.has(category)).map((category) => ({
    category,
    tools: groups.get(category)!,
  }));
}
