import { describe, it, expect } from '@jest/globals';
import {
  buildNarrationLanguageContract,
  resolveNarrationLanguage,
} from '@campfire/schema';

describe('narration language contract (#635)', () => {
  it('defaults to English from the campaign when no override is provided', () => {
    expect(resolveNarrationLanguage(undefined)).toEqual({ language: 'en', provenance: 'campaign' });
    expect(resolveNarrationLanguage('fr')).toEqual({ language: 'fr', provenance: 'campaign' });
  });

  it('honors a per-run override over the campaign setting', () => {
    expect(resolveNarrationLanguage('en', 'ja')).toEqual({ language: 'ja', provenance: 'run_override' });
  });

  it('includes explicit output language and preservation rules for non-English campaigns', () => {
    const contract = buildNarrationLanguageContract('fr', 'campaign');
    expect(contract).toContain('French (fr)');
    expect(contract).toContain('1d20+5');
    expect(contract).toContain('JSON keys in English');
    expect(contract).toContain('narrationLanguage=fr');
    expect(contract).toContain('campaign setting');
  });

  it('adds RTL guidance for Arabic and Hebrew', () => {
    const ar = buildNarrationLanguageContract('ar', 'campaign');
    expect(ar).toContain('right-to-left');
    expect(ar).toContain('Arabic (ar)');

    const he = buildNarrationLanguageContract('he', 'run_override');
    expect(he).toContain('right-to-left');
    expect(he).toContain('per-run override');
  });

  it('describes multilingual mode and structured JSON key preservation', () => {
    const contract = buildNarrationLanguageContract('multilingual', 'campaign');
    expect(contract).toContain('multilingual narration');
    expect(contract).toContain('JSON field names');
    expect(contract).not.toContain('JSON keys in English');
  });
});
