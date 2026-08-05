/**
 * Issue #874 — Simplify / Recap / Repeat turn cue / Explain quick actions on the AI table
 * composer. This is the issue's title constraint made concrete in the UI: these are SHORTCUTS
 * into the same freeform field, never a replacement for it.
 *
 * Pure unit coverage via pw-unit (no seeded server / browser matrix), following the existing
 * source-inspection convention this repo uses for these settings/table wiring specs (see
 * ai-dm-budget-ids.unit.spec.ts). What matters here is regression-proofing the SHAPE of the
 * feature: a button that starts auto-submitting, or a composer that starts disabling free
 * typing once a quick action is clicked, would silently turn this into the menu-only
 * composer the issue explicitly rejects — this spec is written to fail if either happens.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import en from '../../src/i18n/locales/en/table.json';
import ar from '../../src/i18n/locales/ar/table.json';

const AI_TABLE_PAGE = resolve(__dirname, '../../src/features/ai-dm/AiTablePage.tsx');
const ACTIONS = ['simplify', 'recap', 'repeatCue', 'explain'] as const;

test.describe('AI table quick actions (#874) — shortcuts into freeform, never a replacement', () => {
  test('every quick action button is type="button", not "submit"', () => {
    const src = readFileSync(AI_TABLE_PAGE, 'utf8');
    const block = src.slice(src.indexOf('#874'), src.indexOf('</form>'));
    // The quick-actions block must appear before the closing </form>, and every <button> inside
    // it must be explicitly type="button" — a bare <button> defaults to type="submit" inside a
    // <form>, which would let a click send the turn immediately, bypassing the Send button and
    // any edit the player might still want to make.
    expect(block).toContain("role=\"group\"");
    const buttonMatches = [...block.matchAll(/<button\b[^>]*>/g)];
    expect(buttonMatches.length).toBeGreaterThan(0);
    for (const match of buttonMatches) {
      expect(match[0]).toMatch(/type="button"/);
    }
  });

  test('a quick action only fills the composer text — it never calls onSubmit directly', () => {
    const src = readFileSync(AI_TABLE_PAGE, 'utf8');
    const block = src.slice(src.indexOf('#874'), src.indexOf('</form>'));
    // The click handler must be exactly "set the input", with nothing that also triggers a
    // submit — the player still reviews/edits/sends via the ordinary composer flow.
    expect(block).toMatch(/onClick=\{\(\)\s*=>\s*setInput\(/);
    expect(block).not.toMatch(/onClick=\{[^}]*onSubmit/);
    expect(block).not.toMatch(/onClick=\{[^}]*\.submit\(/);
  });

  test('the composer textarea underneath is still plain freeform state — value/onChange untouched', () => {
    const src = readFileSync(AI_TABLE_PAGE, 'utf8');
    // Same `input`/`setInput` pair the quick actions write into — one shared field, not a
    // separate "locked" state that quick actions could freeze after use.
    expect(src).toMatch(/value=\{input\}/);
    expect(src).toMatch(/onChange=\{\(e\)\s*=>\s*setInput\(e\.target\.value\)\}/);
  });

  test('the Send button stays the only submit control, gated on non-empty freeform text', () => {
    const src = readFileSync(AI_TABLE_PAGE, 'utf8');
    expect(src).toMatch(/<Btn type="submit" disabled=\{locked \|\| submitting \|\| !input\.trim\(\)\}>/);
  });

  test('every quick action has both a button-label key and a canned-text key in en AND ar', () => {
    for (const action of ACTIONS) {
      for (const catalog of [en, ar] as const) {
        expect(catalog.table.quickActions).toHaveProperty(action);
        expect(catalog.table.quickActions).toHaveProperty(`${action}Text`);
        expect(typeof catalog.table.quickActions[action as keyof typeof catalog.table.quickActions]).toBe('string');
      }
    }
  });

  test('AiTablePage requests the quick-action keys through the same derived pattern the catalog defines', () => {
    const src = readFileSync(AI_TABLE_PAGE, 'utf8');
    // The four action names are iterated, not hand-typed per key — this pins the DERIVATION
    // (`${action}` / `${action}Text`) so the literal keys checked in the catalog test above stay
    // reachable from the component rather than merely coexisting with it by coincidence.
    expect(src).toMatch(/\['simplify',\s*'recap',\s*'repeatCue',\s*'explain'\]/);
    expect(src).toMatch(/t\(`table\.quickActions\.\$\{action\}Text`\)/);
    expect(src).toMatch(/t\(`table\.quickActions\.\$\{action\}`\)/);
    expect(src).toMatch(/t\('table\.quickActions\.groupLabel'\)/);
  });
});
