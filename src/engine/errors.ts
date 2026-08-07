/**
 * Maps failures onto specific, actionable messages.
 *
 * The cross-cutting rule in tasks/backlog.md is that "something went wrong" is
 * a bug: every failure mode the user can hit must name what happened and what
 * to do. Pure and exhaustively tested, because this is what the user actually
 * reads when things break.
 */

export type FailureKind =
  | 'aborted'
  | 'invalid-key'
  | 'insufficient-credit'
  | 'rate-limited'
  | 'context-overflow'
  | 'model-not-found'
  | 'no-tool-support'
  | 'network'
  | 'server-error'
  | 'unknown';

export interface DescribedFailure {
  kind: FailureKind;
  message: string;
  /** True when retrying the identical request could plausibly succeed. */
  retryable: boolean;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ['statusCode', 'status']) {
    const value = record[key];
    if (typeof value === 'number') return value;
  }
  const response = record.response as Record<string, unknown> | undefined;
  if (response && typeof response.status === 'number') return response.status;
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

export function isAbort(error: unknown): boolean {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  return /\babort/i.test(messageOf(error));
}

export function describeFailure(error: unknown): DescribedFailure {
  if (isAbort(error)) {
    return { kind: 'aborted', message: 'Generation stopped.', retryable: true };
  }

  const status = statusOf(error);
  const text = messageOf(error);

  if (status === 401 || status === 403 || /invalid[_ -]?api[_ -]?key|unauthorized/i.test(text)) {
    return {
      kind: 'invalid-key',
      message:
        'The provider rejected the API key. Check it under Providers, or replace it if it was revoked.',
      retryable: false,
    };
  }

  if (status === 402 || /insufficient[_ ](credit|funds|quota)|billing/i.test(text)) {
    return {
      kind: 'insufficient-credit',
      message: 'The provider reports insufficient credit on this account.',
      retryable: false,
    };
  }

  if (status === 429 || /rate[_ ]?limit|too many requests/i.test(text)) {
    return {
      kind: 'rate-limited',
      message: 'Rate limited by the provider. Wait a moment, then retry.',
      retryable: true,
    };
  }

  if (/context[_ ](length|window)|maximum context|too many tokens|reduce the length/i.test(text)) {
    return {
      kind: 'context-overflow',
      message:
        "This conversation exceeds the model's context window. Start a new conversation, or switch to a model with a larger context.",
      retryable: false,
    };
  }

  if (status === 404 || /model[_ ]not[_ ]found|no such model|unknown model/i.test(text)) {
    return {
      kind: 'model-not-found',
      message: 'The selected model is not available on this provider. Pick another model.',
      retryable: false,
    };
  }

  if (/does not support tool|tools are not supported|function calling/i.test(text)) {
    return {
      kind: 'no-tool-support',
      message:
        'This model cannot call tools, but MCP tools are connected. Choose a tool-capable model, or disable the MCP servers.',
      retryable: false,
    };
  }

  if (
    /failed to fetch|networkerror|network request failed|load failed|cors/i.test(text) ||
    error instanceof TypeError
  ) {
    return {
      kind: 'network',
      message:
        'Could not reach the provider. Check your connection — or, if this persists, the provider may be refusing browser requests (CORS).',
      retryable: true,
    };
  }

  if (status !== undefined && status >= 500) {
    return {
      kind: 'server-error',
      message: `The provider had a server error (HTTP ${status}). Retry shortly.`,
      retryable: true,
    };
  }

  return {
    kind: 'unknown',
    message: text === '' ? 'The request failed for an unknown reason.' : text,
    retryable: true,
  };
}
