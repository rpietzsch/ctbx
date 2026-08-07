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
   * Whether the model can call tools. Drives the filtering in spec §5.3 — a
   * model that silently ignores 40 MCP tools is a bad failure mode.
   */
  supportsTools: boolean;
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
  createModel(config: ProviderConfig, modelId: string): LanguageModel;
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
