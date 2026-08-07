import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ProviderConfig } from '@/config/schema';
import {
  parseAnthropicModels,
  parseGoogleModels,
  parseOpenAIModels,
  parseOpenRouterModels,
} from './parse';
import { ProviderRequestError, type ModelInfo, type ProviderDefinition } from './types';

/** Attribution headers OpenRouter uses for its app leaderboards. */
export const APP_TITLE = 'ctbx';

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
  createModel(config, modelId) {
    const openrouter = createOpenRouter({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      headers: { 'HTTP-Referer': appUrl(), 'X-Title': APP_TITLE },
    });
    return openrouter.chat(modelId);
  },
  async listModels(config, signal) {
    // Unauthenticated: the picker works before a key is entered (spec §5.2).
    const base = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    return parseOpenRouterModels(await fetchJson(`${base}/models`, { signal }));
  },
};

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
