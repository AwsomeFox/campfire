/**
 * Control icon vocabulary + brand mark (issue #678).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { getIcon } from '../../src/lib/icons';
import {
  UI_CONTROL_ICON,
  UI_ICON_SIZE,
} from '../../src/lib/uiIcons';

const ROOT = resolve(__dirname, '../../src');
const CONTROL_SITES = [
  'features/home/HomePage.tsx',
  'components/Toggle.tsx',
  'app/Layout.tsx',
] as const;

/** Glyphs replaced by UIIcon in issue #678 control surfaces (not role-label ▾). */
const CONTROL_GLYPHS = '+⬆✓⋯✕';

function containsControlGlyph(source: string): boolean {
  const glyph = `[${CONTROL_GLYPHS}]`;
  const quoted = new RegExp(`['"]${glyph}['"]`);
  const directJsxText = new RegExp(`>\\s*${glyph}\\s*<`);
  return quoted.test(source) || directJsxText.test(source);
}

test.describe('UI control icons (issue #678)', () => {
  test('snapshots the control icon vocabulary and size ramp', () => {
    expect(JSON.stringify({ icons: UI_CONTROL_ICON, sizes: UI_ICON_SIZE }, null, 2)).toMatchSnapshot(
      'ui-control-icons.txt',
    );
  });

  test('every control slug resolves synchronously from ui extras', () => {
    for (const slug of Object.values(UI_CONTROL_ICON)) {
      expect(getIcon(slug), `${slug} must be bundled for first paint`).toBeDefined();
    }
  });

  test('cited control surfaces no longer embed platform glyph characters', () => {
    const offenders: string[] = [];
    for (const rel of CONTROL_SITES) {
      const text = readFileSync(resolve(ROOT, rel), 'utf8');
      if (containsControlGlyph(text)) offenders.push(rel);
      if (!text.includes('UIIcon') && !text.includes('BrandMark')) {
        offenders.push(`${rel}: missing UIIcon/BrandMark import`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

test.describe('BrandMark (issue #678)', () => {
  test('auth + layout chrome import the shared component instead of local FlameMark', () => {
    const brandSites = [
      'features/auth/LoginPage.tsx',
      'features/auth/SignupPage.tsx',
      'features/auth/SetupPage.tsx',
      'features/auth/JoinPage.tsx',
      'features/auth/OidcRecoveryPage.tsx',
      'app/Layout.tsx',
    ];
    const offenders: string[] = [];
    for (const rel of brandSites) {
      const text = readFileSync(resolve(ROOT, rel), 'utf8');
      if (text.includes('function FlameMark')) offenders.push(`${rel}: local FlameMark`);
      if (!text.includes('BrandMark')) offenders.push(`${rel}: missing BrandMark`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
