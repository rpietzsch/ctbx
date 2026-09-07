import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelInfo } from '@/providers/types';

/**
 * Where the picker lands when it opens. With several hundred models the list
 * is unusable if it always starts at the top: the row the reader wants is the
 * one already in use.
 */

function models(count: number): ModelInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `vendor/model-${index}`,
    label: `Model ${index}`,
    supportsTools: true,
  }));
}

/** What the stubbed provider lists; a test may make it longer than the cap. */
let listed: ModelInfo[] = models(12);

vi.mock('@/config/stores', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/stores')>();
  return {
    ...actual,
    // A configured provider without a key of any kind: the model list is stubbed.
    configuredProviders: () => [{ providerId: 'openrouter' as const, apiKey: 'x', enabled: true }],
  };
});

vi.mock('@/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/registry')>();
  return { ...actual, listModels: async () => ({ models: listed, source: 'cache' as const }) };
});

const { useChatStore } = await import('@/state/chat');
const { ModelPicker } = await import('./ModelPicker');

/** Opens the picker on the model in use, and reports what was scrolled to. */
async function openPicker(inUse = 'Model 9') {
  const scrolled: Element[] = [];
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
    scrolled.push(this);
  });
  render(<ModelPicker />);
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`${inUse}$`) }));
  return scrolled;
}

/** Puts `vendor/model-<index>` in use for the conversation on screen. */
function inUse(index: number) {
  useChatStore.setState({
    current: {
      id: 'c',
      title: 'Conversation',
      createdAt: 0,
      updatedAt: 0,
      providerId: 'openrouter',
      modelId: `vendor/model-${index}`,
      messages: [],
    },
  });
}

describe('ModelPicker', () => {
  beforeEach(() => {
    listed = models(12);
    inUse(9);
  });

  it('opens on the model in use rather than the top of the list', async () => {
    const scrolled = await openPicker();

    const inUse = screen.getByRole('option', { name: /Model 9/ });
    expect(inUse.className).toContain('bg-surface-3');
    expect(scrolled.at(-1)).toBe(inUse);
  });

  it('moves on from there with the arrow keys', async () => {
    await openPicker();

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /Model 10/ }).className).toContain('bg-surface-3');
    expect(screen.getByRole('option', { name: /Model 9/ }).className).not.toContain('bg-surface-3');
  });

  it('reaches a model past the row cap, which is where most of them are', async () => {
    // The reported case: OpenRouter lists hundreds, only the first hundred were
    // rendered, and the model in use was not among them — so the picker opened
    // on the head of the list with no row to land on.
    listed = models(200);
    inUse(150);

    const scrolled = await openPicker('Model 150');

    const row = screen.getByRole('option', { name: /Model 150/ });
    expect(row.className).toContain('bg-surface-3');
    expect(scrolled.at(-1)).toBe(row);
    // Everything past it is still held back until the reader searches.
    expect(screen.getByText(/49 more/)).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Model 151/ })).not.toBeInTheDocument();
  });

  it('lands on the best match once the reader searches', async () => {
    await openPicker();

    await userEvent.type(screen.getByLabelText('Search models'), 'model-3');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.className).toContain('bg-surface-3');
  });
});
