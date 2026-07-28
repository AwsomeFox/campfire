import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const reader = readFileSync(resolve(__dirname, '../../src/features/compendium/ReaderPage.tsx'), 'utf8');
const inventory = readFileSync(resolve(__dirname, '../../src/features/inventory/inventoryShared.tsx'), 'utf8');

test.describe('compendium inventory UI (#738)', () => {
  test('Reader sends the acquisition payload and presents duplicate resolution', () => {
    expect(reader).toContain('/inventory/from-compendium');
    expect(reader).toContain('ruleEntryId: entry.id');
    expect(reader).toContain("duplicateMode: 'confirm'");
    expect(reader).toContain("acquire('increment')");
    expect(reader).toContain("acquire('separate')");
  });

  test('inventory renders provenance, play-safe details, and link actions', () => {
    expect(inventory).toContain('data-testid="compendium-inventory-source"');
    expect(inventory).toContain('committed.compendiumSnapshot.body');
    expect(inventory).toContain('Open in Compendium');
    expect(inventory).toContain('committed.ruleEntryId != null');
    expect(inventory).toContain("compendiumAction('refresh')");
    expect(inventory).toContain("compendiumAction('overridden')");
    expect(inventory).toContain("compendiumAction('detached')");
  });
});
