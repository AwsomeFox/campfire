/**
 * Battle map keyboard accessibility contracts (issue #419).
 *
 * Source-level pins so tokens, fog, measurement, and AoE templates stay
 * focusable and operable from the keyboard. Runtime keyboard interaction
 * is covered by the map-gesture-cancellation e2e suite and manual axe audits.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BATTLE_MAP = resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx');
const INDEX_CSS = resolve(__dirname, '../../src/index.css');

test.describe('battle map keyboard accessibility (issue #419)', () => {
  const src = readFileSync(BATTLE_MAP, 'utf8');
  const css = readFileSync(INDEX_CSS, 'utf8');

  test('tokens are focusable buttons with keyboard movement, targeting, and announced position', () => {
    expect(src).toMatch(/role="button"/);
    expect(src).toMatch(/tabIndex=\{movable \|\| legalTarget \? 0 : -1\}/);
    expect(src).toMatch(/legalTarget && \(e\.key === 'Enter' \|\| e\.key === ' '\)/);
    expect(src).toMatch(/onTokenKeyDown\(e, c\);/);
    expect(src).toMatch(/aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Delete Backspace"/);
    expect(src).toMatch(/aria-describedby="map-keyboard-help"/);
    expect(src).toMatch(/onTokenKeyDown/);
    expect(src).toMatch(/nudgeMapPoint/);
    expect(src).toMatch(/announce\(`\$\{c\.name\} moved to/);
  });

  test('AoE template handles are focusable and keyboard-movable', () => {
    expect(src).toMatch(/data-testid=\{`map-aoe-\$\{t\.id\}`\}/);
    expect(src).toMatch(/role="button"/);
    expect(src).toMatch(/onKeyDown=\{\(e\) => onAoeHandleKeyDown\(e, t\)\}/);
    expect(src).toMatch(/onAoeHandleKeyDown/);
    expect(src).toMatch(/aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Delete Backspace"/);
  });

  test('selected token and AoE panels expose numeric position/size controls', () => {
    expect(src).toMatch(/data-testid="selected-token-panel"/);
    expect(src).toMatch(/selectedToken/);
    expect(src).toMatch(/onSetTokenSize/);
    expect(src).toMatch(/updateAoe\(selectedAoe\.id, \{ x: clampPercent/);
    expect(src).toMatch(/updateAoe\(selectedAoe\.id, \{ y: clampPercent/);
  });

  test('surface exposes keyboard tool switching and measurement/reveal alternatives', () => {
    expect(src).toMatch(/id="map-keyboard-help"/);
    expect(src).toMatch(/changeTool\('move'\);/);
    expect(src).toMatch(/changeTool\('measure'\);/);
    expect(src).toMatch(/changeTool\('ping'\);/);
    expect(src).toMatch(/changeTool\('reveal'\);/);
    expect(src).toMatch(/changeTool\('calibrate'\);/);
    expect(src).toMatch(/Measurement started at map center/);
    expect(src).toMatch(/Reveal rectangle started at map center/);
  });

  test('visible focus ring class is defined and applied to map controls', () => {
    expect(css).toMatch(/\.cf-map-focusable:focus-visible/);
    expect(css).toMatch(/\.cf-map-tool:focus-visible/);
    expect(src).toMatch(/cf-map-focusable/);
    expect(src).toMatch(/data-testid="map-toolbar"[\s\S]*role="toolbar"/);
    expect(src).toMatch(/aria-label="Map tools"/);
  });

  test('reduced-motion-aware scrolling is wired for focused tokens', () => {
    expect(src).toMatch(/scrollBehavior\(\)/);
  });
});
