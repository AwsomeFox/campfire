import { expect, test } from '@playwright/test';
import {
  LANG_STORAGE_KEY,
  LocaleController,
  SYSTEM_LOCALE,
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
    const controller = new LocaleController(environment(storage, () => 'de-DE'));

    expect(controller.setPreference('en')).toBe(true);
    expect(controller.resolved).toEqual({ preference: 'en', catalogLocale: 'en', formatLocale: 'en' });
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
  const cases = [
    {
      locale: 'en-US',
      date: '7/21/26',
      time: '5:05 PM',
      dateTime: '7/21/26, 5:05 PM',
      number: '1,234,567.89',
    },
    {
      locale: 'fr-FR',
      date: '21/07/2026',
      time: '17:05',
      dateTime: '21/07/2026 17:05',
      number: '1\u202f234\u202f567,89',
    },
    {
      locale: 'de-DE',
      date: '21.07.26',
      time: '17:05',
      dateTime: '21.07.26, 17:05',
      number: '1.234.567,89',
    },
    {
      locale: 'ar-EG',
      date: '٢١\u200f/٧\u200f/٢٠٢٦',
      time: '٥:٠٥ م',
      dateTime: '٢١\u200f/٧\u200f/٢٠٢٦، ٥:٠٥ م',
      number: '١٬٢٣٤٬٥٦٧٫٨٩',
    },
  ] as const;

  for (const expected of cases) {
    test(`${expected.locale} conventions`, () => {
      const format = createLocaleFormatters(() => expected.locale);
      expect(format.formatDate(date, { dateStyle: 'short' })).toBe(expected.date);
      expect(format.formatTime(date, { timeStyle: 'short' })).toBe(expected.time);
      expect(format.formatDateTime(date, { dateStyle: 'short', timeStyle: 'short' })).toBe(expected.dateTime);
      expect(format.formatNumber(1_234_567.89, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })).toBe(expected.number);
    });
  }
});
