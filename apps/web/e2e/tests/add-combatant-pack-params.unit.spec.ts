import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const panel = readFileSync(
  resolve(__dirname, '../../src/features/encounters/combat/AddCombatantPanel.tsx'),
  'utf8',
);

test('AddCombatantPanel sends compatible packs as repeated delimiter-safe parameters', () => {
  expect(panel).toContain("baseParams.append('pack', slug)");
  expect(panel).not.toContain("baseParams.set('packs', compatiblePackSlugs.join(','))");
});
