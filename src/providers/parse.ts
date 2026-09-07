/**
 * Pure parsers for provider model-list responses.
 *
 * Kept separate from the fetch calls so every shape quirk is unit-testable
 * without a network or an API key (spec §12, and the "no keys in tests" rule).
 * All of them are defensive: a provider adding or renaming a field must not
 * empty the model picker.
 */
import type { ModelEndpoint, ModelInfo } from './types';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * OpenRouter `GET /api/v1/models`. Unauthenticated, and the only provider that
 * reports context window, pricing and tool support uniformly — which is why it
 * is the recommended default (spec §5.2).
 */
export function parseOpenRouterModels(payload: unknown): ModelInfo[] {
  const root = asRecord(payload);
  return asArray(root?.data)
    .map((entry): ModelInfo | undefined => {
      const model = asRecord(entry);
      const id = model?.id;
      if (typeof id !== 'string' || id === '') return undefined;

      const pricing = asRecord(model?.pricing);
      const promptPrice = toNumber(pricing?.prompt);
      const completionPrice = toNumber(pricing?.completion);
      const supported = asArray(model?.supported_parameters).filter(
        (p): p is string => typeof p === 'string'
      );

      const canonicalSlug = model?.canonical_slug;

      return {
        id,
        label: typeof model?.name === 'string' ? model.name : id,
        ...(typeof canonicalSlug === 'string' && canonicalSlug !== '' ? { canonicalSlug } : {}),
        contextWindow: toNumber(model?.context_length),
        pricing:
          promptPrice === undefined && completionPrice === undefined
            ? undefined
            : { prompt: promptPrice, completion: completionPrice },
        supportsTools: supported.includes('tools') || supported.includes('tool_choice'),
      };
    })
    .filter((m): m is ModelInfo => m !== undefined);
}

/** Model families that are not chat models and should never reach the picker. */
const OPENAI_NON_CHAT = /(^|-)(embedding|whisper|tts|dall-e|moderation|audio|realtime|image)/i;

/**
 * OpenAI `GET /v1/models` reports only ids, so tool support is inferred from
 * the model family. Conservative by design: unknown families are treated as
 * not tool-capable rather than promising a capability that may not exist.
 */
