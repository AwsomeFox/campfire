/**
 * Component-render coverage for the colorVisionAssist conditional-render gates
 * in `CombatantRow` (issue #1942), converting the source-scan assertion in
 * `e2e/tests/color-vision-assist.unit.spec.ts` ("CombatantRow: turn chevron
 * gated on colorVisionAssist, HpBar receives the prop") to a rendered
 * assertion, per issue #2025.
 *
 * A source-scan test can confirm `colorVisionAssist && isCurrentTurn && (` and
 * the HpBar prop-pass still appear in the file; it cannot tell whether the
 * gate is actually `&&` vs `||`, attached to the right element, or whether
 * HpBar actually consumes the prop to render anything. This test renders the
 * real row + the real HpBar underneath it and asserts on what appears in the
 * DOM for each combination of (colorVisionAssist, isCurrentTurn).
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import type { Combatant } from '@campfire/schema';
import '../../src/i18n';
import { CombatantRow, type CombatantRowProps } from '../../src/features/encounters/combat/CombatantRow';

afterEach(() => cleanup());

function baseCombatant(overrides: Partial<Combatant> = {}): Combatant {
  return {
    id: 101,
    encounterId: 1,
    kind: 'monster',
    characterId: null,
    npcId: null,
    name: 'Goblin',
    initiative: 5,
    initMod: 0,
    initiativeBreakdown: null,
    initiativeGroup: null,
    // 5 / 20 = 25% — hpTone() classes this 'low' (< 50%, >= 25%), so
    // hpToneGlyph() returns a real glyph rather than null.
    hpCurrent: 5,
    hpMax: 20,
    spCurrent: 0,
    spMax: 0,
    rpCurrent: 0,
    rpMax: 0,
    eac: null,
    kac: null,
    speed: null,
    hpTemp: 0,
    hpBand: null,
    deathState: 'none',
    deathSaveSuccesses: 0,
    deathSaveFailures: 0,
    conditions: [],
    ruleEntryId: null,
    sortOrder: 0,
    tokenX: null,
    tokenY: null,
    tokenSize: 'medium',
    tokenHiddenByFog: false,
    turnState: {
      used: {},
      movementUsedFt: 0,
      concentration: null,
      pendingConcentrationChecks: [],
      delaying: false,
      readied: null,
    },
    activeEffects: [],
    conditionInstances: [],
    legendaryActions: null,
    statblock: null,
    statblockRevealed: false,
    ...overrides,
  };
}

function renderRow(overrides: Partial<CombatantRowProps> = {}) {
  const { combatant: combatantOverride, ...rest } = overrides;
  const combatant = combatantOverride ?? baseCombatant();
  const props: CombatantRowProps = {
    encounterId: 1,
    hpFeedbackEvents: [],
    isCurrentTurn: false,
    canEditPermission: false,
    syncBlocked: false,
    canEditIdentity: false,
    canRemove: false,
    canSetInitiative: false,
    running: false,
    character: null,
    openCardByDefault: false,
    openCardOnActiveTurn: false,
    campaignId: 1,
    onRollError: vi.fn(),
    onApplyDamage: vi.fn(),
    busy: false,
    conditionSuggestions: [],
    conditionSourceOptions: [],
    defaultConditionSourceCombatantId: null,
    ruleSystem: null,
    onHpDelta: vi.fn(),
    onSetTempHp: vi.fn(),
    onSetDeathSaves: vi.fn(),
    onRollDeathSave: vi.fn(),
    onRollInitiative: vi.fn(),
    onSetInitiative: vi.fn(),
    onClearInitiative: vi.fn(),
    onAddCondition: vi.fn(),
    onRemoveCondition: vi.fn(),
    onRename: vi.fn(),
    onSetHpMax: vi.fn(),
    onSetTokenSize: vi.fn(),
    onRemove: vi.fn(),
    targeting: null,
    colorVisionAssist: false,
    ...rest,
    combatant,
  };
  return render(<CombatantRow {...props} />);
}

describe('CombatantRow colorVisionAssist gates (issue #1942, harness issue #2025)', () => {
  test('turn chevron renders only when colorVisionAssist AND isCurrentTurn are both true', () => {
    renderRow({ colorVisionAssist: true, isCurrentTurn: true });
    expect(screen.getByTestId('combatant-row-turn-chevron-101')).toBeTruthy();
  });

  test('turn chevron does not render when colorVisionAssist is on but it is not this combatant\'s turn', () => {
    renderRow({ colorVisionAssist: true, isCurrentTurn: false });
    expect(screen.queryByTestId('combatant-row-turn-chevron-101')).toBeNull();
  });

  test('turn chevron does not render on its turn when colorVisionAssist is off', () => {
    renderRow({ colorVisionAssist: false, isCurrentTurn: true });
    expect(screen.queryByTestId('combatant-row-turn-chevron-101')).toBeNull();
  });

  test('HpBar renders the danger glyph only when colorVisionAssist is on', () => {
    renderRow({ colorVisionAssist: true });
    const glyph = screen.getByTestId('hp-tone-glyph');
    expect(glyph.textContent).toBe('▲');
    expect(glyph.getAttribute('data-tone')).toBe('low');
  });

  test('HpBar renders no danger glyph when colorVisionAssist is off, even at low HP', () => {
    renderRow({ colorVisionAssist: false });
    expect(screen.queryByTestId('hp-tone-glyph')).toBeNull();
  });
});
