/**
 * Dialog overlay layering (issue #791).
 *
 * Pins the CSS layer scale and ConfirmDialog contracts that keep destructive
 * confirmations above mobile chrome and make the background inert. Pure
 * source-level suite — no server / browser (pw-unit). Hit-target geometry is
 * covered separately in dialog-layering.spec.ts.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_SRC = resolve(__dirname, '../../src');
const INDEX_CSS = resolve(WEB_SRC, 'index.css');
const NOCTURNE_CSS = resolve(WEB_SRC, 'nocturne.css');
const CONFIRM_DIALOG = resolve(WEB_SRC, 'components/ConfirmDialog.tsx');
const USE_DIALOG = resolve(WEB_SRC, 'components/useDialog.ts');

test.describe('overlay layer scale (issue #791)', () => {
  test('documents chrome → menus/tabbar → dialogs/notifications → recovery', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    expect(css).toMatch(/Overlay stacking \(issue #791\)/);
    expect(css).toMatch(/chrome \(sticky headers/);
    expect(css).toMatch(/menus \/ mobile tab bar/);
    expect(css).toMatch(/dialogs \/ sheets/);
    expect(css).toMatch(/notification panel/);
    expect(css).toMatch(/undo \/ recovery snackbar/);
    expect(css).toMatch(/--cf-layer-tabbar:\s*40/);
    expect(css).toMatch(/--cf-layer-dialog:\s*50/);
    expect(css).toMatch(/--cf-layer-notification:\s*50/);
    expect(css).toMatch(/--cf-layer-snackbar:\s*60/);
    // Ordering invariant the comment documents.
    expect(40).toBeGreaterThan(30);
    expect(50).toBeGreaterThan(40);
    expect(60).toBeGreaterThan(50);
  });

  test('tab bar and dialog backdrop consume the layer tokens', () => {
    const index = readFileSync(INDEX_CSS, 'utf8');
    const nocturne = readFileSync(NOCTURNE_CSS, 'utf8');
    expect(index).toMatch(/\.cf-tabbar\s*\{[^}]*z-index:\s*var\(--cf-layer-tabbar\)/s);
    expect(nocturne).toMatch(
      /\.dialog-backdrop\s*\{[^}]*z-index:\s*var\(--cf-layer-dialog/s,
    );
    expect(nocturne).toMatch(
      /\.dialog-backdrop\s*\{[^}]*pointer-events:\s*auto/s,
    );
  });
});

test.describe('ConfirmDialog portal + inert background (issue #791)', () => {
  test('portals to document.body above navigation', () => {
    const source = readFileSync(CONFIRM_DIALOG, 'utf8');
    expect(source).toMatch(/createPortal/);
    expect(source).toMatch(/document\.body/);
    expect(source).toMatch(/inertBackground:\s*true/);
    expect(source).toMatch(/data-overlay="dialog"/);
  });

  test('useDialog preserves nested inert state when restoring', () => {
    const source = readFileSync(USE_DIALOG, 'utf8');
    expect(source).toMatch(/hadAttribute/);
    expect(source).toMatch(/inerted\.reverse\(\)/);
    expect(source).toMatch(/nested overlays restore correctly/);
  });
});
