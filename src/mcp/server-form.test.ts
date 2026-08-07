import { describe, expect, it } from 'vitest';
import { buildServerConfig, parseScopeList, type ServerFormFields } from './server-form';
import type { McpServerConfig } from '@/config/schema';

const PREVIOUS: McpServerConfig = {
  id: 'srv-1',
  name: 'Old name',
  url: 'https://old.example.com/mcp',
  clientId: 'old-client',
  scopes: ['openid', 'profile'],
  enabled: true,
  autoConnect: false,
};

function fields(overrides: Partial<ServerFormFields> = {}): ServerFormFields {
  return {
    name: 'Corporate Memory',
    url: 'https://mcp.example.com/mcp',
    clientId: 'cmem',
    scopes: 'openid',
    autoConnect: true,
    ...overrides,
  };
}

function config(overrides: Partial<ServerFormFields> = {}) {
  const result = buildServerConfig(PREVIOUS, fields(overrides));
  if (!result.ok) throw new Error(`expected success, got: ${result.message}`);
  return result.config;
}

describe('parseScopeList', () => {
  it('splits on whitespace', () => {
    expect(parseScopeList('openid profile')).toEqual(['openid', 'profile']);
  });

  it('collapses runs of whitespace', () => {
    expect(parseScopeList('  openid   profile  ')).toEqual(['openid', 'profile']);
  });

  it('returns undefined for empty input', () => {
    expect(parseScopeList('')).toBeUndefined();
    expect(parseScopeList('   ')).toBeUndefined();
  });
});

describe('buildServerConfig', () => {
  it('keeps the id from the previous config', () => {
    expect(config().id).toBe('srv-1');
  });

  it('applies the edited fields', () => {
    expect(config()).toMatchObject({
      name: 'Corporate Memory',
      url: 'https://mcp.example.com/mcp',
      clientId: 'cmem',
      scopes: ['openid'],
      autoConnect: true,
    });
  });

  /** The reported bug: an emptied field kept its previous value. */
  it('removes the scopes when the field is cleared', () => {
    const result = config({ scopes: '' });
    expect(result.scopes).toBeUndefined();
    expect('scopes' in result).toBe(false);
  });

  it('removes the scopes when the field is only whitespace', () => {
    expect('scopes' in config({ scopes: '   ' })).toBe(false);
  });

  it('removes the client ID when the field is cleared', () => {
    expect('clientId' in config({ clientId: '' })).toBe(false);
  });

  it('never carries an unrelated stale value forward', () => {
    const result = config({ scopes: '', clientId: '' });
    expect(result).toEqual({
      id: 'srv-1',
      name: 'Corporate Memory',
      url: 'https://mcp.example.com/mcp',
      enabled: true,
      autoConnect: true,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(config({ name: '  Spaced  ', clientId: '  cid  ' })).toMatchObject({
      name: 'Spaced',
      clientId: 'cid',
    });
  });

  it('can turn auto-connect off', () => {
    expect(config({ autoConnect: false }).autoConnect).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(buildServerConfig(PREVIOUS, fields({ name: '  ' }))).toMatchObject({
      ok: false,
      field: 'name',
    });
  });

  it('rejects a malformed URL', () => {
    expect(buildServerConfig(PREVIOUS, fields({ url: 'not-a-url' }))).toMatchObject({
      ok: false,
      field: 'url',
    });
  });

  it('rejects plain http for a remote host', () => {
    expect(
      buildServerConfig(PREVIOUS, fields({ url: 'http://mcp.example.com/mcp' }))
    ).toMatchObject({ ok: false, field: 'url' });
  });

  it('allows http on localhost for development', () => {
    expect(config({ url: 'http://localhost:3000/mcp' }).url).toBe('http://localhost:3000/mcp');
    expect(config({ url: 'http://127.0.0.1:3000/mcp' }).url).toBe('http://127.0.0.1:3000/mcp');
  });
});
