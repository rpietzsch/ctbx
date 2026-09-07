/**
 * Per-model endpoint lists, and the pin that turns one of them into a route.
 *
 * OpenRouter serves most models from many competing providers, and the price
 * spread between them is large — DeepSeek V4 Flash runs from $0.05/M to
 * $0.44/M for input across its 30 endpoints. The model list reports only the
 * default route's price, so a user who cares what a turn costs has to be able
 * to see the endpoints and pick one.
 *
 * Speed figures come from a second, undocumented source and are merged in by
 * the provider definition; see `fetchEndpointStats` there for why they are
 * best-effort. Everything in this module treats them as optional, because they
 * are.
 */
import type { ProviderId } from '@/config/schema';
import { getDefinition, listModels } from './registry';
import type { ModelEndpoint } from './types';

/**
 * Short by design. Endpoint prices and uptime move, and a pinned endpoint
 * showing a stale price is a worse failure than one extra request — which is
 * also why this cache is memory-only and does not survive a reload.
 */
export const ENDPOINT_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  endpoints: ModelEndpoint[];
}

const cache = new Map<string, CacheEntry>();

/** Test seam; also called when the user forgets a provider. */
export function clearEndpointCache(): void {
  cache.clear();
}

export interface ListEndpointsResult {
  endpoints: ModelEndpoint[];
  source: 'cache' | 'network' | 'unsupported';
  error?: string;
}

/**
 * Endpoints for one model, or an empty list for providers that do not route.
 * Never throws: an endpoint list is an enhancement, and failing to load it
 * must not take the model with it.
 */
export async function listEndpoints(
  providerId: ProviderId,
  modelId: string,
  options: { force?: boolean; now?: number; signal?: AbortSignal } = {}
): Promise<ListEndpointsResult> {
  const definition = getDefinition(providerId);
  if (!definition.listEndpoints) return { endpoints: [], source: 'unsupported' };

  const now = options.now ?? Date.now();
  const key = `${providerId}::${modelId}`;
  const cached = cache.get(key);
  if (
    !options.force &&
    cached &&
    now - cached.fetchedAt < ENDPOINT_CACHE_TTL_MS &&
    now >= cached.fetchedAt
  ) {
    return { endpoints: cached.endpoints, source: 'cache' };
  }

  try {
    const endpoints = await definition.listEndpoints(modelId, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(await canonicalSlugOf(providerId, modelId, now)),
    });
    cache.set(key, { fetchedAt: now, endpoints });
    return { endpoints, source: 'network' };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'Could not load the endpoint list.';
    // A stale list still beats none: the user can see who serves the model.
    if (cached) return { endpoints: cached.endpoints, source: 'cache', error };
    return { endpoints: [], source: 'network', error };
  }
}

/**
 * The versioned slug the speed statistics are keyed by, read from the model
 * list that the picker has already loaded and cached. Returns nothing rather
 * than forcing a fetch: without it the caller simply gets no speed column, and
 * a missing column is a far better outcome than a blocked endpoint list.
 */
async function canonicalSlugOf(
  providerId: ProviderId,
  modelId: string,
  now: number
): Promise<{ canonicalSlug?: string }> {
  try {
    // The same clock as the endpoint fetch, so one call cannot decide the
    // model list is fresh while the other decides it is stale.
    const { models } = await listModels(providerId, { now });
    const canonicalSlug = models.find((model) => model.id === modelId)?.canonicalSlug;
    return canonicalSlug === undefined ? {} : { canonicalSlug };
  } catch {
    return {};
  }
}

/**
 * How the endpoint list can be ordered.
 *
 * Direction is a separate axis, so every key can run either way. Each carries
 * the direction that is useful first — cheapest, biggest, fastest, most
 * available — which is applied when the key is chosen and can then be flipped.
 */
