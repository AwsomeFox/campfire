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
 *  - Locale resolution lives in `locale.ts`. The rendered catalog and `Intl`
 *    formatting locale are separate, so an English-only UI can still use the
 *    browser's French, German, Arabic, etc. regional conventions.
 *  - `<html lang>` and `dir` follow the catalog that actually rendered.
 *
 * To add a locale later: create `locales/<lng>/` JSON files mirroring the English keys
 * and register them in `resources` below (or extend the glob to other language folders).
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { localeController, SUPPORTED_LANGUAGES } from './locale';

export {
  LANG_STORAGE_KEY,
  isSupportedLanguage,
  localeController,
  SUPPORTED_LANGUAGES,
  SYSTEM_LOCALE,
} from './locale';
export type { LanguageCode, LocalePreference, ResolvedLocaleState } from './locale';

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

const initialLocale = localeController.resolved;

void i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: initialLocale.catalogLocale,
    fallbackLng: 'en',
    // Only offer languages we actually ship a catalog for; anything else falls back to `en`.
    supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
    nonExplicitSupportedLngs: true, // treat `en-US`, `en-GB`, … as `en`
    interpolation: { escapeValue: false }, // React already escapes
  })
  .then(() => applyHtmlLang(i18n.resolvedLanguage || i18n.language || 'en'));

/** Keep document metadata aligned with the catalog that actually rendered. */
export function applyHtmlLang(lng: string): void {
  if (typeof document !== 'undefined') {
    const catalogLocale = lng || 'en';
    document.documentElement.lang = catalogLocale;
    document.documentElement.dir = i18n.dir(catalogLocale);
  }
}

applyHtmlLang(initialLocale.catalogLocale);
i18n.on('languageChanged', applyHtmlLang);

localeController.subscribe(() => {
  const catalogLocale = localeController.resolved.catalogLocale;
  if (i18n.resolvedLanguage !== catalogLocale && i18n.language !== catalogLocale) {
    void i18n.changeLanguage(catalogLocale);
  }
});

export default i18n;
