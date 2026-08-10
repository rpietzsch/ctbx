import { describe, expect, it } from 'vitest';
import {
  groupByCategory,
  isBulkApprovable,
  TOOL_CATEGORY_ORDER,
  toolCategory,
  type ToolAnnotations,
} from './tool-categories';

describe('toolCategory', () => {
  it('reads a read-only hint', () => {
    expect(toolCategory({ readOnlyHint: true })).toBe('read-only');
  });

  it('treats a non-destructive writer as write', () => {
    expect(toolCategory({ readOnlyHint: false, destructiveHint: false })).toBe('write');
  });

  /** Spec default: not read-only means destructive unless stated otherwise. */
  it('applies the destructive default once the server annotated anything', () => {
    expect(toolCategory({ readOnlyHint: false })).toBe('destructive');
    expect(toolCategory({ idempotentHint: true })).toBe('destructive');
  });

  it('honours an explicit destructive hint', () => {
    expect(toolCategory({ destructiveHint: true })).toBe('destructive');
  });

  /**
   * The distinction that keeps the label honest: silence is not a claim, and
   * calling an undescribed tool "destructive" would present a guess as fact.
   */
  it('does not guess for a server that annotated nothing', () => {
    expect(toolCategory(undefined)).toBe('unannotated');
    expect(toolCategory({})).toBe('unannotated');
    expect(toolCategory({ title: 'Query' })).toBe('unannotated');
  });

  it('lets read-only win over a stray destructive hint', () => {
    expect(toolCategory({ readOnlyHint: true, destructiveHint: true })).toBe('read-only');
  });
});

describe('isBulkApprovable', () => {
  it('excludes only the unannotated group', () => {
    expect(isBulkApprovable('read-only')).toBe(true);
    expect(isBulkApprovable('destructive')).toBe(true);
    expect(isBulkApprovable('unannotated')).toBe(false);
  });
});

describe('groupByCategory', () => {
  const tools = [
    { name: 'drop', annotations: { destructiveHint: true } as ToolAnnotations },
    { name: 'query', annotations: { readOnlyHint: true } as ToolAnnotations },
    { name: 'mystery' },
    { name: 'append', annotations: { destructiveHint: false } as ToolAnnotations },
    { name: 'list', annotations: { readOnlyHint: true } as ToolAnnotations },
  ];

  it('orders groups safest first', () => {
    expect(groupByCategory(tools).map((group) => group.category)).toEqual([
      'read-only',
      'write',
      'destructive',
      'unannotated',
    ]);
  });

  it('keeps every tool, once', () => {
    const grouped = groupByCategory(tools).flatMap((group) => group.tools.map((t) => t.name));
    expect(grouped.sort()).toEqual(['append', 'drop', 'list', 'mystery', 'query']);
  });

  it('omits groups with no tools', () => {
    expect(groupByCategory([{ name: 'query', annotations: { readOnlyHint: true } }])).toHaveLength(
      1
    );
  });

  it('is empty for no tools', () => {
    expect(groupByCategory([])).toEqual([]);
  });

  it('preserves the server order within a group', () => {
    const group = groupByCategory(tools).find((g) => g.category === 'read-only');
    expect(group?.tools.map((t) => t.name)).toEqual(['query', 'list']);
  });
});

describe('TOOL_CATEGORY_ORDER', () => {
  it('covers every category exactly once', () => {
    expect(new Set(TOOL_CATEGORY_ORDER).size).toBe(TOOL_CATEGORY_ORDER.length);
    expect(TOOL_CATEGORY_ORDER).toHaveLength(4);
  });
});
