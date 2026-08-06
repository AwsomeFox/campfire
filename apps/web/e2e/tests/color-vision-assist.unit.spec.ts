/**
 * Color-vision-assist mode (issue #1942): non-color channels layered onto the
 * existing color-only combat indicators — token identity, HP danger escalation,
 * current-turn marker, crit/fumble overlay.
 *
 * Pure-logic coverage follows the `tokenStateBadges.ts` / `accentPalette.ts`
 * convention already used in this suite (issues #1905, #795): deterministic
 * helpers are unit-tested directly. Conditional wiring into JSX is verified
 * with source-text assertions here for the surfaces this Playwright
 * *.unit.spec config (no DOM/browser) cannot reach — the same way
 * `token-state-badges.unit.spec.ts` pins BattleMap's readTokenDetailMode call.
 *
 * The CombatantRow/HpBar and PreferencesPage wiring formerly covered here as
 * source-scan assertions were converted to rendered assertions (issue #2025)
 * — see apps/web/test/component/CombatantRow.spec.tsx and
 * PreferencesPage.spec.tsx, which run under the jsdom + Testing Library tier
 * (`npm run test:component -w apps/web`) rather than this Playwright config.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { simulateColorVision } from '../../src/app/accentPalette';
import type { ColorVisionSim } from '../../src/app/accentPalette';
import {
  TOKEN_COLOR_RAMP,
  TOKEN_IDENTITY_SHAPES,
  TOKEN_IDENTITY_SHAPE_CLIP_PATH,
  tokenIdentityColor,
  tokenIdentityShape,
} from '../../src/features/encounters/tokenIdentity';
import { hpTone, hpToneGlyph } from '../../src/components/ui';

const CVD: ColorVisionSim[] = ['protanopia', 'deuteranopia', 'tritanopia'];

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const BATTLE_MAP = resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx');
const DICE_ROLL_OVERLAY = resolve(__dirname, '../../src/components/DiceRollOverlay.tsx');

test.describe('token identity shape (issue #1942)', () => {
  test('is deterministic per combatantId — same combatant always yields the same shape', () => {
    for (const id of [1, 2, 3, 12, 13, 41, 999, -7]) {
      const first = tokenIdentityShape(id);
      const second = tokenIdentityShape(id);
      expect(first).toBe(second);
      expect(TOKEN_IDENTITY_SHAPES).toContain(first);
    }
  });

  test('every shape has a clip-path — no shape renders as a blank badge', () => {
    for (const shape of TOKEN_IDENTITY_SHAPES) {
      expect(TOKEN_IDENTITY_SHAPE_CLIP_PATH[shape]).toMatch(/circle|inset|polygon/);
    }
  });

  test('adjacent ramp entries always get a different shape — the property the CVD guard below relies on', () => {
    // 12 ramp entries mod 4 shapes guarantees every consecutive pair differs (N and N+1
    // can only share a residue mod k when k divides 1, impossible for k > 1). This is
    // what actually protects two color-adjacent identities from collapsing together —
    // the (shape, simulated-color) tuple below can only match if BOTH halves match, and
    // this test pins that the shape half never does for a neighbouring ramp entry.
    for (let i = 0; i < TOKEN_COLOR_RAMP.length; i += 1) {
      const a = tokenIdentityShape(i);
      const b = tokenIdentityShape((i + 1) % TOKEN_COLOR_RAMP.length);
      expect(a, `ramp[${i}] vs ramp[${(i + 1) % TOKEN_COLOR_RAMP.length}]`).not.toBe(b);
    }
  });

  test('CVD guard: no two ADJACENT ramp entries share a (shape, simulated-color) tuple under any deficiency', () => {
    // Mirrors accent-palette.unit.spec.ts's CVD-guard pattern (issue #795): assign
    // each of the 12 ramp colors the same shape a combatant at that index would get
    // (tokenIdentityColor/tokenIdentityShape both key off `combatantId % ramp.length`),
    // then confirm adjacent ramp entries never collapse to the identical
    // (shape, simulated-color) tuple — the exact regression issue #1942 exists to close.
    for (const sim of CVD) {
      const tuples = TOKEN_COLOR_RAMP.map((_, index) => {
        const combatantId = index; // tokenIdentityColor(index) === TOKEN_COLOR_RAMP[index] for index < ramp.length
        expect(tokenIdentityColor(combatantId)).toBe(TOKEN_COLOR_RAMP[index]);
        return {
          shape: tokenIdentityShape(combatantId),
          color: simulateColorVision(TOKEN_COLOR_RAMP[index], sim),
        };
      });
      for (let i = 0; i < tuples.length; i += 1) {
        const a = tuples[i];
        const b = tuples[(i + 1) % tuples.length];
        const collides = a.shape === b.shape && a.color === b.color;
        expect(collides, `ramp[${i}] vs ramp[${(i + 1) % tuples.length}] under ${sim}`).toBe(false);
      }
    }
  });
});

test.describe('HP danger glyph (issue #1942)', () => {
  test('crit and low each get a distinct glyph; healthy gets none', () => {
    expect(hpToneGlyph('crit')).toBe('▲▲');
    expect(hpToneGlyph('low')).toBe('▲');
    expect(hpToneGlyph('')).toBeNull();
  });

  test('glyph tracks the same threshold table hpTone uses — no drift between the two', () => {
    expect(hpToneGlyph(hpTone(10, 100))).toBe('▲▲'); // 10% — critical
    expect(hpToneGlyph(hpTone(40, 100))).toBe('▲'); // 40% — low
    expect(hpToneGlyph(hpTone(80, 100))).toBeNull(); // 80% — healthy
  });
});

test.describe('assist wiring is gated on the colorVisionAssist preference (issue #1942)', () => {
  test('strip token: identity shape badge and turn chevron only render when assist is on', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toContain('colorVisionAssist && isCurrent && (');
    expect(source).toContain('data-testid="strip-token-turn-chevron"');
    expect(source).toContain('data-testid="strip-token-identity-shape"');
    expect(source).toMatch(/\{colorVisionAssist && \(\s*<span[\s\S]{0,80}data-testid="strip-token-identity-shape"/);
  });

  test('InitiativeStrip, PlayerVitalsHeader, CombatantRow, and BattleMap all receive the live preference', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const occurrences = source.match(/colorVisionAssist=\{me\?\.user\.colorVisionAssist \?\? false\}/g) ?? [];
    // One call site each for InitiativeStrip, PlayerVitalsHeader, BattleMap, CombatantRow.
    expect(occurrences.length).toBeGreaterThanOrEqual(4);
  });

  // CombatantRow's turn-chevron gate and HpBar's colorVisionAssist prop wiring were
  // covered here as source-scan assertions; both are now rendered assertions in
  // apps/web/test/component/CombatantRow.spec.tsx (issue #2025), which mounts the
  // real row for every (colorVisionAssist, isCurrentTurn) combination and checks
  // the chevron and the HpBar danger glyph actually appear/disappear in the DOM —
  // strictly stronger than confirming the JSX string is still present.

  test('BattleMap: map-token identity shape and turn chevron both gated on colorVisionAssist', () => {
    const source = readFileSync(BATTLE_MAP, 'utf8');
    expect(source).toContain('{colorVisionAssist && (');
    expect(source).toContain('{isCurrentTurn && colorVisionAssist && (');
    expect(source).toContain('map-token-identity-shape-');
    expect(source).toContain('map-token-turn-chevron-');
  });

  test('DiceRollOverlay: crit/fumble assist glyph gated on colorVisionAssist AND (crit or fumble)', () => {
    const source = readFileSync(DICE_ROLL_OVERLAY, 'utf8');
    expect(source).toContain('colorVisionAssist && (isCrit || isFumble) && (');
    expect(source).toContain('cf-dice-roll-overlay__assist-glyph');
  });

  // HpBar's colorVisionAssist-gated glyph render was covered here as a source-scan
  // assertion against ui.tsx directly; it's now exercised end-to-end (through the
  // real, mounted HpBar) by apps/web/test/component/CombatantRow.spec.tsx's glyph
  // tests, which assert the glyph's presence, absence, text, and tone attribute
  // rather than a snippet of the implementation.

  // PreferencesPage's colorVisionAssist-to-PATCH wiring, including the dirty-check
  // that unlocks Save for this field alone, was covered here as a source-scan
  // assertion. It's now a rendered assertion in
  // apps/web/test/component/PreferencesPage.spec.tsx, which drives the real
  // checkbox and Save button and asserts on the actual PATCH /me/preferences
  // payload sent, in both directions (on -> off and off -> on).
});
