/**
 * Component-render coverage for `CombatantRow`'s `syncBlocked` gate driven by the real
 * `gateForWrite` write-class gate (issue #1914).
 *
 * Issue #1914 adds a scoped "continue anyway" override: an owning player may confirm it
 * once past the outage grace period, and `RunSessionPage` then computes a PER-ROW
 * `syncBlocked` value via `gateForWrite('own-combatant', …)` — unblocked for the player's
 * own combatant, still blocked for every other row, even while the same override is
 * active. The pure `gateForWrite` matrix is unit-tested directly in
 * `encounter-sync-state.unit.spec.ts`; this test computes `syncBlocked` the SAME way
 * `RunSessionPage` does — by calling the real `gateForWrite` — and renders the REAL row +
 * its REAL controls on top of that result, so a regression in `gateForWrite` itself (not
 * just a wiring mistake in the component) fails here as a DOM assertion, not only as a
 * bare boolean equality in the pure-function tier.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import type { Combatant } from '@campfire/schema';
import '../../src/i18n';
import { CombatantRow, type CombatantRowProps } from '../../src/features/encounters/combat/CombatantRow';
import { confirmEncounterOverride, gateForWrite } from '../../src/features/encounters/encounterSyncState';

afterEach(() => cleanup());

/** The same outage: stream down, and a player has confirmed the scoped own-combatant override. */
const OWN_COMBATANT_OVERRIDE = confirmEncounterOverride(1, 7, 'own-combatant');

/** `RunSessionPage`'s own row-level gate call, reproduced exactly (see `combatantWriteBlocked`). */
function rowSyncBlocked(isOwnCombatant: boolean): boolean {
  return gateForWrite('own-combatant', { isOwnCombatant }, 'offline', OWN_COMBATANT_OVERRIDE);
}

function baseCombatant(overrides: Partial<Combatant> = {}): Combatant {
  return {
    id: 202,
    encounterId: 1,
    kind: 'character',
    characterId: 55,
    npcId: null,
    name: 'Vex',
    initiative: 12,
    initMod: 0,
    initiativeBreakdown: null,
    initiativeGroup: null,
    hpCurrent: 18,
    hpMax: 30,
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
    // The rows this test cares about (a player's own combatant) are always
    // `canEditPermission: true` — RunSessionPage mounts these controls on ownership,
    // independent of the sync gate; `syncBlocked` is the ONLY thing under test here.
    canEditPermission: true,
    syncBlocked: false,
    canEditIdentity: false,
    canRemove: false,
    canSetInitiative: false,
    running: true,
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

/**
 * `add-condition-toggle` and the HP steppers route through `GatedControl` (issue #1933),
 * which deliberately keeps the native `disabled` attribute `false` while gated (so the
 * control stays keyboard-focusable to show its reason) and signals the block via
 * `aria-disabled="true"` + a swallowed `onClick` instead — see that component's doc
 * comment. The temp-HP input has no such wrapper and uses the plain `disabled` attribute.
 * This helper reads whichever one a given control actually uses.
 */
function isEffectivelyDisabled(el: HTMLElement): boolean {
  if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
    if (el.disabled) return true;
  }
  return el.getAttribute('aria-disabled') === 'true';
}

describe('CombatantRow syncBlocked gate driven by gateForWrite (issue #1914)', () => {
  test('a combatant the confirming player does NOT own stays disabled during the outage, even though the scoped override is active', () => {
    const syncBlocked = rowSyncBlocked(false); // gateForWrite: not this viewer's combatant
    expect(syncBlocked).toBe(true);
    renderRow({ syncBlocked });
    const tempHpInput = screen.getByTestId('temp-hp-input-202') as HTMLInputElement;
    expect(isEffectivelyDisabled(tempHpInput)).toBe(true);
    const addCondition = screen.getByTestId('add-condition-toggle-202') as HTMLButtonElement;
    expect(isEffectivelyDisabled(addCondition)).toBe(true);
  });

  test('the confirming player\'s OWN combatant is unblocked by the same active own-combatant override', () => {
    const syncBlocked = rowSyncBlocked(true); // gateForWrite: this viewer's own combatant
    expect(syncBlocked).toBe(false);
    renderRow({ syncBlocked });
    const tempHpInput = screen.getByTestId('temp-hp-input-202') as HTMLInputElement;
    expect(isEffectivelyDisabled(tempHpInput)).toBe(false);
    const addCondition = screen.getByTestId('add-condition-toggle-202') as HTMLButtonElement;
    expect(isEffectivelyDisabled(addCondition)).toBe(false);
  });

  test('an accessible blocked reason is exposed only for the not-own row, and absent for the own row — both under the SAME active override', () => {
    renderRow({ syncBlocked: rowSyncBlocked(false) });
    const addCondition = screen.getByTestId('add-condition-toggle-202') as HTMLButtonElement;
    expect(addCondition.getAttribute('title')).toBeTruthy();
    expect(addCondition.getAttribute('aria-disabled')).toBe('true');
    cleanup();

    renderRow({ syncBlocked: rowSyncBlocked(true) });
    const addConditionOwn = screen.getByTestId('add-condition-toggle-202') as HTMLButtonElement;
    // GatedControl only renders a `title`/`aria-disabled` while the control is actually
    // gated — the passthrough (ungated) branch changes none of the child's own props.
    expect(addConditionOwn.hasAttribute('title')).toBe(false);
    expect(addConditionOwn.hasAttribute('aria-disabled')).toBe(false);
  });

  test('HP steppers (a distinct own-combatant control) follow the same gateForWrite-derived gate', () => {
    // Scoped to the ±5/±1 stepper buttons specifically (`aria-label` always contains
    // "HP by") — the neighboring "Dmg"/"Heal" exact-amount buttons in the same container
    // have their OWN, syncBlocked-independent disable condition (no amount typed yet), so
    // asserting over every button in the container would conflate two different gates.
    renderRow({ syncBlocked: rowSyncBlocked(false) });
    const steppers = screen.getByTestId('hp-steppers');
    const stepperButtons = Array.from(steppers.querySelectorAll('button[aria-label*="HP by"]'));
    expect(stepperButtons.length).toBe(4);
    for (const btn of stepperButtons) {
      expect(isEffectivelyDisabled(btn as HTMLButtonElement)).toBe(true);
    }
    cleanup();

    renderRow({ syncBlocked: rowSyncBlocked(true) });
    const steppersOwn = screen.getByTestId('hp-steppers');
    const ownButtons = Array.from(steppersOwn.querySelectorAll('button[aria-label*="HP by"]'));
    expect(ownButtons.length).toBe(4);
    for (const btn of ownButtons) {
      expect(isEffectivelyDisabled(btn as HTMLButtonElement)).toBe(false);
    }
  });

  test('turn-topology writes are never relaxed by this override, regardless of ownership — the row-level gate never widens beyond own-combatant', () => {
    expect(gateForWrite('turn-topology', { isOwnCombatant: true }, 'offline', OWN_COMBATANT_OVERRIDE)).toBe(true);
    expect(gateForWrite('turn-topology', { isOwnCombatant: false }, 'offline', OWN_COMBATANT_OVERRIDE)).toBe(true);
  });
});
