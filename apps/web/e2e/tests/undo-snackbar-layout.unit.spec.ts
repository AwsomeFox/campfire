/**
 * Undo snackbar mobile chrome clearance (issue #794).
 *
 * Pins the pure bottom-offset arithmetic and the CSS contracts that keep the
 * bar above the tab bar / safe-area, wrapping on narrow screens, coordinating
 * overlay z-index layers, and exposing 44×44 Undo/Dismiss hit targets. Runs as
 * a source-level unit suite (no server) under pw-unit / the Playwright e2e
 * runner — browser geometry is covered separately in undo-snackbar-mobile.spec.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_SNACKBAR_GAP_PX,
  UNDO_HIT_TARGET_PX,
  computeUndoSnackbarBottomPx,
  keyboardInsetFromVisualViewport,
  tabBarContentHeightPx,
} from '../../src/components/undoSnackbarLayout';

const WEB_SRC = resolve(__dirname, '../../src');
const INDEX_CSS = resolve(WEB_SRC, 'index.css');
const NOCTURNE_CSS = resolve(WEB_SRC, 'nocturne.css');
const UNDO_SNACKBAR_TSX = resolve(WEB_SRC, 'components/UndoSnackbar.tsx');
const UNDO_SNACKBAR_CHROME_TS = resolve(WEB_SRC, 'components/useUndoSnackbarChrome.ts');

test.describe('undo snackbar bottom offset math (issue #794)', () => {
  test('sums measured tab-bar content, safe-area, keyboard inset, and gap', () => {
    expect(
      computeUndoSnackbarBottomPx({
        tabBarContentHeightPx: 48,
        safeAreaBottomPx: 34,
        keyboardInsetPx: 0,
      }),
    ).toBe(48 + 34 + DEFAULT_SNACKBAR_GAP_PX);

    expect(
      computeUndoSnackbarBottomPx({
        tabBarContentHeightPx: 48,
        safeAreaBottomPx: 34,
        keyboardInsetPx: 280,
        gapPx: 8,
      }),
    ).toBe(48 + 34 + 280 + 8);
  });

  test('desktop (no tab bar) still clears the safe-area inset alone', () => {
    expect(
      computeUndoSnackbarBottomPx({
        tabBarContentHeightPx: 0,
        safeAreaBottomPx: 34,
        keyboardInsetPx: 0,
      }),
    ).toBe(34 + DEFAULT_SNACKBAR_GAP_PX);
  });

  test('tabBarContentHeightPx subtracts safe-area so CSS can re-add env() without double-counting', () => {
    // Measured border-box already includes the tab bar's safe-area padding.
    expect(tabBarContentHeightPx(82, 34)).toBe(48);
    expect(tabBarContentHeightPx(0, 34)).toBe(0);
    expect(tabBarContentHeightPx(56, 0)).toBe(56);
  });

  test('keyboard inset accounts for visualViewport height and offsetTop', () => {
    expect(
      keyboardInsetFromVisualViewport({
        layoutViewportHeightPx: 800,
        visualViewportHeightPx: 500,
        visualViewportOffsetTopPx: 20,
      }),
    ).toBe(280);
    expect(
      keyboardInsetFromVisualViewport({
        layoutViewportHeightPx: 800,
        visualViewportHeightPx: 800,
        visualViewportOffsetTopPx: 0,
      }),
    ).toBe(0);
  });

  test('hit-target constant stays at the 44px platform minimum', () => {
    expect(UNDO_HIT_TARGET_PX).toBe(44);
  });
});

test.describe('undo snackbar CSS / layer contracts (issue #794)', () => {
  test('defines the overlay layer scale and snackbar chrome variables', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    expect(css).toMatch(/--cf-layer-tabbar:\s*40/);
    expect(css).toMatch(/--cf-layer-dialog:\s*50/);
    expect(css).toMatch(/--cf-layer-notification:\s*50/);
    expect(css).toMatch(/--cf-layer-snackbar:\s*60/);
    expect(css).toMatch(/--cf-tabbar-content-height:/);
    expect(css).toMatch(/--cf-keyboard-inset:/);
    expect(css).toMatch(/--cf-snackbar-gap:/);
  });

  test('tab bar, dialog backdrop, and snackbar consume the layer tokens in order', () => {
    const index = readFileSync(INDEX_CSS, 'utf8');
    const nocturne = readFileSync(NOCTURNE_CSS, 'utf8');
    expect(index).toMatch(/\.cf-tabbar\s*\{[^}]*z-index:\s*var\(--cf-layer-tabbar\)/s);
    expect(nocturne).toMatch(
      /\.dialog-backdrop\s*\{[^}]*z-index:\s*var\(--cf-layer-dialog/s,
    );
    expect(index).toMatch(
      /\.cf-undo-snackbar\s*\{[^}]*z-index:\s*var\(--cf-layer-snackbar\)/s,
    );
    // Snackbar above dialog/notification (60 > 50) and tab bar (40).
    expect(60).toBeGreaterThan(50);
    expect(50).toBeGreaterThan(40);
  });

  test('snackbar bottom clears tab-bar content + safe-area + keyboard + gap', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    expect(css).toMatch(
      /bottom:\s*calc\(\s*var\(--cf-tabbar-content-height[\s\S]*?env\(safe-area-inset-bottom[\s\S]*?var\(--cf-keyboard-inset[\s\S]*?var\(--cf-snackbar-gap/,
    );
  });

  test('narrow screens wrap and Undo/Dismiss keep 44×44 hit targets', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    expect(css).toMatch(/\.cf-undo-snackbar\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(css).toMatch(
      /\.cf-undo-snackbar__action\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s,
    );
    expect(css).toMatch(
      /\.cf-undo-snackbar__dismiss\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s,
    );
  });

  test('UndoSnackbar renders through the shared chrome class (no fixed bottom:24)', () => {
    const source = readFileSync(UNDO_SNACKBAR_TSX, 'utf8');
    expect(source).toMatch(/cf-undo-snackbar/);
    expect(source).toMatch(/useUndoSnackbarChrome/);
    expect(source).not.toMatch(/bottom:\s*24/);
    expect(source).not.toMatch(/zIndex:\s*1000/);
  });

  test('chrome hook publishes before paint and reuses the safe-area probe', () => {
    const source = readFileSync(UNDO_SNACKBAR_CHROME_TS, 'utf8');
    // useLayoutEffect (not useEffect) so vars land before the first paint.
    expect(source).toMatch(/useLayoutEffect/);
    expect(source).not.toMatch(/\buseEffect\b/);
    // Probe is cached/reused — createElement must not sit inside publishChromeVars.
    expect(source).toMatch(/safeAreaProbe/);
    expect(source).toMatch(/ensureSafeAreaProbe/);
    const publishBody = source.match(
      /function publishChromeVars\(\)[^{]*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(publishBody).toBeTruthy();
    expect(publishBody).not.toMatch(/createElement/);
    expect(publishBody).not.toMatch(/\.remove\(\)/);
  });
});
