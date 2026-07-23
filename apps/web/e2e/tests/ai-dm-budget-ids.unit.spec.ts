/**
 * Issue #751 — AI settings Budget section must not share a DOM id with its input.
 *
 * Deep links (aiGate / AiSetupChecklist) target `#ai-dm-budget` as a section
 * anchor. The token-budget <input> needs its own id so <label htmlFor> and
 * document.getElementById(hash) stay unambiguous.
 *
 * Pure unit coverage (no seeded server): pins the exported ids and scans the
 * AiDmCard source so a second `id="ai-dm-budget"` cannot slip back in.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AI_DM_BUDGET_INPUT_ID,
  AI_DM_BUDGET_SECTION_ID,
} from '../../src/features/settings/AiDmCard';

const AI_DM_CARD = resolve(__dirname, '../../src/features/settings/AiDmCard.tsx');

test.describe('AI DM budget DOM ids (#751)', () => {
  test('keeps the section anchor and input id distinct', () => {
    expect(AI_DM_BUDGET_SECTION_ID).toBe('ai-dm-budget');
    expect(AI_DM_BUDGET_INPUT_ID).toBe('ai-dm-budget-input');
    expect(AI_DM_BUDGET_SECTION_ID).not.toBe(AI_DM_BUDGET_INPUT_ID);
  });

  test('AiDmCard source never assigns ai-dm-budget to more than one id=', () => {
    const src = readFileSync(AI_DM_CARD, 'utf8');
    // Match both id="…" literals and id={CONST} after inlining the section constant.
    const sectionLiteralMatches = src.match(/id=["']ai-dm-budget["']/g) ?? [];
    const inputLiteralMatches = src.match(/id=["']ai-dm-budget-input["']/g) ?? [];
    // Section + input must be referenced via the distinct exported constants.
    expect(src).toContain('id={AI_DM_BUDGET_SECTION_ID}');
    expect(src).toContain('id={AI_DM_BUDGET_INPUT_ID}');
    expect(src).toContain('htmlFor={AI_DM_BUDGET_INPUT_ID}');
    // No leftover duplicate string ids.
    expect(sectionLiteralMatches).toHaveLength(0);
    expect(inputLiteralMatches).toHaveLength(0);
    // And the two constant values themselves stay unique in the file.
    expect(src.match(/=\s*['"]ai-dm-budget['"]/g)?.length ?? 0).toBe(1);
    expect(src.match(/=\s*['"]ai-dm-budget-input['"]/g)?.length ?? 0).toBe(1);
  });
});
