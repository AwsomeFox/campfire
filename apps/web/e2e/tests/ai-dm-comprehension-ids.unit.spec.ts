/**
 * Issue #874 — AI settings Comprehension profile section, following the #751 budget-ids
 * pattern this mirrors: a dedicated ids module keeps the section anchor and each per-axis
 * <select> id distinct, and AiDmCard must wire those shared constants rather than restating
 * the string literals inline (which is how a future edit could silently reintroduce a
 * duplicate DOM id).
 *
 * Pure unit coverage via pw-unit (no seeded server / browser matrix): pins the ids module and
 * checks AiDmCard's wiring by source inspection.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AI_DM_COMPREHENSION_SECTION_ID,
  aiDmComprehensionSelectId,
} from '../../src/features/settings/aiDmComprehensionIds';

const IDS_MODULE = resolve(__dirname, '../../src/features/settings/aiDmComprehensionIds.ts');
const AI_DM_CARD = resolve(__dirname, '../../src/features/settings/AiDmCard.tsx');

test.describe('AI DM comprehension profile DOM ids (#874)', () => {
  test('the section anchor and every per-axis select id are distinct', () => {
    expect(AI_DM_COMPREHENSION_SECTION_ID).toBe('ai-dm-comprehension');
    const axes = ['readingComplexity', 'paragraphLength', 'sensoryIntensity', 'choiceCount'];
    const selectIds = axes.map(aiDmComprehensionSelectId);
    expect(new Set([AI_DM_COMPREHENSION_SECTION_ID, ...selectIds]).size).toBe(selectIds.length + 1);
    // Distinct from the #1049 table-style section too — the two must never collide.
    expect(AI_DM_COMPREHENSION_SECTION_ID).not.toBe('ai-dm-style');
  });

  test('ids module owns the section-anchor string literal once', () => {
    const src = readFileSync(IDS_MODULE, 'utf8');
    expect(src.match(/=\s*['"]ai-dm-comprehension['"]/g)?.length ?? 0).toBe(1);
  });

  test('AiDmCard wires the shared constants (no duplicate string ids)', () => {
    const src = readFileSync(AI_DM_CARD, 'utf8');
    expect(src).toMatch(/from\s+['"]\.\/aiDmComprehensionIds['"]/);
    expect(src).toMatch(/id\s*=\s*\{\s*AI_DM_COMPREHENSION_SECTION_ID\s*\}/);
    expect(src).toMatch(/aiDmComprehensionSelectId\(axis\.key\)/);
    expect(src.match(/id=["']ai-dm-comprehension["']/g) ?? []).toHaveLength(0);
    expect(src.match(/=\s*['"]ai-dm-comprehension['"]/g) ?? []).toHaveLength(0);
  });

  test('the settings deep-link registry recognises the new section hash', () => {
    const nav = readFileSync(resolve(__dirname, '../../src/features/settings/settingsNavigation.ts'), 'utf8');
    expect(nav).toMatch(/'ai-dm-comprehension':\s*'ai'/);
  });
});
