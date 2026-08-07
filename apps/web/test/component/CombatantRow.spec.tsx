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
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach, beforeAll } from 'vitest';
import type { Combatant } from '@campfire/schema';
import { MemoryRouter } from 'react-router-dom';
import '../../src/i18n';
import { CombatantRow, type CombatantRowProps } from '../../src/features/encounters/combat/CombatantRow';

// jsdom has no ResizeObserver; RulesHintPopover (issue #1939) only uses it to re-run its
// viewport-clamped positioning math, which these tests do not assert on.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

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
  return render(
    <MemoryRouter>
      <CombatantRow {...props} />
    </MemoryRouter>,
  );
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

describe('CombatantRow condition-tag rules hints (issue #1939)', () => {
  test('a 5e campaign shows a rules-hint affordance on a condition tag, and it opens the mechanical summary', () => {
    renderRow({ ruleSystem: 'dnd5e', combatant: baseCombatant({ conditions: ['Restrained'] }) });
    const trigger = screen.getByTestId('rules-hint-trigger-Restrained');
    fireEvent.click(trigger);
    const panel = screen.getByTestId('rules-hint-panel-Restrained');
    expect(panel.textContent).toContain('Speed becomes 0');
  });

  test('an adapter with no authored hints (Starforged) shows no affordance and no 5e text', () => {
    renderRow({ ruleSystem: 'starforged', combatant: baseCombatant({ conditions: ['Restrained'] }) });
    expect(screen.queryByTestId('rules-hint-trigger-Restrained')).toBeNull();
    expect(screen.queryByText(/Speed becomes 0/)).toBeNull();
  });

  test('a leveled instance ("Frightened 2") resolves the same base-name hint as its unleveled form', () => {
    renderRow({ ruleSystem: 'dnd5e', combatant: baseCombatant({ conditions: ['Frightened 2'] }) });
    const trigger = screen.getByTestId('rules-hint-trigger-Frightened 2');
    fireEvent.click(trigger);
    const panel = screen.getByTestId('rules-hint-panel-Frightened 2');
    expect(panel.textContent).toContain('disadvantage on ability checks and attack rolls');
  });

  test('no "Full rule" link when rulesHintCompendiumAvailable is false', () => {
    renderRow({
      ruleSystem: 'dnd5e',
      combatant: baseCombatant({ conditions: ['Restrained'] }),
      rulesHintCompendiumAvailable: false,
      rulesHintCampaignId: 7,
    });
    fireEvent.click(screen.getByTestId('rules-hint-trigger-Restrained'));
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('a "Full rule" link to the compendium search appears once rulesHintCompendiumAvailable is true', () => {
    renderRow({
      ruleSystem: 'dnd5e',
      combatant: baseCombatant({ conditions: ['Restrained'] }),
      rulesHintCompendiumAvailable: true,
      rulesHintCampaignId: 7,
    });
    fireEvent.click(screen.getByTestId('rules-hint-trigger-Restrained'));
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/c/7/compendium?q=Restrained');
  });
});
