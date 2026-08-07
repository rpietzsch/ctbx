import type { McpServerConfig } from '@/config/schema';

/**
 * Turns the edit form's raw fields into a server config.
 *
 * Built explicitly rather than by spreading the previous config: with
 * `{...previous, ...(value ? { field: value } : {})}` an emptied field silently
 * keeps its old value, because the conditional spread contributes nothing and
 * the old key survives. Clearing "Scopes" has to actually clear it.
 */

export interface ServerFormFields {
  name: string;
  url: string;
  clientId: string;
  scopes: string;
  autoConnect: boolean;
}

export type ServerFormResult =
  { ok: true; config: McpServerConfig } | { ok: false; field: 'name' | 'url'; message: string };

export function parseScopeList(raw: string): string[] | undefined {
  const scopes = raw.trim().split(/\s+/).filter(Boolean);
  return scopes.length === 0 ? undefined : scopes;
}

export function buildServerConfig(
  previous: McpServerConfig,
  fields: ServerFormFields
): ServerFormResult {
  const name = fields.name.trim();
  if (name === '') {
    return { ok: false, field: 'name', message: 'Give the server a name.' };
  }

  const url = fields.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, field: 'url', message: 'That is not a valid endpoint IRI.' };
  }

  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocal) {
    return {
      ok: false,
      field: 'url',
      message: 'Use an https endpoint (or localhost for development).',
    };
  }

  // Every optional field is assigned only when present, so emptying one removes
  // it rather than leaving the previous value behind.
  const config: McpServerConfig = {
    id: previous.id,
    name,
    url,
    enabled: previous.enabled,
    autoConnect: fields.autoConnect,
  };

  const clientId = fields.clientId.trim();
  if (clientId !== '') config.clientId = clientId;

  const scopes = parseScopeList(fields.scopes);
  if (scopes) config.scopes = scopes;

  return { ok: true, config };
}
