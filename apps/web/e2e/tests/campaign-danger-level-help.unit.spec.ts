import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Issue #871 — campaign-wide `dangerLevel` was displayed beside live encounter/
 * session/location state with no explanation, so users could not tell whether it
 * meant campaign tone, current threat, encounter difficulty, or content/safety
 * severity. This spec pins the three separate things the fix promises:
 *
 *   1. the glossary entry actually states the definition (object/timeframe/
 *      audience/owner/consequence) and names the three things it is NOT,
 *   2. both surfaces a reader actually sees — the shared field group (dashboard
 *      quick edit + Settings) and the dashboard's read-only chip — render the
 *      renamed label/copy and a reachable contextual-help trigger, not just the
 *      locale catalog in isolation,
 *   3. the Arabic catalog carries a real translation for the new copy, not an
 *      English passthrough.
 */

const ROOT = resolve(__dirname, '../..');
const TERMS = resolve(ROOT, 'src/features/glossary/glossaryTerms.ts');
const EN = resolve(ROOT, 'src/i18n/locales/en/glossary.json');
const AR = resolve(ROOT, 'src/i18n/locales/ar/glossary.json');
const METADATA_FIELDS = resolve(ROOT, 'src/components/CampaignMetadataFields.tsx');
const STATUS_HEADER = resolve(ROOT, 'src/features/dashboard/StatusHeader.tsx');
const SCHEMA_INDEX = resolve(ROOT, '../../packages/schema/src/index.ts');

type GlossaryCatalog = {
  glossary: { terms: Record<string, { label: string; short: string; definition: string }> };
};

function loadCatalog(path: string): GlossaryCatalog {
  return JSON.parse(readFileSync(path, 'utf8')) as GlossaryCatalog;
}

test.describe('campaign danger level contextual help (#871)', () => {
  test('the glossary definition names object/timeframe/owner and the three things it is not', () => {
    const en = loadCatalog(EN);
    const term = en.glossary.terms.dangerLevel;
    expect(term, 'en glossary.terms.dangerLevel').toBeTruthy();
    expect(term.label).toBe('Campaign danger level');
    // Object + timeframe: the whole campaign, persistent until the DM changes it —
    // not a single scene/session/encounter's live state.
    expect(term.definition).toMatch(/whole campaign/i);
    expect(term.definition).toMatch(/DM-set|DM changes/i);
    // Explicitly distinguished from the three things named in the issue.
    expect(term.definition).toMatch(/encounter difficulty/i);
    expect(term.definition).toMatch(/HP band/i);
    expect(term.definition).toMatch(/Session Zero/i);
  });

  test('English and Arabic glossary entries exist and Arabic is a real translation, not a passthrough', () => {
    const en = loadCatalog(EN);
    const ar = loadCatalog(AR);
    const enTerm = en.glossary.terms.dangerLevel;
    const arTerm = ar.glossary.terms.dangerLevel;
    expect(arTerm, 'ar glossary.terms.dangerLevel').toBeTruthy();
    expect(arTerm.label).toBeTruthy();
    expect(arTerm.short).toBeTruthy();
    expect(arTerm.definition).toBeTruthy();
    // Not an English passthrough: real Arabic text, and none of the three fields
    // are byte-identical to their English counterpart.
    expect(arTerm.label).not.toBe(enTerm.label);
    expect(arTerm.short).not.toBe(enTerm.short);
    expect(arTerm.definition).not.toBe(enTerm.definition);
    const arabicPattern = /[؀-ۿ]/;
    expect(arTerm.label).toMatch(arabicPattern);
    expect(arTerm.short).toMatch(arabicPattern);
    expect(arTerm.definition).toMatch(arabicPattern);
  });

  test('glossaryTerms.ts registers dangerLevel with full metadata and an "everyone" audience', () => {
    const source = readFileSync(TERMS, 'utf8');
    expect(source).toMatch(/'dangerLevel'/);
    expect(source).toMatch(/dangerLevel:\s*\{[\s\S]*?labelKey:\s*'glossary\.terms\.dangerLevel\.label'/);
    expect(source).toMatch(/dangerLevel:\s*\{[\s\S]*?audienceKey:\s*'glossary\.audience\.all'/);
  });

  test('the shared metadata field group (dashboard + Settings) renders the renamed label and its help trigger', () => {
    // Trap: asserting only the locale catalog would stay green even if this component
    // kept shipping the old "Danger level" copy or dropped the TermHelp trigger — the
    // reader sees this file's JSX, not the JSON in isolation (PR #1981 regression).
    const source = readFileSync(METADATA_FIELDS, 'utf8');
    expect(source).toMatch(/<label htmlFor=\{dangerId\}>Campaign danger level<\/label>/);
    expect(source).toMatch(/<TermHelp termId="dangerLevel"\s*\/>/);
    expect(source).not.toMatch(/<label htmlFor=\{dangerId\}>Danger level<\/label>/);
  });

  test('the dashboard read-only chip names campaign scope and carries a help trigger', () => {
    const source = readFileSync(STATUS_HEADER, 'utf8');
    expect(source).toMatch(/Campaign danger · \{DANGER_LABEL\[campaign\.dangerLevel\]\}/);
    expect(source).toMatch(/<TermHelp termId="dangerLevel"\s*\/>/);
    // Regression guard: the old ambiguous "{level} danger" chip text is gone.
    expect(source).not.toMatch(/\{DANGER_LABEL\[campaign\.dangerLevel\]\}\s*danger\s*</);
  });

  test('the schema field documents the same object/timeframe/audience/owner/consequence definition', () => {
    const source = readFileSync(SCHEMA_INDEX, 'utf8');
    expect(source).toMatch(/Issue #871: campaign danger level, defined/);
    expect(source).toMatch(/Object:/);
    expect(source).toMatch(/Timeframe:/);
    expect(source).toMatch(/Audience:/);
    expect(source).toMatch(/Owner:/);
    expect(source).toMatch(/Consequence:/);
  });
});
