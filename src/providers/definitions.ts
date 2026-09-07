import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ProviderConfig } from '@/config/schema';
import {
  parseAnthropicModels,
  parseGoogleModels,
  parseOpenAIModels,
  parseOpenRouterEndpointStats,
  parseOpenRouterEndpoints,
  parseOpenRouterModels,
  type EndpointStats,
} from './parse';
import {
  ProviderRequestError,
  type ModelEndpoint,
  type ModelInfo,
  type ProviderDefinition,
} from './types';

/** Attribution headers OpenRouter uses for its app leaderboards. */
export const APP_TITLE = 'ctbx';

/**
 * Endpoint listing always goes to OpenRouter itself, never to `baseUrl`: a
 * gateway override points at an OpenAI-compatible proxy, which has no notion
 * of OpenRouter's provider endpoints.
 */
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

/** Undocumented, but unauthenticated and CORS-open. See `fetchEndpointStats`. */
const OPENROUTER_STATS_URL = 'https://openrouter.ai/api/frontend/v1/stats/endpoint';

function appUrl(): string {
  if (typeof globalThis.location === 'undefined') return 'https://rpietzsch.github.io/ctbx/';
  return `${globalThis.location.origin}${globalThis.location.pathname}`;
}

async function fetchJson(
  url: string,
  init: RequestInit & { signal?: AbortSignal | undefined }
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    // A browser cannot distinguish DNS failure, offline, and CORS rejection —
    // fetch rejects identically. Say so rather than inventing a cause.
    throw new ProviderRequestError(
      'Could not reach the provider. This is a network failure, or the provider refused the request from a browser (CORS).',
      undefined
    );
  }

  if (!response.ok) {
    throw new ProviderRequestError(describeHttpError(response.status), response.status);
  }

  try {
    return await response.json();
  } catch {
    throw new ProviderRequestError('The provider returned a response that was not valid JSON.');
  }
}

/** Distinct message per failure mode — see the cross-cutting rule in the backlog. */
export function describeHttpError(status: number): string {
  if (status === 401 || status === 403) return 'The API key was rejected. Check or replace it.';
  if (status === 402) return 'The provider reports insufficient credit for this account.';
  if (status === 404) return 'The requested endpoint or model does not exist.';
  if (status === 429) return 'Rate limited by the provider. Wait a moment and retry.';
  if (status >= 500) return `The provider had a server error (HTTP ${status}). Retry shortly.`;
  return `The provider rejected the request (HTTP ${status}).`;
}

