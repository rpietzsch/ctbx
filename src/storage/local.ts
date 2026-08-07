/**
 * Versioned, namespaced localStorage wrapper.
 *
 * Per tasks/spec.md §9.2 (G3), provider API keys and OAuth tokens live only in
 * localStorage. Consequences encoded here:
 *
 *  - every stored item is declared up front, so the data-transparency screen
 *    (backlog M5-7) can enumerate everything without guesswork;
 *  - items holding credentials are marked `secret`, so they can be redacted in
 *    exports and diagnostics and purged as a group;
 *  - nothing here ever writes to the console — a stray log of a store value
 *    would leak a key. See the `no-console` lint rule.
 */

export const STORAGE_NAMESPACE = 'ctbx';

export type Migration = (previous: unknown, fromVersion: number) => unknown;

export interface StoreOptions<T> {
  /** Short, stable identifier. Becomes `ctbx:<name>`. */
  name: string;
  /** Bump when the persisted shape changes; pair with `migrate`. */
  version: number;
  /** Human-readable label for the data-transparency screen. */
  label: string;
  /** True when the value contains credentials (API keys, OAuth tokens). */
  secret?: boolean;
  /** Value used when nothing is stored or the stored value is unusable. */
  fallback: () => T;
  /** Returns the parsed value, or `undefined` if the raw value is not valid. */
  parse: (raw: unknown) => T | undefined;
  /** Upgrades a value written by an older version. */
  migrate?: Migration;
}

export interface StoreHandle<T> {
  readonly name: string;
  readonly storageKey: string;
  readonly label: string;
  readonly secret: boolean;
  get(): T;
  set(value: T): void;
  update(fn: (current: T) => T): T;
  remove(): void;
  exists(): boolean;
  subscribe(listener: (value: T) => void): () => void;
}

interface Envelope {
  v: number;
  d: unknown;
}

const registry = new Map<string, StoreHandle<unknown>>();

export function storageKeyFor(name: string): string {
  return `${STORAGE_NAMESPACE}:${name}`;
}

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && 'v' in value && 'd' in value;
}

/**
 * localStorage can be entirely unavailable (private mode, disabled cookies) or
 * throw on write (quota). Callers must keep working, so every access is guarded
 * and failures degrade to in-memory behaviour rather than crashing the app.
 */
function safeRead(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): boolean {
  try {
    globalThis.localStorage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* nothing useful to do */
  }
}

export function defineStore<T>(options: StoreOptions<T>): StoreHandle<T> {
  const storageKey = storageKeyFor(options.name);
  const listeners = new Set<(value: T) => void>();
  let memoryFallback: T | undefined;

  // Parsed values are cached and only replaced when the underlying data
  // changes. React's useSyncExternalStore requires getSnapshot to be
  // referentially stable — returning a freshly parsed object on every call
  // makes it loop or bail out, which is how the servers list rendered empty.
  let cache: { raw: string | null; value: T } | undefined;

  function parse(): T {
    const raw = safeRead(storageKey);
    if (raw === null) return memoryFallback ?? options.fallback();

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return options.fallback();
    }

    if (!isEnvelope(decoded)) {
      // Written before envelopes existed, or corrupted. Try to parse as-is.
      return options.parse(decoded) ?? options.fallback();
    }

    let payload = decoded.d;
    if (decoded.v !== options.version) {
      if (!options.migrate) return options.fallback();
      try {
        payload = options.migrate(payload, decoded.v);
      } catch {
        return options.fallback();
      }
    }

    return options.parse(payload) ?? options.fallback();
  }

  /** Cached read: re-parses only when the serialized form actually changed. */
  function read(): T {
    const raw = safeRead(storageKey);
    if (cache && cache.raw === raw) return cache.value;
    const value = parse();
    cache = { raw, value };
    return value;
  }

  function write(value: T): void {
    const envelope: Envelope = { v: options.version, d: value };
    const serialized = JSON.stringify(envelope);
    const ok = safeWrite(storageKey, serialized);
    // If persistence failed, keep the value for this page's lifetime so the UI
    // stays coherent rather than silently reverting to the fallback.
    memoryFallback = ok ? undefined : value;
    cache = { raw: ok ? serialized : null, value };
    for (const listener of listeners) listener(value);
  }

  const handle: StoreHandle<T> = {
    name: options.name,
    storageKey,
    label: options.label,
    secret: options.secret ?? false,
    get: read,
    set: write,
    update(fn) {
      const next = fn(read());
      write(next);
      return next;
    },
    remove() {
      safeRemove(storageKey);
      memoryFallback = undefined;
      cache = undefined;
      for (const listener of listeners) listener(read());
    },
    exists() {
      return safeRead(storageKey) !== null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  registry.set(options.name, handle as StoreHandle<unknown>);
  return handle;
}

/** Every declared store, for the data-transparency screen (M5-7). */
export function listStores(): StoreHandle<unknown>[] {
  return [...registry.values()];
}

export interface StoredItemSummary {
  name: string;
  label: string;
  secret: boolean;
  present: boolean;
  /** Approximate serialized size in bytes; never the value itself. */
  bytes: number;
}

/**
 * Describes what is stored without ever returning the values. Safe to render,
 * safe to include in a bug report.
 */
export function summarizeStorage(): StoredItemSummary[] {
  return listStores().map((store) => {
    const raw = safeRead(store.storageKey);
    return {
      name: store.name,
      label: store.label,
      secret: store.secret,
      present: raw !== null,
      bytes: raw === null ? 0 : new Blob([raw]).size,
    };
  });
}

/** Clears every declared store. Used by "forget everything". */
export function clearAllStores(): void {
  for (const store of listStores()) store.remove();
}

/** Clears only stores holding credentials. */
export function clearSecretStores(): void {
  for (const store of listStores()) if (store.secret) store.remove();
}

/** Test-only: drops registry state between test files. */
export function __resetRegistry(): void {
  registry.clear();
}