export function parseOpenAIModels(payload: unknown): ModelInfo[] {
  const root = asRecord(payload);
  return asArray(root?.data)
    .map((entry): ModelInfo | undefined => {
      const model = asRecord(entry);
      const id = model?.id;
      if (typeof id !== 'string' || id === '') return undefined;
      if (OPENAI_NON_CHAT.test(id)) return undefined;
      return { id, label: id, supportsTools: openAiSupportsTools(id) };
    })
    .filter((m): m is ModelInfo => m !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function openAiSupportsTools(id: string): boolean {
  return /^(gpt-4|gpt-5|gpt-6|o[1-9]|chatgpt-4)/i.test(id);
}

/** Anthropic `GET /v1/models`. Every listed Claude model supports tools. */
export function parseAnthropicModels(payload: unknown): ModelInfo[] {
  const root = asRecord(payload);
  return asArray(root?.data)
    .map((entry): ModelInfo | undefined => {
      const model = asRecord(entry);
      const id = model?.id;
      if (typeof id !== 'string' || id === '') return undefined;
      return {
        id,
        label: typeof model?.display_name === 'string' ? model.display_name : id,
        supportsTools: true,
      };
    })
    .filter((m): m is ModelInfo => m !== undefined);
}

/**
 * Google `GET /v1beta/models`. Names arrive prefixed (`models/gemini-…`); the
 * prefix is stripped because that is what the AI SDK expects as a model id.
 */
export function parseGoogleModels(payload: unknown): ModelInfo[] {
  const root = asRecord(payload);
  return asArray(root?.models)
    .map((entry): ModelInfo | undefined => {
      const model = asRecord(entry);
      const name = model?.name;
      if (typeof name !== 'string' || name === '') return undefined;

      const methods = asArray(model?.supportedGenerationMethods).filter(
        (m): m is string => typeof m === 'string'
      );
      if (methods.length > 0 && !methods.includes('generateContent')) return undefined;

      const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
      return {
        id,
        label: typeof model?.displayName === 'string' ? model.displayName : id,
        contextWindow: toNumber(model?.inputTokenLimit),
        supportsTools: /gemini-(1\.5|2|3)/i.test(id),
      };
    })
    .filter((m): m is ModelInfo => m !== undefined);
}

/**
 * OpenRouter `GET /api/v1/models/{id}/endpoints` — the providers actually
 * serving one model, each with its own price, quantization and context window.
 *
 * The plain model id works in the path, `:free` suffix included, so no
 * canonical slug has to be carried around. `throughput_last_30m` and
 * `latency_last_30m` are declared by the API but come back null for every
 * endpoint, so they are deliberately not read here — see the note in
 * `endpoints.ts`.
 *
 * Endpoints repeating a tag are dropped, keeping the first. The API returns
 * these for a minority of models — `openai/gpt-oss-120b` lists `baseten/fp4`
 * twice with identical facts — and they are indistinguishable downstream:
 * `provider.order` takes the tag, so there is no way to pin one rather than the
 * other, and two rows offering the same route is a choice the user cannot make.
 * The first is kept because the list arrives in OpenRouter's own preference
 * order. Enforcing uniqueness here is also what makes the tag safe to use as a
 * React key; letting duplicates through multiplied rows on every re-render.
 */
export function parseOpenRouterEndpoints(payload: unknown): ModelEndpoint[] {
  const root = asRecord(asRecord(payload)?.data);
  const seen = new Set<string>();

  return asArray(root?.endpoints)
    .map((entry): ModelEndpoint | undefined => {
      const endpoint = asRecord(entry);
      // Without a tag the endpoint cannot be routed to, so it cannot be offered.
      const tag = endpoint?.tag;
      if (typeof tag !== 'string' || tag === '') return undefined;
      if (seen.has(tag)) return undefined;
      seen.add(tag);

      const pricing = asRecord(endpoint?.pricing);
      const promptPrice = toNumber(pricing?.prompt);
      const completionPrice = toNumber(pricing?.completion);
      const supported = asArray(endpoint?.supported_parameters).filter(
        (p): p is string => typeof p === 'string'
      );
      const quantization = endpoint?.quantization;
      const status = toNumber(endpoint?.status);

      return {
        tag,
        providerName:
          typeof endpoint?.provider_name === 'string' && endpoint.provider_name !== ''
            ? endpoint.provider_name
            : tag,
        contextWindow: toNumber(endpoint?.context_length),
        maxCompletionTokens: toNumber(endpoint?.max_completion_tokens),
        pricing:
          promptPrice === undefined && completionPrice === undefined
            ? undefined
            : { prompt: promptPrice, completion: completionPrice },
        // "unknown" is the API's way of saying it has no value; carrying the
        // word through would render as a fact the user cannot act on.
        ...(typeof quantization === 'string' && quantization !== '' && quantization !== 'unknown'
          ? { quantization }
          : {}),
        ...(toNumber(endpoint?.uptime_last_1d) === undefined
          ? {}
          : { uptime: toNumber(endpoint?.uptime_last_1d) }),
        degraded: status !== undefined && status < 0,
        supportsTools: supported.includes('tools') || supported.includes('tool_choice'),
      };
    })
    .filter((e): e is ModelEndpoint => e !== undefined);
}

/**
 * Per-endpoint speed, from OpenRouter's own site API
 * (`/api/frontend/v1/stats/endpoint?permaslug=…`). Keyed by the same tag the
 * public endpoint list uses, so the two join on `provider_slug`.
 *
 * This is the API the model pages read, not the documented one: the public
 * `/api/v1/models/{id}/endpoints` declares `throughput_last_30m` and
 * `latency_last_30m` and returns null for both on every endpoint. Being
 * undocumented, it is treated strictly as an enhancement — see the merge in
 * `definitions.ts`, which drops it silently rather than failing the list.
 */
export function parseOpenRouterEndpointStats(payload: unknown): Map<string, EndpointStats> {
  const stats = new Map<string, EndpointStats>();

  for (const entry of asArray(asRecord(payload)?.data)) {
    const endpoint = asRecord(entry);
    const tag = endpoint?.provider_slug;
    if (typeof tag !== 'string' || tag === '') continue;

    const measured = asRecord(endpoint?.stats);
    const throughput = toNumber(measured?.p50_throughput);
    const latency = toNumber(measured?.p50_latency);
    const sampleCount = toNumber(measured?.request_count);
    if (throughput === undefined && latency === undefined) continue;

    stats.set(tag, {
      ...(throughput === undefined ? {} : { throughput }),
      ...(latency === undefined ? {} : { latency }),
      ...(sampleCount === undefined ? {} : { sampleCount }),
    });
  }

  return stats;
}

export interface EndpointStats {
  throughput?: number;
  latency?: number;
  sampleCount?: number;
}
