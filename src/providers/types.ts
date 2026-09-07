import type { LanguageModel } from 'ai';
import type { ProviderConfig, ProviderId } from '@/config/schema';

export interface ModelInfo {
  id: string;
  label: string;
  /** Maximum context in tokens, when the provider reports it. */
  contextWindow?: number;
  /** USD per token (not per million), when the provider reports it. */
  pricing?: { prompt?: number; completion?: number };
  /**
   * The versioned slug behind the id — `z-ai/glm-5.3` is served by
   * `z-ai/glm-5.3-20260816`. OpenRouter's per-endpoint statistics are keyed by
   * this and silently return nothing for the plain id, so it has to travel
   * with the model.
   */
  canonicalSlug?: string;
  /**
   * Whether the model can call tools. Drives the filtering in spec §5.3 — a
   * model that silently ignores 40 MCP tools is a bad failure mode.
   */
  supportsTools: boolean;
}

/**
 * One provider endpoint serving a model — OpenRouter routes every request to
 * one of these. Only OpenRouter exposes them (spec §5.2); for every other
 * provider the model *is* the endpoint.
 */
export interface ModelEndpoint {
  /**
   * Routing identifier: a provider slug, optionally qualified by region or
   * quantization (`google-vertex/us-east5`, `reka/fp8`, or a bare `wafer`).
   * This is the exact string OpenRouter's `provider.order` expects, and the
   * only field that identifies an endpoint — `providerName` does not, since one
   * provider commonly serves the same model from several regions.
   *
   * Unique within a list, but only because the parser makes it so: the API
   * itself repeats a tag for a minority of models, and those repeats name the
   * same routing target. See `parseOpenRouterEndpoints`.
   */
  tag: string;
  providerName: string;
  contextWindow?: number;
  maxCompletionTokens?: number;
  /** USD per token (not per million), matching `ModelInfo`. */
  pricing?: { prompt?: number; completion?: number };
  /** `fp8`, `bf16`, … The provider's literal `unknown` is dropped instead. */
  quantization?: string;
  /** Uptime over the last day as a percentage (0–100), when reported. */
  uptime?: number;
  /** Median output speed in tokens per second over the last 30 minutes. */
  throughput?: number;
  /** Median latency in milliseconds over the same window. */
  latency?: number;
  /**
   * Requests the throughput and latency medians were taken over. A handful of
   * requests makes them noise, so the number travels with them.
   */
  sampleCount?: number;
  /** OpenRouter has deranked or disabled this endpoint (negative `status`). */
  degraded: boolean;
  supportsTools: boolean;
}

/**
 * Per-request routing choices. Empty for every provider but OpenRouter, which
 * is the only one that routes a model across competing endpoints.
 */
export interface ModelRouting {
  /** Pin the request to one endpoint, by `ModelEndpoint.tag`. */
  endpointTag?: string;
}

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  /** Where the user obtains a key. */
  keyUrl: string;
  /** Placeholder shown in the key field. */
  keyHint: string;
  /** Cheap client-side sanity check; never a guarantee. */
  keyPattern?: RegExp;
  /**
   * Surfaced at the point of key entry when using this provider from a browser
   * has caveats the user must consent to (spec §5.2).
   */
  browserNote?: string;
  /** Model used when the user has not chosen one. */
  defaultModelId: string;
  createModel(config: ProviderConfig, modelId: string, routing?: ModelRouting): LanguageModel;
  /**
   * Endpoints serving one model. Omitted by providers that do not route —
   * the absence of the method is what the UI keys off.
   */
  listEndpoints?(
    modelId: string,
    options?: { canonicalSlug?: string | undefined; signal?: AbortSignal | undefined }
  ): Promise<ModelEndpoint[]>;
  listModels(config: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Models to offer when the network list is unavailable. */
  fallbackModels: ModelInfo[];
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}
