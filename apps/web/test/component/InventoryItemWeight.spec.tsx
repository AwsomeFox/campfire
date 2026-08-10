/**
 * Component-render coverage for issue #2157's `InventoryItem.weight` field: `ItemSection`
 * sums per-item weight*qty into a section total, and `ItemRow` both displays a read-only
 * item's weight and lets an editable row commit a new one via the inline weight input.
 *
 * A source-scan test could confirm `weight` is read and multiplied somewhere; it cannot
 * confirm the total actually reaches the DOM, that a non-editable row shows the display
 * text instead of the input, or that blurring the input actually issues the PATCH with the
 * parsed value. This test renders the real components and asserts on the rendered output
 * and the mocked API call.
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import type { InventoryItem, PartyCharacter, Character } from '@campfire/schema';
import '../../src/i18n';
import { ItemSection, ItemRow } from '../../src/features/inventory/inventoryShared';

const { patchMock } = vi.hoisted(() => ({
  patchMock: vi.fn(async (_path: string, _body?: unknown) => ({}) as unknown),
}));

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      patch: patchMock,
    },
  };
});

afterEach(() => {
  cleanup();
  patchMock.mockReset();
  patchMock.mockResolvedValue({});
});

function baseItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 1,
    campaignId: 1,
    ownerType: 'party',
    characterId: null,
    name: 'Rope (50 ft)',
    qty: 1,
    notes: '',
    iconSlug: '',
    ruleEntryId: null,
    compendiumRef: null,
    compendiumSnapshot: null,
    compendiumState: null,
    equipped: false,
    equipSlot: null,
    equippedAction: null,
    equippedActionSource: null,
    weight: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

const noCharacters: Pick<PartyCharacter, 'id' | 'name'>[] = [];
const noWritableOwners: Character[] = [];

describe('ItemSection weight total (issue #2157)', () => {
  test('sums weight*qty across the section and renders it next to the title', () => {
    const items = [baseItem({ id: 1, name: 'Rope', weight: 2, qty: 1 }), baseItem({ id: 2, name: 'Rations', weight: 0.5, qty: 6 })];
    render(
      <ItemSection
        title="Party stash"
        icon="backpack"
        items={items}
        characters={noCharacters}
        writableOwners={noWritableOwners}
        canEditItem={() => false}
        onChanged={() => {}}
        partyStashTitle="Party stash"
      />,
    );
    // 2*1 + 0.5*6 = 5
    const total = screen.getByTestId('inventory-section-weight');
    expect(total.textContent).toContain('5');
  });

  test('omits the weight total entirely when every item in the section is unweighed', () => {
    const items = [baseItem({ id: 1, name: 'Rope', weight: 0, qty: 3 })];
    render(
      <ItemSection
        title="Party stash"
        icon="backpack"
        items={items}
        characters={noCharacters}
        writableOwners={noWritableOwners}
        canEditItem={() => false}
        onChanged={() => {}}
        partyStashTitle="Party stash"
      />,
    );
    expect(screen.queryByTestId('inventory-section-weight')).toBeNull();
  });
});

describe('ItemRow weight display and edit (issue #2157)', () => {
  test('a non-editable row shows the read-only weight display, not an input', () => {
    const item = baseItem({ weight: 3.5 });
    render(
      <ItemRow item={item} editable={false} characters={noCharacters} writableOwners={noWritableOwners} onChanged={() => {}} />,
    );
    expect(screen.getByTestId('inventory-item-weight-display').textContent).toContain('3.5');
    expect(screen.queryByTestId('inventory-item-weight-input')).toBeNull();
  });

  test('a non-editable, unweighed row shows no weight text at all', () => {
    const item = baseItem({ weight: 0 });
    render(
      <ItemRow item={item} editable={false} characters={noCharacters} writableOwners={noWritableOwners} onChanged={() => {}} />,
    );
    expect(screen.queryByTestId('inventory-item-weight-display')).toBeNull();
  });

  test('an editable row commits a new weight on blur via PATCH', async () => {
    const item = baseItem({ id: 42, weight: 1 });
    patchMock.mockResolvedValue({ ...item, weight: 7.25 });
    render(
      <ItemRow item={item} editable characters={noCharacters} writableOwners={noWritableOwners} onChanged={() => {}} />,
    );
    const input = screen.getByTestId('inventory-item-weight-input') as HTMLInputElement;
    expect(input.value).toBe('1');
    fireEvent.change(input, { target: { value: '7.25' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/api/v1/inventory/42', { weight: 7.25 });
    });
  });

  test('blurring with no actual change does not issue a PATCH', async () => {
    const item = baseItem({ id: 42, weight: 1 });
    render(
      <ItemRow item={item} editable characters={noCharacters} writableOwners={noWritableOwners} onChanged={() => {}} />,
    );
    const input = screen.getByTestId('inventory-item-weight-input') as HTMLInputElement;
    fireEvent.blur(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(patchMock).not.toHaveBeenCalled();
  });

  test('an invalid weight shows an inline error instead of patching', async () => {
    const item = baseItem({ id: 42, weight: 1 });
    render(
      <ItemRow item={item} editable characters={noCharacters} writableOwners={noWritableOwners} onChanged={() => {}} />,
    );
    const input = screen.getByTestId('inventory-item-weight-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'not a number' } });
    fireEvent.blur(input);
    expect(await screen.findByTestId('inventory-item-weight-error')).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();
  });
});
