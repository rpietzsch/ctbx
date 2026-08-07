import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  __resetRegistry,
  clearAllStores,
  clearSecretStores,
  defineStore,
  storageKeyFor,
  summarizeStorage,
} from './local';

interface Settings {
  theme: string;
  count: number;
}

function makeStore(overrides: Partial<Parameters<typeof defineStore<Settings>>[0]> = {}) {
  return defineStore<Settings>({
    name: 'settings',
    version: 1,
    label: 'Settings',
    fallback: () => ({ theme: 'light', count: 0 }),
    parse: (raw) => {
      if (typeof raw !== 'object' || raw === null) return undefined;
      const value = raw as Partial<Settings>;
      if (typeof value.theme !== 'string' || typeof value.count !== 'number') return undefined;
      return { theme: value.theme, count: value.count };
    },
    ...overrides,
  });
}

beforeEach(() => {
  __resetRegistry();
  localStorage.clear();
});

describe('defineStore', () => {
  it('namespaces keys', () => {
    expect(storageKeyFor('settings')).toBe('ctbx:settings');
    expect(makeStore().storageKey).toBe('ctbx:settings');
  });

  it('returns the fallback when nothing is stored', () => {
    expect(makeStore().get()).toEqual({ theme: 'light', count: 0 });
  });

  it('round-trips a value', () => {
    const store = makeStore();
    store.set({ theme: 'dark', count: 3 });
    expect(store.get()).toEqual({ theme: 'dark', count: 3 });
  });

  it('persists in a versioned envelope', () => {
    makeStore().set({ theme: 'dark', count: 1 });
    expect(JSON.parse(localStorage.getItem('ctbx:settings')!)).toEqual({
      v: 1,
      d: { theme: 'dark', count: 1 },
    });
  });

  it('falls back when the stored JSON is corrupt', () => {
    localStorage.setItem('ctbx:settings', '{not json');
    expect(makeStore().get()).toEqual({ theme: 'light', count: 0 });
  });

  it('falls back when the stored value fails validation', () => {
    localStorage.setItem('ctbx:settings', JSON.stringify({ v: 1, d: { theme: 5 } }));
    expect(makeStore().get()).toEqual({ theme: 'light', count: 0 });
  });

  it('runs a migration when the stored version is older', () => {
    localStorage.setItem('ctbx:settings', JSON.stringify({ v: 1, d: { theme: 'dark' } }));
    const store = makeStore({
      version: 2,
      migrate: (previous) => ({ ...(previous as object), count: 42 }),
    });
    expect(store.get()).toEqual({ theme: 'dark', count: 42 });
  });

  it('falls back when a version differs and no migration exists', () => {
    localStorage.setItem('ctbx:settings', JSON.stringify({ v: 1, d: { theme: 'dark', count: 9 } }));
    expect(makeStore({ version: 2 }).get()).toEqual({ theme: 'light', count: 0 });
  });

  it('falls back when a migration throws', () => {
    localStorage.setItem('ctbx:settings', JSON.stringify({ v: 1, d: { theme: 'dark', count: 9 } }));
    const store = makeStore({
      version: 2,
      migrate: () => {
        throw new Error('bad migration');
      },
    });
    expect(store.get()).toEqual({ theme: 'light', count: 0 });
  });

  it('reads a pre-envelope value written by an older build', () => {
    localStorage.setItem('ctbx:settings', JSON.stringify({ theme: 'dark', count: 7 }));
    expect(makeStore().get()).toEqual({ theme: 'dark', count: 7 });
  });

  it('update() applies a function to the current value', () => {
    const store = makeStore();
    store.set({ theme: 'dark', count: 1 });
    expect(store.update((c) => ({ ...c, count: c.count + 1 }))).toEqual({
      theme: 'dark',
      count: 2,
    });
    expect(store.get().count).toBe(2);
  });

  it('remove() clears the key and reverts to the fallback', () => {
    const store = makeStore();
    store.set({ theme: 'dark', count: 1 });
    expect(store.exists()).toBe(true);
    store.remove();
    expect(store.exists()).toBe(false);
    expect(store.get()).toEqual({ theme: 'light', count: 0 });
  });

  it('notifies subscribers on set and remove, and stops after unsubscribe', () => {
    const store = makeStore();
    const seen: Settings[] = [];
    const off = store.subscribe((v) => seen.push(v));

    store.set({ theme: 'dark', count: 1 });
    store.remove();
    off();
    store.set({ theme: 'other', count: 2 });

    expect(seen).toEqual([
      { theme: 'dark', count: 1 },
      { theme: 'light', count: 0 },
    ]);
  });

  /**
   * useSyncExternalStore requires getSnapshot to be referentially stable
   * between changes. Returning a freshly parsed object on every read made the
   * MCP servers page render empty, so the contract is pinned here.
   */
  it('returns a referentially stable value between writes', () => {
    const store = makeStore();
    store.set({ theme: 'dark', count: 1 });

    const first = store.get();
    const second = store.get();

    expect(first).toBe(second);
  });

  it('returns a stable value for an unset store', () => {
    const store = makeStore();
    expect(store.get()).toBe(store.get());
  });

  it('returns a new reference after a write', () => {
    const store = makeStore();
    const before = store.get();
    store.set({ theme: 'dark', count: 1 });
    expect(store.get()).not.toBe(before);
  });

  it('returns a new reference after a remove', () => {
    const store = makeStore();
    store.set({ theme: 'dark', count: 1 });
    const before = store.get();
    store.remove();
    expect(store.get()).not.toBe(before);
  });

  it('picks up an external write to the same key', () => {
    const store = makeStore();
    store.set({ theme: 'dark', count: 1 });
    localStorage.setItem('ctbx:settings', JSON.stringify({ v: 1, d: { theme: 'x', count: 9 } }));
    expect(store.get()).toEqual({ theme: 'x', count: 9 });
  });

  it('keeps the value in memory when persistence fails (quota, private mode)', () => {
    const store = makeStore();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    store.set({ theme: 'dark', count: 5 });
    expect(store.get()).toEqual({ theme: 'dark', count: 5 });
  });
});

describe('storage transparency and clearing', () => {
  it('summarizes without exposing values', () => {
    const keys = defineStore<string>({
      name: 'provider-keys',
      version: 1,
      label: 'Provider API keys',
      secret: true,
      fallback: () => '',
      parse: (raw) => (typeof raw === 'string' ? raw : undefined),
    });
    makeStore().set({ theme: 'dark', count: 1 });
    keys.set('sk-super-secret-value');

    const summary = summarizeStorage();
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain('sk-super-secret-value');
    expect(summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'provider-keys', secret: true, present: true }),
        expect.objectContaining({ name: 'settings', secret: false, present: true }),
      ])
    );
    expect(summary.every((item) => item.bytes > 0)).toBe(true);
  });

  it('clearSecretStores() removes only credential stores', () => {
    const settings = makeStore();
    const keys = defineStore<string>({
      name: 'provider-keys',
      version: 1,
      label: 'Provider API keys',
      secret: true,
      fallback: () => '',
      parse: (raw) => (typeof raw === 'string' ? raw : undefined),
    });
    settings.set({ theme: 'dark', count: 1 });
    keys.set('sk-secret');

    clearSecretStores();

    expect(keys.exists()).toBe(false);
    expect(settings.exists()).toBe(true);
  });

  it('clearAllStores() removes everything declared', () => {
    const settings = makeStore();
    settings.set({ theme: 'dark', count: 1 });
    clearAllStores();
    expect(settings.exists()).toBe(false);
  });
});
