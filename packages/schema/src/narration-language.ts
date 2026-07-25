import { z } from 'zod';

/**
 * Campaign AI narration language (issue #635). Distinct from the client UI locale —
 * this governs Driver, co-DM, and Scribe output only.
 */
export const NarrationLanguage = z.enum([
  'en',
  'fr',
  'de',
  'es',
  'it',
  'pt',
  'ja',
  'ko',
  'zh',
  'ar',
  'he',
  'ru',
  'multilingual',
]);
export type NarrationLanguage = z.infer<typeof NarrationLanguage>;

export const NARRATION_LANGUAGE_LABELS: Record<NarrationLanguage, string> = {
  en: 'English',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ar: 'Arabic',
  he: 'Hebrew',
  ru: 'Russian',
  multilingual: 'Multilingual (match speakers)',
};

export const NARRATION_LANGUAGE_OPTIONS = NarrationLanguage.options.map((value) => ({
  value,
  label: NARRATION_LANGUAGE_LABELS[value],
}));

export type NarrationLanguageProvenance = 'campaign' | 'run_override';

const RTL_LANGUAGES = new Set<NarrationLanguage>(['ar', 'he']);

export function resolveNarrationLanguage(
  campaignLanguage: NarrationLanguage | string | null | undefined,
  override?: NarrationLanguage | null,
): { language: NarrationLanguage; provenance: NarrationLanguageProvenance } {
  if (override) {
    return { language: NarrationLanguage.parse(override), provenance: 'run_override' };
  }
  const parsed = NarrationLanguage.safeParse(campaignLanguage ?? 'en');
  return { language: parsed.success ? parsed.data : 'en', provenance: 'campaign' };
}

/**
 * Prompt block appended to Driver / co-DM / Scribe system instructions so providers
 * receive an explicit output-language contract with preservation rules.
 */
export function buildNarrationLanguageContract(
  language: NarrationLanguage,
  provenance: NarrationLanguageProvenance,
): string {
  const preserve = [
    'Preserve verbatim (do not translate):',
    '- Proper names (characters, places, factions, quests)',
    '- Dice notation and mechanical formulas (e.g. 1d20+5, AC 15)',
    '- Rules citations and compendium entry IDs/titles when quoting lookups',
    '- Numeric entity IDs and JSON field names in structured output',
  ].join('\n');

  const provenanceLine = `Provenance: ${provenance === 'run_override' ? 'per-run override' : 'campaign setting'} — narrationLanguage=${language}.`;
  const uiNote = 'This governs AI-generated campaign content only; the table UI locale is separate.';

  if (language === 'multilingual') {
    return [
      '## Output language',
      'This table uses multilingual narration. Write each speaker in their established language when known;',
      'otherwise match the language of the surrounding scene. Mark code-switching clearly.',
      preserve,
      uiNote,
      provenanceLine,
    ].join('\n');
  }

  const label = NARRATION_LANGUAGE_LABELS[language];
  const rtlNote = RTL_LANGUAGES.has(language)
    ? 'Write right-to-left. Keep dice notation, numeric IDs, and rules citations in left-to-right order.'
    : '';
  const structuredNote =
    language !== 'en'
      ? 'For structured JSON drafts: keep JSON keys in English; write human-readable string values in the target language.'
      : '';

  return [
    '## Output language',
    `Write all narration, descriptions, and human-readable recap prose in ${label} (${language}).`,
    preserve,
    ...(rtlNote ? [rtlNote] : []),
    ...(structuredNote ? [structuredNote] : []),
    uiNote,
    provenanceLine,
  ].join('\n');
}
