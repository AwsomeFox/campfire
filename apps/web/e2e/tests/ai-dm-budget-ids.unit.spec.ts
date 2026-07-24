/**
 * Issue #751 — AI settings Budget section must not share a DOM id with its input.
 *
 * Deep links (aiGate / AiSetupChecklist) target `#ai-dm-budget` as a section
 * anchor. The token-budget <input> needs its own id so <label htmlFor> and
 * document.getElementById(hash) stay unambiguous.
 *
 * Pure unit coverage via pw-unit (no seeded server / browser matrix): pins the
 * dedicated ids module and checks AiDmCard wires those constants — runtime DOM
 * uniqueness stays in the companion e2e spec.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AI_DM_BUDGET_INPUT_ID,
  AI_DM_BUDGET_SECTION_ID,
} from '../../src/features/settings/aiDmBudgetIds';
import { decodeLocationHashId } from '../../src/lib/decodeLocationHashId';

const IDS_MODULE = resolve(__dirname, '../../src/features/settings/aiDmBudgetIds.ts');
const AI_DM_CARD = resolve(__dirname, '../../src/features/settings/AiDmCard.tsx');

test.describe('AI DM budget DOM ids (#751)', () => {
  test('keeps the section anchor and input id distinct', () => {
    expect(AI_DM_BUDGET_SECTION_ID).toBe('ai-dm-budget');
    expect(AI_DM_BUDGET_INPUT_ID).toBe('ai-dm-budget-input');
    expect(AI_DM_BUDGET_SECTION_ID).not.toBe(AI_DM_BUDGET_INPUT_ID);
  });

  test('ids module owns each string literal once', () => {
    const src = readFileSync(IDS_MODULE, 'utf8');
    expect(src.match(/=\s*['"]ai-dm-budget['"]/g)?.length ?? 0).toBe(1);
    expect(src.match(/=\s*['"]ai-dm-budget-input['"]/g)?.length ?? 0).toBe(1);
  });

  test('AiDmCard wires shared constants (no duplicate string ids)', () => {
    const src = readFileSync(AI_DM_CARD, 'utf8');
    expect(src).toMatch(/from\s+['"]\.\/aiDmBudgetIds['"]/);
    expect(src).toMatch(/id\s*=\s*\{\s*AI_DM_BUDGET_SECTION_ID\s*\}/);
    expect(src).toMatch(/id\s*=\s*\{\s*AI_DM_BUDGET_INPUT_ID\s*\}/);
    expect(src).toMatch(/htmlFor\s*=\s*\{\s*AI_DM_BUDGET_INPUT_ID\s*\}/);
    expect(src.match(/id=["']ai-dm-budget["']/g) ?? []).toHaveLength(0);
    expect(src.match(/id=["']ai-dm-budget-input["']/g) ?? []).toHaveLength(0);
    expect(src.match(/=\s*['"]ai-dm-budget['"]/g) ?? []).toHaveLength(0);
    expect(src.match(/=\s*['"]ai-dm-budget-input['"]/g) ?? []).toHaveLength(0);
  });

  test('decodeLocationHashId falls back when percent-encoding is malformed', () => {
    expect(decodeLocationHashId('#ai-dm-budget')).toBe('ai-dm-budget');
    expect(decodeLocationHashId('#ai-dm-%20budget')).toBe('ai-dm- budget');
    expect(decodeLocationHashId('#ai-dm-%')).toBe('ai-dm-%');
    expect(decodeLocationHashId('#ai-dm-%GG')).toBe('ai-dm-%GG');
  });
});
