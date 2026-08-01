/**
 * i18n catalog locales — LTR English, pseudo-locale, and RTL direction (issue #629, #1464).
 */
import { expect, test } from '@playwright/test';
import i18n from 'i18next';
import {
  LocaleController,
  SYSTEM_LOCALE,
  resolveCatalogLocale,
  type LocaleEnvironment,
  type LocaleStorage,
} from '../../src/i18n/locale';
import { pseudoLocalizeCatalog, pseudoLocalizeString } from '../../src/i18n/pseudo';
import commonEn from '../../src/i18n/locales/en/common.json';

class MemoryStorage implements LocaleStorage {
  constructor(private readonly value: string | null) {}
  getItem(): string | null {
    return this.value;
  }
  setItem(): void {}
}

function env(browserLocale: string): LocaleEnvironment {
  return {
    getStorage: () => new MemoryStorage(null),
    getBrowserLocale: () => browserLocale,
  };
}

test.describe('shipped translation catalogs (#629, #1464)', () => {
  test('pseudo-locale expands English for layout audits', () => {
    const expanded = pseudoLocalizeString('Save');
    expect(expanded).toContain('⟦');
    expect(expanded.length).toBeGreaterThan('Save'.length);
    const catalog = pseudoLocalizeCatalog(commonEn) as typeof commonEn;
    expect(catalog.common.save).toBe(expanded);
  });

  test('resolveCatalogLocale matches en and pseudo explicitly, falling back for untranslated locales', () => {
    expect(resolveCatalogLocale('en')).toBe('en');
    expect(resolveCatalogLocale('en-US')).toBe('en');
    expect(resolveCatalogLocale('pseudo')).toBe('pseudo');
    expect(resolveCatalogLocale('ar')).toBe('en');
    expect(resolveCatalogLocale('fr-FR')).toBe('en');
  });

  test('System mode keeps English catalog with browser format locale', () => {
    const controller = new LocaleController(env('de-DE'));
    expect(controller.resolved).toEqual({
      preference: SYSTEM_LOCALE,
      catalogLocale: 'en',
      formatLocale: 'de-DE',
    });
  });

  test('i18next reports RTL for Arabic and LTR for English', async () => {
    await i18n.init({
      resources: {
        en: { translation: commonEn },
        ar: { translation: { common: { save: 'حفظ' } } },
      },
      lng: 'en',
      fallbackLng: 'en',
    });
    expect(i18n.dir('en')).toBe('ltr');
    await i18n.changeLanguage('ar');
    expect(i18n.dir('ar')).toBe('rtl');
    await i18n.changeLanguage('en');
    expect(i18n.dir('en')).toBe('ltr');
  });
});
