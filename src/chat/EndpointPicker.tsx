import { useEffect, useRef, useState } from 'react';
import { getDefinition } from '@/providers/registry';
import {
  DEFAULT_ENDPOINT_SORT,
  ENDPOINT_SORTS,
  defaultDirectionFor,
  findEndpoint,
  listEndpoints,
  oppositeOf,
  searchEndpoints,
  sortEndpoints,
  type EndpointSort,
  type SortDirection,
} from '@/providers/endpoints';
import type { ModelEndpoint } from '@/providers/types';
import { mcpManager, useChatStore } from '@/state/chat';
import { Badge, Button, cx } from '@/ui/primitives';
import {
  endpointQualifiers,
  formatContextWindow,
  formatPricing,
  formatPricingTitle,
  formatSpeedTitle,
  formatThroughput,
  formatUptime,
} from './model-search';

/**
 * Picks which OpenRouter endpoint serves the conversation.
 *
 * OpenRouter routes one model across many providers whose prices differ — up
 * to 9x for the same model — so the price the model picker shows is only the
 * default route's. Pinning an endpoint here is what makes the number in the
 * toolbar the number the user actually pays. Rendered only for providers that
 * route at all; for the direct providers the model *is* the endpoint.
 */
interface Loaded {
  /** `providerId::modelId` the list was fetched for. */
  key: string;
  endpoints: ModelEndpoint[];
  error?: string | undefined;
}

