/**
 * Detail-page wayfinding contracts (issue #652).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DETAIL_PAGES = [
  '../../src/features/characters/CharacterPage.tsx',
  '../../src/features/quests/QuestPage.tsx',
  '../../src/features/npcs/NpcPage.tsx',
  '../../src/features/factions/FactionPage.tsx',
  '../../src/features/locations/LocationPage.tsx',
  '../../src/features/encounters/RunSessionPage.tsx',
] as const;

test.describe('detail page wayfinding (issue #652)', () => {
  for (const relativePath of DETAIL_PAGES) {
    const file = resolve(__dirname, relativePath);
    test(`${relativePath.split('/').pop()} uses shared DetailPageWayfinding`, () => {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('DetailPageWayfinding');
      expect(source).not.toMatch(/← Back\s*['"`]/);
      expect(source).not.toMatch(/navigate\(-1\).*back/i);
    });
  }

  test('shared component uses an explicit Link instead of history back', () => {
    const source = readFileSync(resolve(__dirname, '../../src/components/DetailPageWayfinding.tsx'), 'utf8');
    expect(source).toContain('resolveDetailReturnTarget');
    expect(source).toContain('<Link');
    expect(source).not.toMatch(/^\s+navigate\(-1\)/m);
  });
});
