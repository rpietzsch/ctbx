import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderId } from '@/config/schema';
import { configuredProviders } from '@/config/stores';
import { filterModels, getDefinition, listModels } from '@/providers/registry';
import { mcpManager, useChatStore } from '@/state/chat';
import { Badge, Button, cx } from '@/ui/primitives';
import {
  formatContextWindow,
  formatPricePerMillion,
  groupByProvider,
  modelKey,
  searchModels,
  type PickableModel,
} from './model-search';

/**
 * Searchable model picker.
 *
 * A plain <select> is unusable here: OpenRouter alone lists 400+ models, so the
 * list has to be filtered by typing rather than scrolled.
 */
export function ModelPicker() {
  const { current, setModel } = useChatStore();
  const [models, setModels] = useState<PickableModel[]>([]);
  // Starts true so the mount effect never has to setState synchronously.
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requireTools = mcpManager.hasConnectedServers();

  const loadAll = async (force = false) => {
    const providers = configuredProviders();
    const results = await Promise.all(
      providers.map(async (provider) => {
        const result = await listModels(provider.providerId, force ? { force: true } : {});
        const definition = getDefinition(provider.providerId);
        return filterModels(result.models, requireTools).map((model): PickableModel => ({
          ...model,
          providerId: provider.providerId,
          providerLabel: definition.label,
          key: modelKey(provider.providerId, model.id),
        }));
      })
    );
    setModels(results.flat());
    setLoading(false);
    setRefreshError(undefined);
  };

  /** Refresh from a click, where a synchronous setState is fine. */
  const refresh = () => {
    setLoading(true);
    void loadAll(true);
  };

  useEffect(() => {
    // Fetch-on-mount, and again whenever tool filtering changes. State is set
    // after awaiting the provider requests; the rule cannot see through the call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
    // loadAll is recreated every render; re-running on that would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requireTools]);

  // Close on outside click and on Escape.
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

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const results = useMemo(() => searchModels(models, query), [models, query]);
  const grouped = useMemo(() => groupByProvider(results.slice(0, 100)), [results]);
  const flatResults = useMemo(() => grouped.flatMap(([, list]) => list), [grouped]);

  const selected =
    current?.providerId && current.modelId
      ? models.find((model) => model.key === modelKey(current.providerId!, current.modelId!))
      : undefined;

  const selectedLabel = selected
    ? selected.label
    : current?.modelId
      ? current.modelId
      : loading
        ? 'Loading models…'
        : 'Choose a model';

  const choose = (model: PickableModel) => {
    void setModel(model.providerId as ProviderId, model.id);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((index) => Math.min(index + 1, flatResults.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const model = flatResults[highlight];
      if (model) choose(model);
    }
  };

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex max-w-[18rem] items-center gap-1.5 truncate rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs"
      >
        <span className="truncate">{selectedLabel}</span>
        <span aria-hidden="true" className="text-fg-muted">
          ▾
        </span>
      </button>

      {open ? (
        <div
          className={cx(
            'absolute bottom-full left-0 z-40 mb-2 flex w-[28rem] max-w-[calc(100vw-2rem)] flex-col',
            // Never taller than the space above the composer.
            'max-h-[min(26rem,calc(100vh-10rem))]',
            'overflow-hidden rounded-xl border border-border bg-surface shadow-2xl'
          )}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search models…"
              aria-label="Search models"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm"
            />
            <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
              {loading ? '…' : 'Refresh'}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="listbox">
            {refreshError ? <p className="px-3 py-2 text-xs text-warn">{refreshError}</p> : null}

            {flatResults.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-fg-muted">
                {loading
                  ? 'Loading models…'
                  : models.length === 0
                    ? 'No models. Add a provider key first.'
                    : `No model matches “${query}”.`}
              </p>
            ) : (
              grouped.map(([providerLabel, list]) => (
                <div key={providerLabel}>
                  <p className="sticky top-0 bg-surface-2 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-fg-muted">
                    {providerLabel}
                  </p>
                  {list.map((model) => {
                    const index = flatResults.indexOf(model);
                    const facts = [
                      formatContextWindow(model.contextWindow),
                      formatPricePerMillion(model.pricing?.prompt),
                    ].filter(Boolean);

                    return (
                      <button
                        key={model.key}
                        type="button"
                        role="option"
                        aria-selected={model.key === selected?.key}
                        onMouseEnter={() => setHighlight(index)}
                        onClick={() => choose(model)}
                        className={cx(
                          'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left',
                          index === highlight ? 'bg-surface-3' : ''
                        )}
                      >
                        <span className="flex w-full items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm">{model.label}</span>
                          {model.key === selected?.key ? (
                            <Badge tone="accent">current</Badge>
                          ) : null}
                        </span>
                        <span className="flex w-full items-center gap-2 text-[0.7rem] text-fg-muted">
                          <span className="min-w-0 flex-1 truncate font-mono">{model.id}</span>
                          {facts.map((fact) => (
                            <span key={fact} className="shrink-0">
                              {fact}
                            </span>
                          ))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}

            {results.length > 100 ? (
              <p className="px-3 py-2 text-center text-xs text-fg-muted">
                {results.length - 100} more — keep typing to narrow the list.
              </p>
            ) : null}
          </div>

          <p className="shrink-0 border-t border-border px-3 py-1.5 text-[0.7rem] text-fg-muted">
            {requireTools
              ? 'Only tool-capable models are listed while MCP servers are connected.'
              : `${results.length} model${results.length === 1 ? '' : 's'}`}
          </p>
        </div>
      ) : null}
    </div>
  );
}
