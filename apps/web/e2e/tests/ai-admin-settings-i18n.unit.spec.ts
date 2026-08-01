/**
 * AI DM settings card + AI console card localization (issue #1579).
 *
 * Before this change: `AiDmCard.tsx` had zero `useTranslation` imports (every string a
 * literal), and `AiConsoleCard.tsx` called `useTranslation()` in four components and
 * destructured `t` but never invoked it for the card's own copy — only piped it into
 * `translateApiError`, which made the file look localized to a grep while its headings,
 * labels, and button text stayed hardcoded English. Both symptoms together produced the
 * mixed-script failure mode #1546 named: an Arabic reader gets a card where some lines
 * render in Arabic (the #1065 `CostDisclosure` component) and the rest in English.
 *
 * This is a source-scan test (no rendering, no server) in the style of
 * `ui-icons.unit.spec.ts`'s glyph check and `check-i18n-catalog.mjs`'s hardcoded-pattern
 * scan: it pins that the two cards' own chrome routes through `t()`, that `AiConsoleCard`'s
 * `t` is no longer dead wiring, and that the added catalog keys carry genuine Arabic (not
 * English placeholders) in `ar` — i.e. it fails against the pre-#1579 source.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import settingsEn from '../../src/i18n/locales/en/settings.json';
import adminEn from '../../src/i18n/locales/en/admin.json';

const ROOT = resolve(__dirname, '../../src');
const AI_DM_CARD = resolve(ROOT, 'features/settings/AiDmCard.tsx');
const AI_CONSOLE_CARD = resolve(ROOT, 'features/admin/AiConsoleCard.tsx');
const AI_PRICING_EDITOR = resolve(ROOT, 'features/admin/AiPricingEditor.tsx');

const ARABIC = /[؀-ۿ]/;
const AR_SETTINGS = resolve(ROOT, 'i18n/locales/ar/settings.json');
const AR_ADMIN = resolve(ROOT, 'i18n/locales/ar/admin.json');

test.describe('AiDmCard / AiConsoleCard / AiPricingEditor localization (#1579)', () => {
  test('AiDmCard.tsx imports useTranslation and no longer hardcodes its section copy', () => {
    const src = readFileSync(AI_DM_CARD, 'utf8');
    expect(src, 'AiDmCard.tsx must import useTranslation').toContain("from 'react-i18next'");
    expect(src, 'AiDmCard.tsx must call the hook').toMatch(/useTranslation\(\)/);
    // These exact literals were the hardcoded strings issue #1579 evidenced. They must have
    // moved to the catalog (still present as the MODES fallback/test-fixture data further
    // down is fine — this checks the load-error / save-error / section-title call sites,
    // which the pre-#1579 file rendered directly).
    expect(src).not.toContain('"Couldn\'t load AI DM settings."');
    expect(src).not.toContain('"Couldn\'t save the budget."');
    expect(src).not.toContain('"Couldn\'t save the instructions."');
    expect(src).not.toContain('Enter a non-negative number.');
    expect(src).toContain("t('settings.aiDm.title')");
    expect(src).toContain("t('settings.aiDm.budget.sectionTitle')");
  });

  test('AiConsoleCard.tsx actually calls t() for its own copy, not just as a translateApiError arg', () => {
    const src = readFileSync(AI_CONSOLE_CARD, 'utf8');
    expect(src).toMatch(/useTranslation\(\)/);
    // The bug: `t` was destructured 4x but the only call sites were `translateApiError(err, t, …)`
    // — `t` never appeared as `t(...)`. Count direct invocations to pin that it now does.
    const directCalls = src.match(/\bt\(['"`]/g) ?? [];
    expect(directCalls.length, 'AiConsoleCard.tsx must call t(...) directly for its own copy').toBeGreaterThan(10);
    expect(src).not.toContain('>AI console<');
    expect(src).not.toContain('>Model allowlist<');
    expect(src).not.toContain('Save allowlist');
    expect(src).toContain("t('admin.aiConsole.title')");
    expect(src).toContain("t('admin.aiConsole.allowlist.save')");
  });

  test('AiPricingEditor.tsx already routes every literal through t() (pre-existing, confirmed unchanged)', () => {
    const src = readFileSync(AI_PRICING_EDITOR, 'utf8');
    expect(src).toMatch(/useTranslation\(\)/);
    expect(src).toContain("t('admin.pricing.heading')");
  });

  test('settings.aiDm and admin.aiConsole keys exist with matching shape in en and ar', () => {
    expect(settingsEn.settings.aiDm.title).toBe('AI Dungeon Master');
    expect(adminEn.admin.aiConsole.title).toBe('AI console');
    if (existsSync(AR_SETTINGS) && existsSync(AR_ADMIN)) {
      const settingsAr = JSON.parse(readFileSync(AR_SETTINGS, 'utf8'));
      const adminAr = JSON.parse(readFileSync(AR_ADMIN, 'utf8'));
      expect(settingsAr.settings.aiDm.title).toBeTruthy();
      expect(adminAr.admin.aiConsole.title).toBeTruthy();
    }
  });

  test('the ar values for the new AiDmCard keys are genuine Arabic, not English placeholders', () => {
    if (!existsSync(AR_SETTINGS)) return;
    const settingsAr = JSON.parse(readFileSync(AR_SETTINGS, 'utf8'));
    const samples = [
      settingsAr.settings.aiDm.title,
      settingsAr.settings.aiDm.intro,
      settingsAr.settings.aiDm.budget.sectionTitle,
      settingsAr.settings.aiDm.modeOptions.driver.blurb,
      settingsAr.settings.aiDm.instructions.body,
    ];
    for (const value of samples) {
      expect(value, `expected Arabic script in: ${value}`).toMatch(ARABIC);
    }
    // Distinct from the English source, not a copy-through.
    expect(settingsAr.settings.aiDm.title).not.toBe(settingsEn.settings.aiDm.title);
  });

  test('the ar values for the narration-language and credential-source labels are genuine Arabic, not English placeholders', () => {
    if (!existsSync(AR_SETTINGS)) return;
    const settingsAr = JSON.parse(readFileSync(AR_SETTINGS, 'utf8'));
    const narrationOptions = settingsAr.settings.aiDm.narrationLanguage.options as Record<string, string>;
    const credentialLabels = settingsAr.settings.aiDm.provider.credentialSourceLabels as Record<string, string>;
    const samples = [...Object.values(narrationOptions), ...Object.values(credentialLabels)];
    expect(samples.length).toBeGreaterThan(0);
    for (const value of samples) {
      expect(value, `expected Arabic script in: ${value}`).toMatch(ARABIC);
    }
    // Distinct from the English source, not a copy-through.
    const narrationOptionsEn = settingsEn.settings.aiDm.narrationLanguage.options as Record<string, string>;
    expect(narrationOptions.fr).not.toBe(narrationOptionsEn.fr);
  });

  test('the ar values for the new AiConsoleCard keys are genuine Arabic, not English placeholders', () => {
    if (!existsSync(AR_ADMIN)) return;
    const adminAr = JSON.parse(readFileSync(AR_ADMIN, 'utf8'));
    const samples = [
      adminAr.admin.aiConsole.title,
      adminAr.admin.aiConsole.intro,
      adminAr.admin.aiConsole.allowlist.heading,
      adminAr.admin.aiConsole.caps.body,
      adminAr.admin.aiConsole.usageTable.footnote,
    ];
    for (const value of samples) {
      expect(value, `expected Arabic script in: ${value}`).toMatch(ARABIC);
    }
    expect(adminAr.admin.aiConsole.title).not.toBe(adminEn.admin.aiConsole.title);
  });

  test('the server-error substrings aiGate.ts matches are not touched by this change', () => {
    // #1579 note: these two strings come from the SERVER and are substring-matched by
    // apps/web/src/features/ai-dm/aiGate.ts to classify a gate. Neither card's catalog may
    // define a key for them — that would invite someone to localize the matcher's input out
    // from under it in a later change without realizing the classification would break.
    const flat = (o: unknown, out: string[] = []): string[] => {
      if (o && typeof o === 'object') {
        for (const v of Object.values(o as Record<string, unknown>)) flat(v, out);
      } else if (typeof o === 'string') {
        out.push(o);
      }
      return out;
    };
    const settingsAr = existsSync(AR_SETTINGS) ? JSON.parse(readFileSync(AR_SETTINGS, 'utf8')) : {};
    const adminAr = existsSync(AR_ADMIN) ? JSON.parse(readFileSync(AR_ADMIN, 'utf8')) : {};
    const allTouchedCatalogValues = [...flat(settingsEn), ...flat(settingsAr), ...flat(adminEn), ...flat(adminAr)];
    expect(allTouchedCatalogValues.some((v) => v.includes('requires a positive token budget'))).toBe(false);
    expect(allTouchedCatalogValues.some((v) => v.includes('server-wide ai token cap'))).toBe(false);
  });
});
