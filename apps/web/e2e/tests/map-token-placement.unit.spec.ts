/**
 * Map token tray partitioning under fog redaction (issue #418).
 *
 * A placed token whose coordinates are withheld by fog must not appear under
 * Unplaced (and must not offer place-at-center). Once revealed it returns to
 * the placed bucket without duplication.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FOG_HIDDEN_TOKEN_LABEL,
  isTokenHiddenByFog,
  isTokenPlacedOnMap,
  isTokenTrulyUnplaced,
  partitionMapTokens,
} from '../../src/features/encounters/mapTokenPlacement';

const BATTLE_MAP = resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx');

type Token = {
  id: number;
  name: string;
  tokenX: number | null;
  tokenY: number | null;
  tokenHiddenByFog?: boolean;
};

function tok(partial: Partial<Token> & Pick<Token, 'id' | 'name'>): Token {
  return {
    tokenX: null,
    tokenY: null,
    tokenHiddenByFog: false,
    ...partial,
  };
}

test.describe('map token placement trays (issue #418)', () => {
  test('partitions owned / allied / enemy tokens across fog boundaries without duplication', () => {
    const ownedHidden = tok({ id: 1, name: 'Aria', tokenHiddenByFog: true });
    const alliedVisible = tok({ id: 2, name: 'Borin', tokenX: 70, tokenY: 70 });
    const enemyHidden = tok({ id: 3, name: 'Ogre', tokenHiddenByFog: true });
    const trulyUnplaced = tok({ id: 4, name: 'Late PC' });
    const enemyVisible = tok({ id: 5, name: 'Goblin', tokenX: 20, tokenY: 20 });

    const { placed, unplaced, hiddenByFog } = partitionMapTokens([
      ownedHidden,
      alliedVisible,
      enemyHidden,
      trulyUnplaced,
      enemyVisible,
    ]);

    expect(placed.map((c) => c.id)).toEqual([2, 5]);
    expect(unplaced.map((c) => c.id)).toEqual([4]);
    expect(hiddenByFog.map((c) => c.id)).toEqual([1, 3]);

    // No token appears in more than one bucket.
    const ids = [...placed, ...unplaced, ...hiddenByFog].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('crossing into a revealed region moves a fog-hidden token to placed (not Unplaced)', () => {
    const beforeReveal = tok({ id: 1, name: 'Aria', tokenHiddenByFog: true });
    expect(isTokenHiddenByFog(beforeReveal)).toBe(true);
    expect(isTokenTrulyUnplaced(beforeReveal)).toBe(false);
    expect(isTokenPlacedOnMap(beforeReveal)).toBe(false);

    // Server clears tokenHiddenByFog and restores coordinates once revealed.
    const afterReveal = tok({ id: 1, name: 'Aria', tokenX: 15, tokenY: 15, tokenHiddenByFog: false });
    const buckets = partitionMapTokens([afterReveal]);
    expect(buckets.placed).toHaveLength(1);
    expect(buckets.unplaced).toHaveLength(0);
    expect(buckets.hiddenByFog).toHaveLength(0);
  });

  test('owner-safe label does not mention coordinates', () => {
    expect(FOG_HIDDEN_TOKEN_LABEL).toMatch(/outside the revealed area/i);
    expect(FOG_HIDDEN_TOKEN_LABEL).not.toMatch(/\d/);
  });

  test('RunSessionPage uses partitionMapTokens and never place-at-center for fog-hidden tokens', () => {
    const source = readFileSync(BATTLE_MAP, 'utf8');
    expect(source).toMatch(/partitionMapTokens/);
    expect(source).toMatch(/FOG_HIDDEN_TOKEN_LABEL/);
    expect(source).toMatch(/map-token-fog-hidden/);
    // Fog-hidden chips are <span>, not buttons that call onMoveToken.
    expect(source).toMatch(/hiddenByFog\.map\(\(c\) => \(\s*\n\s*<span/m);
    // Place-at-center remains only for the truly-unplaced tray.
    expect(source).toMatch(/unplaced\.map/);
    expect(source).toMatch(/Place token at center/);
  });

  /**
   * The Unplaced tray must stay reachable for a PLAYER in the cockpit.
   *
   * The cockpit hides the token tray behind the rail's "Manage tokens" disclosure so it
   * stops covering the board. That toggle is DM-only — and when the gate was written as a
   * bare `(!isVtt || selectionDisclosure.open)` it therefore hid the tray from players
   * behind a control they can never see. The Unplaced list is how a player puts their own
   * character on the board, so this made that impossible in any encounter run from the
   * cockpit; they had to ask the DM.
   *
   * The gate must stay conditioned on `!effectiveIsDm` (or equivalent), so the collapse
   * applies only to the viewer who has the button.
   */
  test('the cockpit token tray disclosure gate never applies to non-DM viewers', () => {
    const source = readFileSync(BATTLE_MAP, 'utf8');
    const gate = /\{!isCast && \(([^)]*selectionDisclosure\.open[^)]*)\) &&/.exec(source);
    expect(gate, 'token tray render gate not found — has the condition been rewritten?').not.toBeNull();
    expect(
      gate![1],
      'the tray gate must exempt non-DMs, or players lose the Unplaced list behind a DM-only toggle',
    ).toMatch(/!effectiveIsDm/);
  });
});
