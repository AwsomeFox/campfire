/**
 * Control icon vocabulary + brand mark (issue #678).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { getIcon } from '../../src/lib/icons';
import {
  UI_CONTROL_ICON,
  UI_ICON_SIZE,
} from '../../src/lib/uiIcons';

const ROOT = resolve(__dirname, '../../src');

/** Recursively collect .tsx sources under `dir`. */
function collectTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsx(full, out);
    } else if (entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}
const CONTROL_SITES = [
  'features/home/HomePage.tsx',
  'components/Toggle.tsx',
  'app/Layout.tsx',
] as const;

/** Glyphs replaced by UIIcon in issue #678 control surfaces (not role-label ▾). */
const CONTROL_GLYPHS = '+⬆✓⋯✕';

/**
 * Issue #1715 Part 2 — files where a raw close glyph (✕ U+2715 or × U+00D7)
 * was migrated to <UIIcon name="close">. Checked with a NARROWER glyph set
 * than CONTROL_GLYPHS above: these files legitimately keep '+' (dice/count
 * increment buttons) and other CONTROL_GLYPHS characters for unrelated
 * purposes, so reusing the full #678 charset here would false-positive on
 * those. StorylinesPage.tsx and GenerateEncounterWizard.tsx are deliberately
 * excluded: StorylinesPage.tsx legitimately renders a bare '✕' as a
 * beat-STATUS glyph (BEAT_GLYPH.skipped, unrelated to a close/dismiss
 * control); GenerateEncounterWizard.tsx legitimately renders a bare '×' as a
 * "× <count input>" multiplier label beside a roster slot's count field
 * (unrelated to a close control). Both read as bare `>×<`/`>✕<` to this
 * substring check exactly like a real offender would, so they can't be
 * asserted file-wide without a false positive. Each file's ACTUAL
 * close-button call site(s) were migrated the same way as everything else
 * here — this exclusion is about the check's precision, not the fix.
 */
const CLOSE_GLYPH_MIGRATED_SITES = [
  'components/RollResultBanner.tsx',
  'components/RollResultToast.tsx',
  'components/UndoSnackbar.tsx',
  'features/ai-dm/AiMapWizard.tsx',
  'features/ai-dm/DraftWithAiButton.tsx',
  'features/characters/CharacterPage.tsx',
  'features/dice/DiceTray.tsx',
  'features/encounters/RunSessionPage.tsx',
  'features/inventory/inventoryShared.tsx',
  'features/notes/MyNotesPage.tsx',
  'features/notifications/NotificationsBell.tsx',
  'features/screen/PlayerDisplayPage.tsx',
] as const;
const CLOSE_GLYPHS = '✕×';

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
      const usesSharedControls =
        text.includes('<UIIcon')
        || text.includes('<BrandMark')
        || (rel === 'components/Toggle.tsx' && text.includes('UI_CONTROL_ICON'));
      if (!usesSharedControls) {
        offenders.push(`${rel}: missing shared control icon usage`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

test.describe('close-glyph vocabulary (issue #1715 Part 2)', () => {
  test('migrated close/dismiss/remove buttons no longer embed a raw ✕/× glyph', () => {
    const glyph = `[${CLOSE_GLYPHS}]`;
    const quoted = new RegExp(`['"]${glyph}['"]`);
    const directJsxText = new RegExp(`>\\s*${glyph}\\s*<`);
    const offenders: string[] = [];
    for (const rel of CLOSE_GLYPH_MIGRATED_SITES) {
      const text = readFileSync(resolve(ROOT, rel), 'utf8');
      if (quoted.test(text) || directJsxText.test(text)) offenders.push(rel);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  test('UI_CONTROL_ICON.close is used by name, not just defined', () => {
    let liveCallSites = 0;
    for (const rel of CLOSE_GLYPH_MIGRATED_SITES) {
      const text = readFileSync(resolve(ROOT, rel), 'utf8');
      liveCallSites += (text.match(/<UIIcon\s+name="close"/g) ?? []).length;
    }
    expect(liveCallSites).toBeGreaterThan(0);
  });

  test('UI_ICON_SIZE enforces the canonical 4-value scale (xs: 14, sm: 16, md: 20, lg: 24)', () => {
    expect(UI_ICON_SIZE).toEqual({
      xs: 14,
      sm: 16,
      md: 20,
      lg: 24,
    });
  });
});

test.describe('chrome-icon sizing (issue #1715 Part 1)', () => {
  // Sizes that must ALWAYS resolve through UI_ICON_SIZE (xs:14/sm:16/md:20/lg:24)
  // rather than a raw numeric literal, because they are not themselves one of
  // the 4 canonical values — a raw `size={11}`/`size={12}`/etc. on <GameIcon>
  // is exactly the sprawl this issue collapsed onto the 4-value scale. 14, 16,
  // 20, and 24 are deliberately NOT in this set: they already equal a
  // canonical value, so a raw literal there isn't itself sprawl (though the
  // migration also swapped those to the constant for consistency where it
  // touched them).
  //
  // Domain/decorative art sizes (26, 28, 30, 32, 36, 52, 56, 72, 96 — campaign
  // covers, empty-state illustrations, icon-picker previews) are explicitly
  // OUT OF SCOPE and deliberately absent from this set. They need their own
  // canonical scale, which does not exist yet and is not built here — see the
  // PR for #1715 Part 1 for the full accounting.
  test('no <GameIcon> call site uses a non-canonical chrome-range literal size', () => {
    const CANONICAL = new Set([14, 16, 20, 24]);
    const offenders: string[] = [];
    const pattern = /<GameIcon\b[^>]*\bsize=\{([0-9]+)\}/g;
    for (const file of collectTsx(ROOT)) {
      const text = readFileSync(file, 'utf8');
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(stripped)) !== null) {
        const val = Number(m[1]);
        if (val < 26 && !CANONICAL.has(val)) {
          offenders.push(`${file.replace(ROOT + '/', '')}: size={${val}}`);
        }
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