export function EndpointPicker() {
  const { current, setEndpoint } = useChatStore();
  /*
    The loaded list carries the model it belongs to. Deriving "is this list
    current?" from that is what keeps a model switch from showing the previous
    model's providers, without an effect that clears state synchronously — and
    it makes `loading` a derived fact rather than a third thing to keep in sync.
  */
  const [loaded, setLoaded] = useState<Loaded>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<EndpointSort>(DEFAULT_ENDPOINT_SORT);
  const [direction, setDirection] = useState<SortDirection>(
    defaultDirectionFor(DEFAULT_ENDPOINT_SORT)
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const providerId = current?.providerId;
  const modelId = current?.modelId;
  const pinned = current?.endpointTag;
  const routes = providerId !== undefined && getDefinition(providerId).listEndpoints !== undefined;
  const key = routes && modelId !== undefined ? `${providerId}::${modelId}` : undefined;

  const fresh = loaded?.key === key ? loaded : undefined;
  const endpoints = fresh?.endpoints ?? [];
  const error = fresh?.error;
  const loading = key !== undefined && fresh === undefined;

  useEffect(() => {
    if (key === undefined || providerId === undefined || modelId === undefined) return;
    const controller = new AbortController();
    void listEndpoints(providerId, modelId, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setLoaded({ key, endpoints: result.endpoints, error: result.error });
    });
    return () => controller.abort();
  }, [key, providerId, modelId]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!routes || modelId === undefined) return null;

  const shown = sortEndpoints(searchEndpoints(endpoints, query), sort, direction);
  const active = findEndpoint(endpoints, pinned);
  // A pin that survived a provider dropping the model. Saying so is the point:
  // silently falling back to automatic routing changes what a turn costs.
  const orphaned = pinned !== undefined && active === undefined && !loading && endpoints.length > 0;

  const choose = (tag: string | undefined) => {
    void setEndpoint(tag);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          active
            ? `Pinned to ${active.providerName}. ${formatPricingTitle(active.pricing) ?? ''}`.trim()
            : 'OpenRouter picks the endpoint, so the price can vary per request.'
        }
        className={cx(
          'flex max-w-[12rem] items-center gap-1.5 truncate rounded-lg border px-2.5 py-1.5 text-xs',
          orphaned ? 'border-warn/50 bg-warn/10 text-warn' : 'border-border bg-surface'
        )}
      >
        <span className="truncate">
          {loading ? 'Endpoints…' : orphaned ? 'Pin unavailable' : (active?.providerName ?? 'Auto')}
        </span>
        <span aria-hidden="true" className="text-fg-muted">
          ▾
        </span>
      </button>

      {open ? (
        <div
          className={cx(
            'z-40 flex flex-col overflow-hidden border-border bg-surface shadow-2xl',
            'fixed inset-x-0 bottom-0 max-h-[70dvh] rounded-t-xl border-x-0 border-b-0 border-t',
            'pb-[env(safe-area-inset-bottom)]',
            'sm:absolute sm:inset-x-auto sm:bottom-full sm:right-0 sm:mb-2 sm:w-[26rem]',
            'sm:max-h-[min(24rem,calc(100vh-10rem))] sm:max-w-[calc(100vw-2rem)]',
            'sm:rounded-xl sm:border sm:pb-0'
          )}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search endpoints…"
              aria-label="Search endpoints"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm"
            />
            <select
              value={sort}
              onChange={(event) => {
                const next = event.target.value as EndpointSort;
                setSort(next);
                // Each key opens in its useful direction rather than inheriting
                // the last one: "Price ascending" and "Speed ascending" are not
                // the same kind of answer.
                setDirection(defaultDirectionFor(next));
              }}
              aria-label="Sort endpoints"
              className="shrink-0 rounded-lg border border-border bg-surface-2 px-1.5 py-1.5 text-xs"
            >
              {ENDPOINT_SORTS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Sorted ${direction === 'asc' ? 'ascending' : 'descending'} — reverse`}
              title={`Sorted ${direction === 'asc' ? 'ascending' : 'descending'}. Click to reverse.`}
              onClick={() => setDirection(oppositeOf)}
            >
              {direction === 'asc' ? '↑' : '↓'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => {
                if (providerId === undefined || key === undefined) return;
                setLoaded(undefined);
                void listEndpoints(providerId, modelId, { force: true }).then((result) => {
                  setLoaded({ key, endpoints: result.endpoints, error: result.error });
                });
              }}
            >
              {loading ? '…' : '↻'}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="listbox">
            {error ? <p className="px-3 py-2 text-xs text-warn">{error}</p> : null}
            {orphaned ? (
              <p className="px-3 py-2 text-xs text-warn">
                No endpoint is tagged <span className="font-mono">{pinned}</span> any more. Routing
                is automatic until you pick another.
              </p>
            ) : null}

            <EndpointRow
              label="Auto"
              detail="OpenRouter chooses — price varies"
              selected={pinned === undefined}
              onClick={() => choose(undefined)}
            />

            {shown.map((endpoint) => (
              <EndpointRow
                key={endpoint.tag}
                label={endpoint.providerName}
                qualifiers={endpointQualifiers(endpoint)}
                selected={endpoint.tag === pinned}
                warn={endpoint.degraded}
                facts={[
                  {
                    text: formatPricing(endpoint.pricing),
                    title: formatPricingTitle(endpoint.pricing),
                  },
                  { text: formatContextWindow(endpoint.contextWindow), title: 'Context window' },
                  {
                    text: formatThroughput(endpoint.throughput),
                    title: formatSpeedTitle(endpoint),
                  },
                  { text: formatUptime(endpoint.uptime), title: 'Uptime, last 24h' },
                ]}
                note={
                  endpoint.degraded
                    ? 'Deranked by OpenRouter'
                    : !endpoint.supportsTools && mcpManager.hasConnectedServers()
                      ? 'Ignores MCP tools'
                      : undefined
                }
                onClick={() => choose(endpoint.tag)}
              />
            ))}

            {!loading && shown.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-fg-muted">
                {endpoints.length > 0
                  ? `No endpoint matches “${query}”.`
                  : error
                    ? 'The endpoint list is unavailable.'
                    : 'This model has one endpoint.'}
              </p>
            ) : null}
          </div>

          <p className="shrink-0 border-t border-border px-3 py-1.5 text-[0.7rem] text-fg-muted">
            {pinned === undefined
              ? 'Pin one to fix the price of a turn.'
              : 'Pinned: fallbacks are off, so a busy endpoint fails rather than rerouting.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}

interface Fact {
  text: string | undefined;
  title: string | undefined;
}

/**
 * One row. The facts sit in fixed-width columns so they line up down the list
 * and a row's height never depends on how much its provider reports — a short
 * name with no quantization must not shift the prices out of their column.
 */
function EndpointRow({
  label,
  qualifiers = [],
  detail,
  facts = [],
  note,
  selected,
  warn = false,
  onClick,
}: {
  label: string;
  qualifiers?: string[];
  detail?: string;
  facts?: Fact[];
  note?: string | undefined;
  selected: boolean;
  warn?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cx(
        'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-surface-3',
        selected ? 'bg-surface-2' : ''
      )}
    >
      <span className="flex w-full items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">
          {label}
          {qualifiers.length > 0 ? (
            <span
              className="text-fg-muted"
              title="Region or variant, and the numeric precision the weights are served at — fp4 and fp8 are compressed, bf16 is full precision."
            >
              {' · '}
              {qualifiers.join(' · ')}
            </span>
          ) : null}
        </span>
        {note ? <Badge tone={warn ? 'warn' : 'neutral'}>{note}</Badge> : null}
        {selected ? <Badge tone="accent">current</Badge> : null}
      </span>
      {detail ? (
        <span className="w-full truncate text-[0.7rem] text-fg-muted">{detail}</span>
      ) : (
        /*
          Fixed track widths so the columns line up down the list, and no `1fr`
          anywhere: the grid is left-packed and any spare width collects at the
          end of the row rather than opening a gap between the last two facts.
        */
        <span className="grid w-full grid-cols-[6.5rem_3.75rem_3.25rem_auto] gap-x-3 text-[0.7rem] tabular-nums text-fg-muted">
          {facts.slice(0, 4).map((fact, index) => (
            <span key={index} className="truncate" title={fact.title}>
              {fact.text ?? ''}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
