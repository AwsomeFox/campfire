import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18n from 'i18next';

const ROOT = resolve(__dirname, '../../src');
const I18N_INDEX = resolve(ROOT, 'i18n/index.ts');
const MARKDOWN = resolve(ROOT, 'components/Markdown.tsx');
const UI = resolve(ROOT, 'components/ui.tsx');
const INDEX_CSS = resolve(ROOT, 'index.css');

test.describe('RTL document direction and bidi isolation (#628)', () => {
  test('i18n bootstrap sets html lang and dir from the active catalog locale', () => {
    const source = readFileSync(I18N_INDEX, 'utf8');
    expect(source).toMatch(/document\.documentElement\.lang = catalogLocale/);
    expect(source).toMatch(/document\.documentElement\.dir = i18n\.dir\(catalogLocale\)/);
    expect(source).toMatch(/applyHtmlLang\(catalogLocale\)/);
  });

  test('i18next resolves rtl for Arabic catalogs', async () => {
    const instance = i18n.createInstance();
    await instance.init({
      lng: 'en',
      resources: { en: { translation: {} }, ar: { translation: {} } },
    });
    expect(instance.dir('en')).toBe('ltr');
    expect(instance.dir('ar')).toBe('rtl');
  });

  test('user-authored markdown renders with dir=auto', () => {
    const source = readFileSync(MARKDOWN, 'utf8');
    expect(source).toMatch(/dir="auto"/);
  });

  test('text inputs default to dir=auto for mixed-script user content', () => {
    const source = readFileSync(UI, 'utf8');
    expect(source).toMatch(/function TextInput\([\s\S]*dir = 'auto'/);
    expect(source).toMatch(/function TextArea\([\s\S]*dir = 'auto'/);
  });

  test('markdown prose and timeline use logical layout properties', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    expect(css).toMatch(/\.cf-timeline\s*\{[^}]*border-inline-start/);
    expect(css).toMatch(/\.cf-prose ul,\s*\n\.cf-prose ol\s*\{[^}]*padding-inline-start/);
    expect(css).toMatch(/\.cf-prose blockquote\s*\{[^}]*border-inline-start/);
    expect(css).toMatch(/\.cf-prose blockquote\s*\{[^}]*padding-inline-start/);
  });
});
