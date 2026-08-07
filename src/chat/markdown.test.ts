import { describe, expect, it } from 'vitest';
import { formatToolResult, renderMarkdown, renderPlainText } from './markdown';

describe('renderMarkdown', () => {
  it('renders ordinary markdown', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text.');
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('renders code blocks', () => {
    expect(renderMarkdown('```\nconst x = 1;\n```')).toContain('<pre>');
  });

  it('renders tables', () => {
    const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table>');
  });
});

/**
 * These are the cases that matter: model output and MCP tool results are
 * untrusted (spec §9.3). Each one is a way a malicious tool result could try to
 * execute in the page.
 */
describe('renderMarkdown — untrusted input is never active content', () => {
  it('strips script tags', () => {
    const html = renderMarkdown('<script>alert("xss")</script>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(');
  });

  it('strips inline event handlers', () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).not.toContain('onerror');
  });

  it('strips javascript: URLs from markdown links', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('strips iframes', () => {
    expect(renderMarkdown('<iframe src="https://evil.example"></iframe>')).not.toContain('<iframe');
  });

  it('strips forms and inputs, so no credential prompt can be injected', () => {
    const html = renderMarkdown('<form><input name="password"></form>');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
  });

  it('strips style attributes and tags', () => {
    expect(renderMarkdown('<div style="position:fixed">x</div>')).not.toContain('style=');
    expect(renderMarkdown('<style>body{display:none}</style>')).not.toContain('<style');
  });

  it('strips object and embed', () => {
    expect(renderMarkdown('<object data="x"></object>')).not.toContain('<object');
    expect(renderMarkdown('<embed src="x">')).not.toContain('<embed');
  });

  it('strips data attributes', () => {
    expect(renderMarkdown('<span data-x="1">y</span>')).not.toContain('data-x');
  });

  it('keeps ordinary links intact', () => {
    expect(renderMarkdown('[docs](https://example.com)')).toContain('href="https://example.com"');
  });
});

describe('renderPlainText', () => {
  it('removes all markup', () => {
    expect(renderPlainText('<b>bold</b>')).toBe('bold');
  });

  it('neutralises a script payload entirely', () => {
    const output = renderPlainText('<script>alert(1)</script>');
    expect(output).not.toContain('<script');
  });
});

describe('formatToolResult', () => {
  it('passes strings through', () => {
    expect(formatToolResult('plain')).toBe('plain');
  });

  it('pretty-prints objects', () => {
    expect(formatToolResult({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('survives circular structures', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatToolResult(circular)).not.toThrow();
  });
});
