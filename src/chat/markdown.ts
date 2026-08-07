import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Markdown rendering with mandatory sanitization.
 *
 * Model output and — more importantly — MCP tool results are untrusted input
 * (spec §9.2, §9.3). A tool result is attacker-controlled in the general case,
 * so anything rendered here must never become active content. Scripts, event
 * handlers, iframes, forms and javascript: URLs are all removed.
 */

marked.setOptions({ gfm: true, breaks: true });

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr',
  'span',
];

const ALLOWED_ATTR = ['href', 'title', 'lang', 'class'];

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false }) as string;

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Defence in depth: even if a tag slipped through the allow-list.
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'style'],
    ALLOW_DATA_ATTR: false,
  });
}

/** Renders untrusted text with no markdown interpretation at all. */
export function renderPlainText(source: string): string {
  return DOMPurify.sanitize(source, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}

/** Formats a tool result for display without ever treating it as markup. */
export function formatToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
