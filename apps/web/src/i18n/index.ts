/**
 * i18n seam (issue #94). Campfire ships English only today, but every user-facing
 * string now flows through `t()` so a translator can drop in another catalog without
 * touching component code.
 *
 * How it fits together:
 *  - The English catalog is the *source* language and the default: the keys map to the
 *    exact strings the UI has always rendered, so English behaviour is unchanged.
 *  - Catalog sections live as one JSON file per domain under `locales/en/` (e.g.
 *    `combat.json`, `nav.json`). They're merged automatically via `import.meta.glob`,
 *    so adding a new domain file needs no wiring here.
 *  - Language is picked by the detector: an explicit user override in localStorage
 *    (`cf.lang`) wins, otherwise the browser's `navigator.language`, otherwise `en`.
 *  - `<html lang>` is kept in sync with the active language (see `applyHtmlLang`).
 *
 * To add a locale later: create `locales/<lng>/` JSON files mirroring the English keys
 * and register them in `resources` below (or extend the glob to other language folders).
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

/** localStorage key holding the user's explicit language override (empty = follow browser). */
export const LANG_STORAGE_KEY = 'cf.lang';

/** Languages Campfire ships a catalog for. English is the source/default. */
export const SUPPORTED_LANGUAGES = [{ code: 'en', label: 'English' }] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

/**
 * Merge every `locales/en/*.json` domain file into one catalog object. Each file is
 * `{ "<domain>": { ...keys } }` with a unique top-level key, so a shallow assign is a
 * clean union — no domain clobbers another.
 */
function loadCatalog(modules: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const mod of Object.values(modules)) {
    const data = (mod as { default?: unknown }).default ?? mod;
    if (data && typeof data === 'object') Object.assign(out, data);
  }
  return out;
}

const en = loadCatalog(import.meta.glob('./locales/en/*.json', { eager: true }));

export const resources = {
  en: { translation: en },
} as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    // Only offer languages we actually ship a catalog for; anything else falls back to `en`.
    supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
    nonExplicitSupportedLngs: true, // treat `en-US`, `en-GB`, … as `en`
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      // Explicit user choice (cf.lang) beats the browser's Accept-Language.
      order: ['localStorage', 'navigator', 'htmlTag'],
      lookupLocalStorage: LANG_STORAGE_KEY,
      caches: ['localStorage'],
    },
  });

/** Keep the document's `lang` attribute in step with the active language. */
export function applyHtmlLang(lng: string): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lng.split('-')[0] || 'en';
  }
}

applyHtmlLang(i18n.language || 'en');
i18n.on('languageChanged', applyHtmlLang);

export default i18n;
