/**
 * Locale preference and resolution.
 *
 * Translation catalogs and regional formatting are deliberately separate:
 * Campfire may render its English catalog while `Intl` keeps the browser's full
 * locale (for example `fr-FR`). All environment access is isolated here so a
 * blocked/quota-limited localStorage never prevents the app from starting.
 */

/** One versioned key replaces the detector's legacy, unversioned `en` cache. */
export const LANG_STORAGE_KEY = 'cf.lang';

export const SYSTEM_LOCALE = 'system' as const;

/** Languages Campfire currently ships a translation catalog for. */
export const SUPPORTED_LANGUAGES = [{ code: 'en', label: 'English' }] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];
export type LocalePreference = typeof SYSTEM_LOCALE | LanguageCode;

export interface ResolvedLocaleState {
  preference: LocalePreference;
  /** Locale whose messages are actually rendered. */
  catalogLocale: LanguageCode;
  /** Full locale passed to Intl; undefined delegates to the runtime default. */
  formatLocale: string | undefined;
}

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LocaleEnvironment {
  getStorage(): LocaleStorage | undefined;
  getBrowserLocale(): string | undefined;
}

interface StoredSystemPreference {
  version: 1;
  mode: 'system';
}

interface StoredLanguagePreference {
  version: 1;
  mode: 'language';
  locale: LanguageCode;
}

type StoredLocalePreference = StoredSystemPreference | StoredLanguagePreference;

function isLanguageCode(value: unknown): value is LanguageCode {
  return SUPPORTED_LANGUAGES.some(({ code }) => code === value);
}

/**
 * Parse only the user-authored, versioned shape. A legacy plain `en` value may
 * have been cached automatically by i18next's old detector, so it is ignored.
 */
export function parseStoredLocalePreference(value: string | null): LocalePreference | null {
  if (!value) return null;

  try {
    const stored = JSON.parse(value) as Partial<StoredLocalePreference>;
    if (!stored || stored.version !== 1) return null;
    if (stored.mode === 'system') return SYSTEM_LOCALE;
    if (stored.mode === 'language' && 'locale' in stored && isLanguageCode(stored.locale)) {
      return stored.locale;
    }
  } catch {
    // Malformed and legacy detector values are equivalent to no user preference.
  }
  return null;
}

export function serializeLocalePreference(preference: LocalePreference): string {
  const stored: StoredLocalePreference =
    preference === SYSTEM_LOCALE
      ? { version: 1, mode: 'system' }
      : { version: 1, mode: 'language', locale: preference };
  return JSON.stringify(stored);
}

export function readLocalePreference(storage: LocaleStorage | undefined): LocalePreference | null {
  if (!storage) return null;
  try {
    return parseStoredLocalePreference(storage.getItem(LANG_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeLocalePreference(
  storage: LocaleStorage | undefined,
  preference: LocalePreference,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LANG_STORAGE_KEY, serializeLocalePreference(preference));
    return true;
  } catch {
    return false;
  }
}

/** Keep the browser's complete locale instead of reducing it to a language code. */
export function browserLocale(navigatorLike: Pick<Navigator, 'language' | 'languages'> | undefined): string | undefined {
  const locale = navigatorLike?.language || navigatorLike?.languages?.[0];
  return locale?.trim() || undefined;
}

/** Match a requested locale to an installed catalog, with English as the source fallback. */
export function resolveCatalogLocale(requestedLocale: string | undefined): LanguageCode {
  if (requestedLocale) {
    const normalized = requestedLocale.toLowerCase();
    const match = SUPPORTED_LANGUAGES.find(({ code }) =>
      normalized === code || normalized.startsWith(`${code}-`),
    );
    if (match) return match.code;
  }
  return 'en';
}

export function resolveLocales(
  preference: LocalePreference,
  currentBrowserLocale: string | undefined,
): ResolvedLocaleState {
  const requestedLocale = preference === SYSTEM_LOCALE ? currentBrowserLocale : preference;
  return {
    preference,
    catalogLocale: resolveCatalogLocale(requestedLocale),
    formatLocale: preference === SYSTEM_LOCALE ? currentBrowserLocale : preference,
  };
}

function defaultEnvironment(): LocaleEnvironment {
  return {
    getStorage: () => {
      try {
        return typeof window === 'undefined' ? undefined : window.localStorage;
      } catch {
        return undefined;
      }
    },
    getBrowserLocale: () => {
      try {
        return browserLocale(typeof navigator === 'undefined' ? undefined : navigator);
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Owns the current user choice while keeping resolution pure and inspectable.
 * Failed writes still take effect for the current tab; a future reload safely
 * falls back to System if the preference could not be persisted.
 */
export class LocaleController {
  private preferenceValue: LocalePreference;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly environment: LocaleEnvironment = defaultEnvironment()) {
    this.preferenceValue = readLocalePreference(this.storage()) ?? SYSTEM_LOCALE;
  }

  get preference(): LocalePreference {
    return this.preferenceValue;
  }

  get resolved(): ResolvedLocaleState {
    return resolveLocales(this.preferenceValue, this.currentBrowserLocale());
  }

  setPreference(preference: LocalePreference): boolean {
    this.preferenceValue = preference;
    const persisted = writeLocalePreference(this.storage(), preference);
    this.emitChange();
    return persisted;
  }

  /** Re-read after another tab changes the preference. */
  reloadPreference(): void {
    this.preferenceValue = readLocalePreference(this.storage()) ?? SYSTEM_LOCALE;
    this.emitChange();
  }

  /** Notify consumers after the browser's locale changes at runtime. */
  refreshBrowserLocale(): void {
    this.emitChange();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private storage(): LocaleStorage | undefined {
    try {
      return this.environment.getStorage();
    } catch {
      return undefined;
    }
  }

  private currentBrowserLocale(): string | undefined {
    try {
      return this.environment.getBrowserLocale();
    } catch {
      return undefined;
    }
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

export const localeController = new LocaleController();

if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => localeController.refreshBrowserLocale());
  window.addEventListener('storage', (event) => {
    if (event.key === LANG_STORAGE_KEY) localeController.reloadPreference();
  });
}
