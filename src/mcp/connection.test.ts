import { describe, expect, it } from 'vitest';
import {
  challengeHeaderOf,
  describeHandshakeOnlyFailure,
  isMethodNotAllowed,
  isUnauthorized,
} from './connection';

/**
 * The case a one-shot probe cannot see: `initialize` succeeds, so an HTTP probe
 * reports "ok", but the MCP client still fails because the browser blocks the
 * headers it sends on every subsequent request. Reporting the probe's verdict
 * there produced a red box reading "Connected, but …", which is nonsense.
 */
describe('describeHandshakeOnlyFailure', () => {
  const message = describeHandshakeOnlyFailure(new Error('SSE stream closed'));

  it('does not claim the connection succeeded', () => {
    expect(message).not.toMatch(/^Connected/);
    expect(message).toMatch(/could not be established/i);
  });

  it('names the headers that fail only after the handshake', () => {
    expect(message).toContain('MCP-Protocol-Version');
    expect(message).toContain('Mcp-Session-Id');
  });

  it('explains the first-request-works symptom', () => {
    expect(message).toMatch(/first request appears to succeed/i);
  });

  it('includes the required CORS configuration', () => {
    expect(message).toContain('Access-Control-Allow-Headers');
    expect(message).toContain('Access-Control-Expose-Headers');
  });

  it('preserves the underlying transport error', () => {
    expect(message).toContain('SSE stream closed');
  });

  it('handles a non-Error rejection', () => {
    expect(describeHandshakeOnlyFailure('plain string')).toContain('plain string');
  });
});

describe('isUnauthorized', () => {
  it('recognises a 401 in the message', () => {
    expect(isUnauthorized(new Error('HTTP 401 Unauthorized'))).toBe(true);
  });

  it('recognises a status property', () => {
    expect(isUnauthorized({ status: 401 })).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isUnauthorized(new Error('connection reset'))).toBe(false);
  });
});

describe('isMethodNotAllowed', () => {
  it('recognises a 405, which means falling back to the legacy SSE transport', () => {
    expect(isMethodNotAllowed(new Error('HTTP 405 Method Not Allowed'))).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isMethodNotAllowed(new Error('HTTP 500'))).toBe(false);
  });
});

describe('challengeHeaderOf', () => {
  it('reads WWW-Authenticate off an error carrying headers', () => {
    const error = { headers: new Headers({ 'WWW-Authenticate': 'Bearer error="invalid_token"' }) };
    expect(challengeHeaderOf(error)).toContain('invalid_token');
  });

  it('reads it from a nested response', () => {
    const error = { response: { headers: new Headers({ 'WWW-Authenticate': 'Bearer' }) } };
    expect(challengeHeaderOf(error)).toBe('Bearer');
  });

  it('returns null when there is nothing to read', () => {
    expect(challengeHeaderOf(new Error('boom'))).toBeNull();
    expect(challengeHeaderOf(null)).toBeNull();
  });
});
