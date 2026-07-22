import { expect, test } from '@playwright/test';
import {
  LANG_STORAGE_KEY,
  LocaleController,
  SYSTEM_LOCALE,
  browserLocale,
  isSupportedLanguage,
  parseStoredLocalePreference,
  resolveLocales,
  serializeLocalePreference,
  type LocaleEnvironment,
  type LocaleStorage,
} from '../../src/i18n/locale';
import { createLocaleFormatters } from '../../src/lib/format';

class MemoryStorage implements LocaleStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function environment(storage: LocaleStorage, getBrowserLocale: () => string): LocaleEnvironment {
  return { getStorage: () => storage, getBrowserLocale };
}

test.describe('locale preference resolution', () => {
  test('prefers the most specific browser locale from navigator.languages', () => {
    expect(browserLocale({ language: 'en', languages: ['en-GB', 'en'] })).toBe('en-GB');
    expect(browserLocale({ language: 'de-DE', languages: [] })).toBe('de-DE');
  });

  test('accepts only translation catalogs the application actually ships', () => {
    expect(isSupportedLanguage('en')).toBe(true);
    expect(isSupportedLanguage('fr-FR')).toBe(false);
    expect(isSupportedLanguage('system')).toBe(false);
    expect(isSupportedLanguage(null)).toBe(false);
  });

  test('first load follows the full browser locale without persisting detector output', () => {
    const storage = new MemoryStorage();
    const controller = new LocaleController(environment(storage, () => 'fr-FR'));

    expect(controller.preference).toBe(SYSTEM_LOCALE);
    expect(controller.resolved).toEqual({
      preference: SYSTEM_LOCALE,
      catalogLocale: 'en',
      formatLocale: 'fr-FR',
    });
    expect(storage.getItem(LANG_STORAGE_KEY)).toBeNull();
  });

  test('legacy detector caches and unsupported stored values are not user overrides', () => {
    expect(parseStoredLocalePreference('en')).toBeNull();
    expect(parseStoredLocalePreference('{"version":1,"mode":"language","locale":"fr-FR"}')).toBeNull();
    expect(parseStoredLocalePreference('not-json')).toBeNull();
  });

  test('explicit English is persisted and used for both catalog and formatting', () => {
    const storage = new MemoryStorage();
    let browserReads = 0;
    const controller = new LocaleController(environment(storage, () => {
      browserReads += 1;
      return 'de-DE';
    }));

    expect(controller.setPreference('en')).toBe(true);
    expect(controller.resolved).toEqual({ preference: 'en', catalogLocale: 'en', formatLocale: 'en' });
    expect(browserReads).toBe(0);
    expect(storage.getItem(LANG_STORAGE_KEY)).toBe(serializeLocalePreference('en'));

    const reloaded = new LocaleController(environment(storage, () => 'ar-EG'));
    expect(reloaded.resolved).toEqual({ preference: 'en', catalogLocale: 'en', formatLocale: 'en' });
  });

  test('explicit System survives reload and follows a changed browser locale', () => {
    const storage = new MemoryStorage();
    const firstTab = new LocaleController(environment(storage, () => 'fr-FR'));
    firstTab.setPreference(SYSTEM_LOCALE);

    const reloaded = new LocaleController(environment(storage, () => 'de-DE'));
    expect(reloaded.preference).toBe(SYSTEM_LOCALE);
    expect(reloaded.resolved.formatLocale).toBe('de-DE');
    expect(storage.getItem(LANG_STORAGE_KEY)).toBe(serializeLocalePreference(SYSTEM_LOCALE));
  });

  test('an unsupported browser locale falls back only the catalog', () => {
    expect(resolveLocales(SYSTEM_LOCALE, 'ar-EG')).toEqual({
      preference: SYSTEM_LOCALE,
      catalogLocale: 'en',
      formatLocale: 'ar-EG',
    });
  });

  test('runtime browser-locale changes notify consumers and keep System selected', () => {
    const storage = new MemoryStorage();
    let currentLocale = 'en-US';
    const controller = new LocaleController(environment(storage, () => currentLocale));
    const format = createLocaleFormatters(() => controller.resolved.formatLocale);
    let notifications = 0;
    controller.subscribe(() => notifications += 1);

    expect(format.formatNumber(1_234.5)).toBe('1,234.5');

    currentLocale = 'fr-FR';
    controller.refreshBrowserLocale();

    expect(notifications).toBe(1);
    expect(controller.preference).toBe(SYSTEM_LOCALE);
    expect(controller.resolved.formatLocale).toBe('fr-FR');
    expect(format.formatNumber(1_234.5)).toBe('1\u202f234,5');
  });

  test('browser locale changes do not notify explicit-language consumers', () => {
    const storage = new MemoryStorage();
    const controller = new LocaleController(environment(storage, () => 'fr-FR'));
    controller.setPreference('en');
    let notifications = 0;
    controller.subscribe(() => notifications += 1);

    controller.refreshBrowserLocale();

    expect(notifications).toBe(0);
    expect(controller.resolved).toEqual({ preference: 'en', catalogLocale: 'en', formatLocale: 'en' });
  });

  test('storage read and write failures never prevent in-memory locale changes', () => {
    const failingStorage: LocaleStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('quota'); },
    };
    const controller = new LocaleController(environment(failingStorage, () => 'fr-FR'));

    expect(controller.preference).toBe(SYSTEM_LOCALE);
    expect(controller.setPreference('en')).toBe(false);
    expect(controller.resolved.formatLocale).toBe('en');
  });
});

test.describe('localized date, time, and number formatting', () => {
  const date = new Date(2026, 6, 21, 17, 5, 0);
  const cases = ['en-US', 'fr-FR', 'de-DE', 'ar-EG'] as const;

  for (const locale of cases) {
    test(`${locale} conventions`, () => {
      const format = createLocaleFormatters(() => locale);
      expect(format.formatDate(date, { dateStyle: 'short' })).toBe(
        new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(date),
      );
      expect(format.formatTime(date, { timeStyle: 'short' })).toBe(
        new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date),
      );
      expect(format.formatDateTime(date, { dateStyle: 'short', timeStyle: 'short' })).toBe(
        new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(date),
      );
      expect(format.formatNumber(1_234_567.89, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })).toBe(new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(1_234_567.89));
    });
  }
});
