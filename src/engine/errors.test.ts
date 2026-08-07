import { describe, expect, it } from 'vitest';
import { describeFailure, isAbort } from './errors';

function withStatus(status: number, message = ''): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

describe('isAbort', () => {
  it('recognises AbortError', () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    expect(isAbort(error)).toBe(true);
  });

  it('recognises a timeout', () => {
    const error = new Error('timed out');
    error.name = 'TimeoutError';
    expect(isAbort(error)).toBe(true);
  });

  it('does not treat an unrelated error as an abort', () => {
    expect(isAbort(new Error('rate limited'))).toBe(false);
  });
});

describe('describeFailure', () => {
  it('reports a stop as a non-error', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    expect(describeFailure(error)).toMatchObject({ kind: 'aborted' });
  });

  it('distinguishes an invalid key from other 4xx', () => {
    expect(describeFailure(withStatus(401)).kind).toBe('invalid-key');
    expect(describeFailure(withStatus(403)).kind).toBe('invalid-key');
    expect(describeFailure(new Error('Invalid API key provided')).kind).toBe('invalid-key');
  });

  it('marks an invalid key as not retryable', () => {
    expect(describeFailure(withStatus(401)).retryable).toBe(false);
  });

  it('detects insufficient credit', () => {
    expect(describeFailure(withStatus(402)).kind).toBe('insufficient-credit');
    expect(describeFailure(new Error('insufficient_quota')).kind).toBe('insufficient-credit');
  });

  it('detects rate limiting and marks it retryable', () => {
    expect(describeFailure(withStatus(429))).toMatchObject({
      kind: 'rate-limited',
      retryable: true,
    });
    expect(describeFailure(new Error('Too Many Requests')).kind).toBe('rate-limited');
  });

  it('detects context overflow and suggests a fix', () => {
    const result = describeFailure(new Error("This model's maximum context length is 8192 tokens"));
    expect(result.kind).toBe('context-overflow');
    expect(result.message).toMatch(/new conversation|larger context/i);
  });

  it('detects an unavailable model', () => {
    expect(describeFailure(withStatus(404)).kind).toBe('model-not-found');
    expect(describeFailure(new Error('The model `x` does not exist')).kind).toBe('unknown');
  });

  it('detects a model that cannot call tools', () => {
    expect(describeFailure(new Error('This model does not support tool use')).kind).toBe(
      'no-tool-support'
    );
  });

  it('detects network and CORS failures', () => {
    expect(describeFailure(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(describeFailure(new Error('NetworkError when attempting to fetch')).kind).toBe(
      'network'
    );
  });

  it('mentions CORS in the network message, since a browser cannot tell them apart', () => {
    expect(describeFailure(new TypeError('Failed to fetch')).message).toMatch(/CORS/);
  });

  it('reports server errors with the status and marks them retryable', () => {
    expect(describeFailure(withStatus(503))).toMatchObject({
      kind: 'server-error',
      retryable: true,
    });
    expect(describeFailure(withStatus(503)).message).toContain('503');
  });

  it('reads a status from a nested response object', () => {
    expect(describeFailure({ response: { status: 429 } }).kind).toBe('rate-limited');
  });

  it('falls back to the original message rather than a generic one', () => {
    expect(describeFailure(new Error('something specific happened')).message).toBe(
      'something specific happened'
    );
  });

  it('handles a completely opaque failure', () => {
    expect(describeFailure({})).toMatchObject({ kind: 'unknown' });
    expect(describeFailure({}).message).not.toBe('');
  });

  it('never returns an empty message', () => {
    for (const error of [null, undefined, {}, '', new Error(), 42]) {
      expect(describeFailure(error).message.length).toBeGreaterThan(0);
    }
  });
});