export const ENDPOINT_SORTS = [
  { key: 'price', label: 'Price', defaultDirection: 'asc' },
  { key: 'name', label: 'Name', defaultDirection: 'asc' },
  { key: 'context', label: 'Context', defaultDirection: 'desc' },
  { key: 'throughput', label: 'Speed', defaultDirection: 'desc' },
  { key: 'uptime', label: 'Uptime', defaultDirection: 'desc' },
] as const satisfies readonly { key: string; label: string; defaultDirection: SortDirection }[];

export type EndpointSort = (typeof ENDPOINT_SORTS)[number]['key'];
export type SortDirection = 'asc' | 'desc';

export const DEFAULT_ENDPOINT_SORT: EndpointSort = 'price';

/** The direction a key opens in before the user flips it. */
export function defaultDirectionFor(sort: EndpointSort): SortDirection {
  return ENDPOINT_SORTS.find((option) => option.key === sort)?.defaultDirection ?? 'asc';
}

export function oppositeOf(direction: SortDirection): SortDirection {
  return direction === 'asc' ? 'desc' : 'asc';
}

function rankFor(sort: EndpointSort, endpoint: ModelEndpoint): number | undefined {
  switch (sort) {
    case 'price':
      return endpoint.pricing?.prompt ?? endpoint.pricing?.completion;
    case 'context':
      return endpoint.contextWindow;
    case 'throughput':
      return endpoint.throughput;
    case 'uptime':
      return endpoint.uptime;
    case 'name':
      return undefined;
  }
}

/**
 * Orders two possibly-absent numbers.
 *
 * An endpoint that does not report the field being sorted on always goes last,
 * whichever direction the sort runs — an absent price or throughput is a gap in
 * what the provider publishes, not a score of zero, and inverting the sort must
 * not promote those gaps to the top. Comparing two absent values as equal also
 * keeps `Infinity - Infinity` out of the comparator, where a NaN would make the
 * whole ordering undefined.
 */
function compareOptional(
  left: number | undefined,
  right: number | undefined,
  sign: number
): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return sign * (left - right);
}

/** Ties break on tag, so the order never shuffles between renders. */
export function sortEndpoints(
  endpoints: ModelEndpoint[],
  sort: EndpointSort = DEFAULT_ENDPOINT_SORT,
  direction: SortDirection = defaultDirectionFor(sort)
): ModelEndpoint[] {
  const sign = direction === 'asc' ? 1 : -1;

  return [...endpoints].sort((a, b) => {
    if (sort === 'name') {
      return sign * a.providerName.localeCompare(b.providerName) || a.tag.localeCompare(b.tag);
    }

    const byRank = compareOptional(rankFor(sort, a), rankFor(sort, b), sign);
    if (byRank !== 0) return byRank;

    // Same input price is common — a shared upstream rate card. Output price
    // is what actually separates those endpoints.
    if (sort === 'price') {
      const byOutput = compareOptional(a.pricing?.completion, b.pricing?.completion, sign);
      if (byOutput !== 0) return byOutput;
    }
    return a.tag.localeCompare(b.tag);
  });
}

/**
 * Substring filter over the facts that identify an endpoint: the provider's
 * name, its routing tag, and its quantization. Every whitespace-separated term
 * must match somewhere, so "deep fp8" narrows rather than widens.
 *
 * Unranked, unlike the model search — a dozen-odd endpoints all fit on screen,
 * and the chosen sort order is more useful here than a relevance score that
 * would fight it.
 */
export function searchEndpoints(endpoints: ModelEndpoint[], query: string): ModelEndpoint[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return endpoints;

  return endpoints.filter((endpoint) => {
    const haystack =
      `${endpoint.providerName} ${endpoint.tag} ${endpoint.quantization ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** The pinned endpoint, or undefined when the pin no longer matches a route. */
export function findEndpoint(
  endpoints: ModelEndpoint[],
  tag: string | undefined
): ModelEndpoint | undefined {
  return tag === undefined ? undefined : endpoints.find((endpoint) => endpoint.tag === tag);
}
