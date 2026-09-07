import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderId } from '@/config/schema';
import { configuredProviders, preferencesStore, setModelPickerToolsOnly } from '@/config/stores';
import { useStore } from '@/storage/useStore';
import { filterModels, getDefinition, listModels } from '@/providers/registry';
import { mcpManager, useChatStore } from '@/state/chat';
import { Badge, Button, cx } from '@/ui/primitives';
import {
  formatContextWindow,
  formatPricing,
  formatPricingTitle,
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

/**
 * How many rows are rendered at once. Several hundred two-line rows is a lot of
 * DOM for a panel meant to be searched rather than scrolled — but see `limit`,
 * which stretches this far enough to reach the model in use.
 */
const RENDERED_ROWS = 100;
export function ModelPicker() {
  const { current, setModel } = useChatStore();
  const [models, setModels] = useState<PickableModel[]>([]);
  // Starts true so the mount effect never has to setState synchronously.
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** An explicit move of the highlight — arrow keys or the pointer. */
  const [moved, setMoved] = useState<number>();

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const preferences = useStore(preferencesStore);
  const toolsOnly = preferences.modelPickerToolsOnly;
  const serversConnected = mcpManager.hasConnectedServers();

  // Every model is loaded and kept; the tool filter is applied at render time.
  // Filtering during the fetch meant toggling it re-ran every provider request,
  // and made "how many are hidden" impossible to answer.
  const loadAll = async (force = false) => {
    const providers = configuredProviders();
    const results = await Promise.all(
      providers.map(async (provider) => {
        const result = await listModels(provider.providerId, force ? { force: true } : {});
        const definition = getDefinition(provider.providerId);
        return result.models.map((model): PickableModel => ({
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
    // Fetch once on mount. State is set after awaiting the provider requests;
    // the rule cannot see through the call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
  }, []);

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

  const visible = useMemo(() => filterModels(models, toolsOnly), [models, toolsOnly]);
  const hiddenCount = toolsOnly ? models.length - visible.length : 0;
  const results = useMemo(() => searchModels(visible, query), [visible, query]);

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

  /*
    The row cap is stretched to reach the model in use. It is routinely past
    row 100 — OpenRouter lists over 350, in its own order — and a picker that
    renders everything except what you are currently using is worse than one
    that renders a few hundred rows on the rare occasion it has to.
  */
  const selectedPosition = results.findIndex((model) => model.key === selected?.key);
  const limit = Math.max(RENDERED_ROWS, selectedPosition + 1);
  const grouped = useMemo(() => groupByProvider(results.slice(0, limit)), [results, limit]);
  const flatResults = useMemo(() => grouped.flatMap(([, list]) => list), [grouped]);

  // Row order as a lookup, rather than an indexOf per row: the list is long
  // enough now that scanning it once per row is real work on every keystroke.
  const positions = useMemo(
    () => new Map(flatResults.map((model, index) => [model.key, index])),
    [flatResults]
  );

  /** Where the model in use sits in the list, or -1 when it is filtered out. */
  const selectedIndex = selected === undefined ? -1 : (positions.get(selected.key) ?? -1);

  /*
    Opening the picker lands on the model in use rather than on whatever heads
    a list of several hundred: that is the row the reader opened it to see, and
    the one the arrow keys should move away from. Searching is the exception —
    a query wants its best match first.

    Derived rather than stored, so that it follows the list instead of chasing
    it: the models arrive after the panel is already open, and the tool filter
    reorders them under it. Only an explicit move pins the highlight, and that
    pin is dropped whenever the list itself changes meaning.
  */
  const defaultHighlight = query === '' && selectedIndex >= 0 ? selectedIndex : 0;
  const highlight = moved ?? defaultHighlight;

  // Keeps the highlighted row in view: it starts somewhere down a long list,
  // and arrow keys would otherwise walk it off the bottom of the panel. The
  // opening jump is centred — landing hard against an edge reads as the end of
  // the list — while a move is nudged only as far as it has to be.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-option-index="${highlight}"]`)
      ?.scrollIntoView({ block: moved === undefined ? 'center' : 'nearest' });
  }, [open, highlight, moved]);

  const choose = (model: PickableModel) => {
    void setModel(model.providerId as ProviderId, model.id);
    setOpen(false);
    setQuery('');
    setMoved(undefined);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setMoved(Math.min(highlight + 1, flatResults.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setMoved(Math.max(highlight - 1, 0));
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
        onClick={() => {
          setMoved(undefined);
          setOpen((value) => !value);
        }}
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
            'z-40 flex flex-col overflow-hidden border-border bg-surface shadow-2xl',
            /*
              Phone: a bottom sheet pinned to the viewport. Anchoring the panel
              to the trigger cannot work here — the clamp that keeps it narrow
              enough knows nothing about how far along the row the trigger sits,
              so the panel hung off the right edge and made the whole page
              scroll sideways. Pinning to the viewport removes the arithmetic.
            */
            'fixed inset-x-0 bottom-0 max-h-[70dvh] rounded-t-xl border-x-0 border-b-0 border-t',
            'pb-[env(safe-area-inset-bottom)]',
            // Pointer widths: back to a popover anchored above the trigger.
            'sm:absolute sm:inset-x-auto sm:bottom-full sm:left-0 sm:mb-2 sm:w-[28rem]',
            'sm:max-h-[min(26rem,calc(100vh-10rem))] sm:max-w-[calc(100vw-2rem)]',
            'sm:rounded-xl sm:border sm:pb-0'
          )}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setMoved(undefined);
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

          <label
            className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-fg-muted"
            title="Providers report which models can call tools. OpenRouter publishes it per model; for the others it is inferred from the model family."
          >
            <input
              type="checkbox"
              checked={toolsOnly}
              onChange={(event) => {
                setModelPickerToolsOnly(event.target.checked);
                setMoved(undefined);
              }}
            />
            <span className="flex-1">Only models that support tool calling</span>
            {hiddenCount > 0 ? <span>{hiddenCount} hidden</span> : null}
          </label>

          <div
            ref={listRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            role="listbox"
          >
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
                    const index = positions.get(model.key) ?? 0;
                    const facts = [
                      { text: formatContextWindow(model.contextWindow), title: 'Context window' },
                      {
                        text: formatPricing(model.pricing),
                        title: formatPricingTitle(model.pricing),
                      },
                    ].filter((fact): fact is { text: string; title: string | undefined } =>
                      Boolean(fact.text)
                    );

                    return (
                      <button
                        key={model.key}
                        type="button"
                        role="option"
                        data-option-index={index}
                        aria-selected={model.key === selected?.key}
                        onMouseEnter={() => setMoved(index)}
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
                            <span key={fact.text} className="shrink-0" title={fact.title}>
                              {fact.text}
                            </span>
                          ))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}

            {results.length > limit ? (
              <p className="px-3 py-2 text-center text-xs text-fg-muted">
                {results.length - limit} more — keep typing to narrow the list.
              </p>
            ) : null}
          </div>

          <p className="shrink-0 border-t border-border px-3 py-1.5 text-[0.7rem] text-fg-muted">
            {/*
              Worth saying out loud only in the case that can bite: the filter is
              off while MCP servers are connected, so the list now includes
              models that will ignore every one of their tools.
            */}
            {!toolsOnly && serversConnected
              ? 'MCP servers are connected. Models without tool support will ignore their tools.'
              : `${results.length} model${results.length === 1 ? '' : 's'}`}
          </p>
        </div>
      ) : null}
    </div>
  );
}
