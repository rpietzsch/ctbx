import { useSyncExternalStore } from 'react';
import type { StoreHandle } from './local';

/**
 * Subscribes a component to a store.
 *
 * Relies on `StoreHandle.get()` being referentially stable between writes —
 * see the cache in `defineStore`. Without that, `useSyncExternalStore` sees a
 * new object on every render and gives up.
 */
export function useStore<T>(store: StoreHandle<T>): T {
  return useSyncExternalStore(
    (listener) => store.subscribe(() => listener()),
    () => store.get(),
    () => store.get()
  );
}
