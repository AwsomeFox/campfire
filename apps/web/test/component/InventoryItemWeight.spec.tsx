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

const { patchMock, formattingLocale } = vi.hoisted(() => ({
  patchMock: vi.fn(async (_path: string, _body?: unknown) => ({}) as unknown),
  // Mutable box read by the mocked useFormattingLocale below, so individual tests can force
  // a specific locale (issue #2179 review: the comma-decimal round-trip bug) without fighting
  // the real localeController singleton, whose supported UI languages (en/ar/pseudo) don't
  // include a comma-decimal one — the real production trigger is a comma-decimal SYSTEM
  // (browser) locale, which format.ts only surfaces through the `formatLocale` value this hook
  // returns, not through anything this test needs to drive via the UI.
  formattingLocale: { current: undefined as string | undefined },
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

vi.mock('../../src/lib/format', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/format')>();
  return {
    ...actual,
    useFormattingLocale: () => formattingLocale.current,
  };
});

afterEach(() => {
  cleanup();
  patchMock.mockReset();
  patchMock.mockResolvedValue({});
  formattingLocale.current = undefined;
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

describe('ItemRow weight round-trips correctly under a comma-decimal locale (issue #2179 review)', () => {
  // Regression for a real data-integrity bug: seeding/resetting the weight draft with plain
  // `String(committed.weight)` always emits an ASCII `.` decimal, but the draft is re-parsed
  // with the ACTIVE locale's separators. In a comma-decimal locale `.` reads as a GROUPING
  // character and is stripped before parsing, so `String(7.25)` silently round-tripped as the
  // digit run "725" — parsed as 725, not 7.25 — with no validation error and no visible sign
  // anything was wrong. A test that only runs under `en` cannot catch this: `en`'s decimal IS
  // `.`, so the corrupting collision between "the ASCII decimal `String()` emits" and "the
  // locale's grouping character" never occurs there. These tests force a real comma-decimal
  // `formatLocale` (de-DE) via the mocked `useFormattingLocale` above.

  test('seeding the draft from a committed weight is lossless — the input shows the LOCALE-correct value, not a bare ASCII string', () => {
    formattingLocale.current = 'de-DE';
    const item = baseItem({ id: 42, weight: 7.25 });
    render(
      <ItemRow item={item} editable characters={noCharacters} writableOwners={noWritableOwners} onChanged={() => {}} />,
    );
    const input = screen.getByTestId('inventory-item-weight-input') as HTMLInputElement;
    // The bug's specific shape: a naive `String(7.25)` seed would show "7.25" here — which
    // LOOKS fine, but is silently mis-parsed the moment the user blurs without typing anything,
    // because "." reads as a de-DE grouping character. The fix must show "7,25" instead.
    expect(input.value).toBe('7,25');
  });

  test('blurring an UNTOUCHED draft under a comma-decimal locale does NOT corrupt the value 100x — this is the actual bug', async () => {
    formattingLocale.current = 'de-DE';
    const item = baseItem({ id: 42, weight: 7.25 });
    render(
      <ItemRow item={item} editable characters={noCharacters} writableOwners={noWritableOwners} onChanged={() => {}} />,
    );
    const input = screen.getByTestId('inventory-item-weight-input') as HTMLInputElement;
    // No fireEvent.change — the user opens the row and blurs without editing anything, e.g. by
    // tabbing through the row. With the pre-fix `String(...)` seed, this silently PATCHed
    // { weight: 725 } (the digit run "725" parsed as an integer once "." was stripped as a
    // de-DE grouping separator) — not a validation error, a WRONG committed write.
    fireEvent.blur(input);
    // Give any (incorrect) patch a chance to fire before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(patchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('inventory-item-weight-error')).toBeNull();
  });

  test('editing to a new comma-decimal value PATCHes the correct numeric weight, not a 100x-corrupted one', async () => {
    formattingLocale.current = 'de-DE';
    const item = baseItem({ id: 42, weight: 1 });
    patchMock.mockResolvedValue({ ...item, weight: 8.5 });
    render(
      <ItemRow item={item} editable characters={noCharacters} writableOwners={noWritableOwners} onChanged={() => {}} />,
    );
    const input = screen.getByTestId('inventory-item-weight-input') as HTMLInputElement;
    // A de-DE user types the comma form, exactly as their own locale expects.
    fireEvent.change(input, { target: { value: '8,5' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/api/v1/inventory/42', { weight: 8.5 });
    });
    // The redisplayed draft after a successful commit must ALSO stay locale-correct — a
    // regression here would only surface on the NEXT untouched blur, so it is asserted
    // directly rather than trusted implicitly.
    expect(input.value).toBe('8,5');
  });
});
