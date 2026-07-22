import { expect, test } from '@playwright/test';
import { applyReadingPreference, READING_MODE_ATTRIBUTE } from '../../src/app/readingPreferences';

test('reading preference application replaces modes and clears account state on default', () => {
  const attributes = new Map<string, string>();
  const root = {
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    removeAttribute(name: string) { attributes.delete(name); },
  } as unknown as HTMLElement;

  applyReadingPreference(root, 'comfortable');
  expect(attributes.get(READING_MODE_ATTRIBUTE)).toBe('comfortable');
  applyReadingPreference(root, 'large');
  expect(attributes.get(READING_MODE_ATTRIBUTE)).toBe('large');
  applyReadingPreference(root, 'default');
  expect(attributes.has(READING_MODE_ATTRIBUTE)).toBe(false);
});