export const openrouterDefinition: ProviderDefinition = {
  id: 'openrouter',
  label: 'OpenRouter',
  keyUrl: 'https://openrouter.ai/keys',
  keyHint: 'sk-or-v1-…',
  keyPattern: /^sk-or-/,
  defaultModelId: 'anthropic/claude-sonnet-4',
  fallbackModels: [
    { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', supportsTools: true },
    { id: 'openai/gpt-4o', label: 'GPT-4o', supportsTools: true },
  ],
  createModel(config, modelId, routing) {
    const openrouter = createOpenRouter({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      headers: { 'HTTP-Referer': appUrl(), 'X-Title': APP_TITLE },
    });
    /*
      Pinning one endpoint is the only way an OpenRouter price is knowable in
      advance: without it the router picks among providers whose prices differ
      by up to 9x for the same model, and the number shown in the picker is
      only the default route's. `allow_fallbacks: false` is what makes the pin
      binding — left at its default the router silently uses another provider,
      at another price, whenever the pinned one is busy.
    */
    return openrouter.chat(modelId, {
      /*
        Ask for usage accounting. OpenRouter then reports what the generation
        actually cost and which provider served it, which is the only reliable
        way to price a turn: the model list publishes the default route's rate,
        and the endpoint that answers may charge several times that.
      */
      usage: { include: true },
      ...(routing?.endpointTag
        ? { provider: { order: [routing.endpointTag], allow_fallbacks: false } }
        : {}),
    });
  },
  async listModels(config, signal) {
    // Unauthenticated: the picker works before a key is entered (spec §5.2).
    const base = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    return parseOpenRouterModels(await fetchJson(`${base}/models`, { signal }));
  },
  async listEndpoints(modelId, options): Promise<ModelEndpoint[]> {
    const signal = options?.signal;
    // Same unauthenticated host as the model list, and CORS-open likewise.
    const [endpoints, stats] = await Promise.all([
      fetchJson(`${OPENROUTER_API_BASE}/models/${modelId}/endpoints`, { signal }).then(
        parseOpenRouterEndpoints
      ),
      fetchEndpointStats(options?.canonicalSlug, signal),
    ]);

    return endpoints.map((endpoint) => ({ ...endpoint, ...stats.get(endpoint.tag) }));
  },
};

/**
 * Speed figures for one model's endpoints, or nothing.
 *
 * Every failure here is swallowed on purpose. This reads the API OpenRouter's
 * own model pages use rather than its documented one — the documented list
 * declares `throughput_last_30m` and returns null for it on every endpoint —
 * so it can change shape or disappear without notice. When it does, the
 * endpoint picker loses a column and keeps working; it must never lose the
 * endpoints themselves.
 *
 * The lookup is keyed by the versioned slug: passing the plain model id
 * returns HTTP 200 with an empty list, which is why an absent `canonicalSlug`
 * skips the request rather than making a useless one.
 */
async function fetchEndpointStats(
  canonicalSlug: string | undefined,
  signal: AbortSignal | undefined
): Promise<Map<string, EndpointStats>> {
  if (canonicalSlug === undefined || canonicalSlug === '') return new Map();
  try {
    const url = `${OPENROUTER_STATS_URL}?permaslug=${encodeURIComponent(canonicalSlug)}`;
    return parseOpenRouterEndpointStats(await fetchJson(url, { signal }));
  } catch {
    return new Map();
  }
}

export const openaiDefinition: ProviderDefinition = {
  id: 'openai',
  label: 'OpenAI',
  keyUrl: 'https://platform.openai.com/api-keys',
  keyHint: 'sk-…',
  keyPattern: /^sk-/,
  defaultModelId: 'gpt-4o',
  fallbackModels: [
    { id: 'gpt-4o', label: 'gpt-4o', supportsTools: true },
    { id: 'gpt-4o-mini', label: 'gpt-4o-mini', supportsTools: true },
  ],
  createModel(config, modelId) {
    const openai = createOpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    return openai.chat(modelId);
  },
  async listModels(config, signal) {
    const base = config.baseUrl ?? 'https://api.openai.com/v1';
    const payload = await fetchJson(`${base}/models`, {
      signal,
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    return parseOpenAIModels(payload);
  },
};

/**
 * Anthropic requires an explicit opt-in header to be called from a browser.
 * The header name is itself the warning; `browserNote` repeats it at the point
 * of key entry rather than burying it (spec §5.2, risk R5).
 */
export const ANTHROPIC_BROWSER_HEADER = 'anthropic-dangerous-direct-browser-access';

export const anthropicDefinition: ProviderDefinition = {
  id: 'anthropic',
  label: 'Anthropic',
  keyUrl: 'https://console.anthropic.com/settings/keys',
  keyHint: 'sk-ant-…',
  keyPattern: /^sk-ant-/,
  browserNote:
    'Calling Anthropic directly from a browser requires the "dangerous-direct-browser-access" opt-in. Your key is sent from this page and is readable by any script running on it. OpenRouter avoids this.',
  defaultModelId: 'claude-sonnet-4-20250514',
  fallbackModels: [
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', supportsTools: true },
    { id: 'claude-opus-4-20250514', label: 'Claude Opus 4', supportsTools: true },
  ],
  createModel(config, modelId) {
    const anthropic = createAnthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      headers: { [ANTHROPIC_BROWSER_HEADER]: 'true' },
    });
    return anthropic(modelId);
  },
  async listModels(config, signal) {
    const base = config.baseUrl ?? 'https://api.anthropic.com/v1';
    const payload = await fetchJson(`${base}/models?limit=100`, {
      signal,
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        [ANTHROPIC_BROWSER_HEADER]: 'true',
      },
    });
    return parseAnthropicModels(payload);
  },
};

export const googleDefinition: ProviderDefinition = {
  id: 'google',
  label: 'Google',
  keyUrl: 'https://aistudio.google.com/apikey',
  keyHint: 'AIza…',
  defaultModelId: 'gemini-2.0-flash',
  fallbackModels: [{ id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', supportsTools: true }],
  createModel(config, modelId) {
    const google = createGoogleGenerativeAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    return google(modelId);
  },
  async listModels(config, signal) {
    const base = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    // Google takes the key as a query parameter; it is never logged or stored
    // in history because this URL is only ever passed to fetch.
    const url = `${base}/models?pageSize=200&key=${encodeURIComponent(config.apiKey)}`;
    return parseGoogleModels(await fetchJson(url, { signal }));
  },
};

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  openrouterDefinition,
  openaiDefinition,
  anthropicDefinition,
  googleDefinition,
];

export type { ModelInfo, ProviderConfig };
