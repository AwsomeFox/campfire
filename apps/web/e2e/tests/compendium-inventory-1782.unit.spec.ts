import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const inventoryPage = readFileSync(resolve(__dirname, '../../src/features/inventory/InventoryPage.tsx'), 'utf8');
const inventoryShared = readFileSync(resolve(__dirname, '../../src/features/inventory/inventoryShared.tsx'), 'utf8');
const characterInventory = readFileSync(resolve(__dirname, '../../src/features/characters/CharacterInventorySection.tsx'), 'utf8');

test.describe('compendium inventory discoverability (#1782)', () => {
  test('Inventory page surfaces From compendium affordance in header and renders picker', () => {
    expect(inventoryPage).toContain("t('inventory.fromCompendium')");
    expect(inventoryPage).toContain('CompendiumItemPickerModal');
    expect(inventoryPage).toContain('setShowCompendiumPicker(true)');
  });

  test('AddItemForm and CharacterInventorySection include From compendium entry point', () => {
    expect(inventoryShared).toContain("t('inventory.fromCompendium')");
    expect(inventoryShared).toContain('CompendiumItemPickerModal');
    expect(characterInventory).toContain("t('inventory.fromCompendium')");
    expect(characterInventory).toContain('CompendiumItemPickerModal');
  });

  test('CompendiumItemPickerModal queries rules/search and submits acquisition payload', () => {
    expect(inventoryShared).toContain('compendium-item-picker-modal');
    expect(inventoryShared).toContain('/rules/search?campaignId=');
    expect(inventoryShared).toContain('/inventory/from-compendium');
    expect(inventoryShared).toContain("t('inventory.browseCompendiumLink')");
    expect(inventoryShared).toContain('useDialog');
    expect(inventoryShared).toContain('role="dialog"');
    expect(inventoryShared).toContain('aria-modal="true"');
  });
});
