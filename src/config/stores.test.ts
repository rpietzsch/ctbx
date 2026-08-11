import { beforeEach, describe, expect, it } from 'vitest';
import { preferencesStore } from './stores';
import { DEFAULT_PREFERENCES } from './schema';
import { storageKeyFor } from '@/storage/local';

/**
 * The v1 → v2 preferences migration.
 *
 * Worth pinning because its failure mode is silence: raising the schema default
 * looks like it works on a fresh profile and does nothing at all on an existing
 * one, where the old value is already on disk.
 */
function writeV1(preferences: Record<string, unknown>) {
  localStorage.setItem(storageKeyFor('preferences'), JSON.stringify({ v: 1, d: preferences }));
}

const V1_PREFERENCES = {
  maxSteps: 10,
  toolApproval: 'always',
  alwaysAllowedTools: ['srv:query'],
  sendOnEnter: true,
};

beforeEach(() => {
  localStorage.clear();
});

describe('preferences maxSteps', () => {
  it('defaults to 30 for a fresh install', () => {
    expect(DEFAULT_PREFERENCES.maxSteps).toBe(30);
    expect(preferencesStore.get().maxSteps).toBe(30);
  });

  it('raises the old default on an existing install', () => {
    writeV1(V1_PREFERENCES);
    expect(preferencesStore.get().maxSteps).toBe(30);
  });

  it('keeps every other stored preference across the migration', () => {
    writeV1(V1_PREFERENCES);
    const preferences = preferencesStore.get();
    expect(preferences.alwaysAllowedTools).toEqual(['srv:query']);
    expect(preferences.toolApproval).toBe('always');
  });

  /** A value that is not the old default was set deliberately. */
  it('leaves a hand-set value alone', () => {
    writeV1({ ...V1_PREFERENCES, maxSteps: 3 });
    expect(preferencesStore.get().maxSteps).toBe(3);
  });

  it('fills in a preference added after v1 was written', () => {
    writeV1(V1_PREFERENCES);
    expect(preferencesStore.get().alwaysAllowedToolCategories).toEqual([]);
  });

  it('survives a malformed v1 payload by falling back', () => {
    localStorage.setItem(storageKeyFor('preferences'), JSON.stringify({ v: 1, d: 'nonsense' }));
    expect(preferencesStore.get().maxSteps).toBe(30);
  });
});
