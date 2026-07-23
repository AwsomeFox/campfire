/**
 * Issue #751 — AI budget section vs token-budget input must not share a DOM id.
 *
 * Deep links from the onboarding checklist / gate explainers target `#ai-dm-budget`
 * (the section anchor). The number input needs its own id so `<label htmlFor>` and
 * hash navigation are unambiguous. This unit suite pins the source contract without
 * needing a seeded backend.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AI_DM_CARD = resolve(__dirname, '../../src/features/settings/AiDmCard.tsx');
const SECTION_ANCHOR = 'ai-dm-budget';
const INPUT_ID = 'ai-dm-token-budget';

test.describe('AI DM budget DOM ids (issue #751)', () => {
  const source = readFileSync(AI_DM_CARD, 'utf8');

  test('keeps the section hash anchor distinct from the token-budget input id', () => {
    expect(source).toMatch(/<Section\s+title="Budget & usage"\s+id="ai-dm-budget"/);
    expect(source).toMatch(/id="ai-dm-token-budget"/);
    expect(source).not.toMatch(/<input[^>]*\bid="ai-dm-budget"/);
    expect(SECTION_ANCHOR).not.toBe(INPUT_ID);
  });

  test('points the Token budget label at the distinct input id', () => {
    expect(source).toMatch(/<label\s+htmlFor="ai-dm-token-budget">\s*Token budget\s*<\/label>/);
    // The legacy shared id must not remain on the label either.
    expect(source).not.toMatch(/htmlFor="ai-dm-budget"/);
  });

  test('declares the budget section id only on the Section anchor', () => {
    // Strip comments so prose mentioning the hash target does not count as a DOM id.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const idOccurrences = code.match(/\bid=["']ai-dm-budget["']/g) ?? [];
    expect(idOccurrences).toHaveLength(1);
    expect(code).toMatch(/<Section\s+title="Budget & usage"\s+id="ai-dm-budget"/);
  });
});

