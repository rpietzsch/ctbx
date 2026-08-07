/**
 * Pure parsers for provider model-list responses.
 *
 * Kept separate from the fetch calls so every shape quirk is unit-testable
 * without a network or an API key (spec §12, and the "no keys in tests" rule).
 * All of them are defensive: a provider adding or renaming a field must not
 * empty the model picker.
 */
import type { ModelInfo } from './types';

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

      return {
        id,
        label: typeof model?.name === 'string' ? model.name : id,
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
