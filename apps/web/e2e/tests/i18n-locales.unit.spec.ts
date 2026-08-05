/**
 * i18n catalog locales — LTR English, pseudo-locale, and RTL Arabic (issue #629).
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
import encountersAr from '../../src/i18n/locales/ar/encounters.json';
import encountersEn from '../../src/i18n/locales/en/encounters.json';
import inventoryAr from '../../src/i18n/locales/ar/inventory.json';

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

test.describe('shipped translation catalogs (#629)', () => {
  test('Arabic catalog contains translated inventory strings', () => {
    const label = inventoryAr.inventory.partyStash;
    expect(label).toMatch(/[\u0600-\u06FF]/);
    expect(label).not.toBe('Party stash');
  });

  test('pseudo-locale expands English for layout audits', () => {
    const expanded = pseudoLocalizeString('Save');
    expect(expanded).toContain('⟦');
    expect(expanded.length).toBeGreaterThan('Save'.length);
    const catalog = pseudoLocalizeCatalog(commonEn) as typeof commonEn;
    expect(catalog.common.save).toBe(expanded);
  });

  test('resolveCatalogLocale matches en, ar, and pseudo explicitly', () => {
    expect(resolveCatalogLocale('en')).toBe('en');
    expect(resolveCatalogLocale('en-US')).toBe('en');
    expect(resolveCatalogLocale('ar')).toBe('ar');
    expect(resolveCatalogLocale('ar-EG')).toBe('ar');
    expect(resolveCatalogLocale('pseudo')).toBe('pseudo');
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

  test('condition overflow labels use singular and Arabic plural forms', async () => {
    const translator = i18n.createInstance();
    await translator.init({
      resources: {
        en: { translation: encountersEn },
        ar: { translation: encountersAr },
      },
      lng: 'en',
      fallbackLng: 'en',
    });
    expect(translator.t('encounters.map.tokenDetails.moreConditions', { count: 1, name: 'Boss' })).toBe('1 more condition for Boss');
    expect(translator.t('encounters.map.tokenDetails.moreConditions', { count: 2, name: 'Boss' })).toBe('2 more conditions for Boss');
    await translator.changeLanguage('ar');
    expect(translator.t('encounters.map.tokenDetails.moreConditions', { count: 1, name: 'Boss' })).toBe('حالة إضافية واحدة لـ Boss');
    expect(translator.t('encounters.map.tokenDetails.moreConditions', { count: 2, name: 'Boss' })).toBe('حالتان إضافيتان لـ Boss');
  });
});
