/**
 * Component-render coverage for the condition-tag rules-hint affordance in
 * `PlayerVitalsHeader` (issue #1939) and special-resource Spend pip (issue #1944).
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, test, expect, afterEach, beforeAll } from 'vitest';
import type { ComponentProps } from 'react';
import { Character, Combatant } from '@campfire/schema';
import type { CustomMechanicsProfile } from '@campfire/schema';
import { MemoryRouter } from 'react-router-dom';
import '../../src/i18n';
import { PlayerVitalsHeader } from '../../src/features/encounters/PlayerVitalsHeader';

// jsdom has no ResizeObserver; RulesHintPopover only uses it to re-run its
// viewport-clamped positioning math, which these tests do not assert on.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => cleanup());

function combatantWithCondition(condition: string): Combatant {
  return {
    id: 201,
    encounterId: 1,
    kind: 'character',
    characterId: null,
    npcId: null,
    name: 'Aria',
    initiative: 12,
    initMod: 0,
    initiativeBreakdown: null,
    initiativeGroup: null,
    hpCurrent: 18,
    hpMax: 24,
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
    conditions: [condition],
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
  };
}

function renderHeader(condition: string, overrides: Partial<ComponentProps<typeof PlayerVitalsHeader>> = {}) {
  return render(
    <MemoryRouter>
      <PlayerVitalsHeader
        combatants={[combatantWithCondition(condition)]}
        charactersById={new Map()}
        {...overrides}
      />
    </MemoryRouter>,
  );
}

describe('PlayerVitalsHeader condition-tag rules hints (issue #1939)', () => {
  test('a 5e campaign shows a rules-hint affordance on a condition tag, and it opens the mechanical summary', () => {
    renderHeader('Restrained', { ruleSystem: 'dnd5e' });
    const trigger = screen.getByTestId('rules-hint-trigger-Restrained');
    fireEvent.click(trigger);
    const panel = screen.getByTestId('rules-hint-panel-Restrained');
    expect(panel.textContent).toContain('Speed becomes 0');
  });

  test('an adapter with no authored hints (Starforged) shows no affordance and no 5e text', () => {
    renderHeader('Restrained', { ruleSystem: 'starforged' });
    expect(screen.queryByTestId('rules-hint-trigger-Restrained')).toBeNull();
    expect(screen.queryByText(/Speed becomes 0/)).toBeNull();
  });

  test('a leveled instance ("Frightened 2") resolves the same base-name hint as its unleveled form', () => {
    renderHeader('Frightened 2', { ruleSystem: 'dnd5e' });
    const trigger = screen.getByTestId('rules-hint-trigger-Frightened 2');
    fireEvent.click(trigger);
    const panel = screen.getByTestId('rules-hint-panel-Frightened 2');
    expect(panel.textContent).toContain('disadvantage on ability checks and attack rolls');
  });

  test('no "Full rule" link when rulesHintCompendiumAvailable is not set', () => {
    renderHeader('Restrained', { ruleSystem: 'dnd5e', campaignId: 9 });
    fireEvent.click(screen.getByTestId('rules-hint-trigger-Restrained'));
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('a "Full rule" link to the compendium search appears once rulesHintCompendiumAvailable is true', () => {
    renderHeader('Restrained', { ruleSystem: 'dnd5e', campaignId: 9, rulesHintCompendiumAvailable: true });
    fireEvent.click(screen.getByTestId('rules-hint-trigger-Restrained'));
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/c/9/compendium?q=Restrained');
  });
});

// A homebrew profile in the shape `rule-system-adapter-custom-profile.unit.spec.ts` uses.
// It declares no `resources` at all — `createOsrVariantAdapter` never adds an
// inspiration/heroPoints entry — so a correctly-resolved adapter here must show no pip.
const HOMEBREW_PROFILE: CustomMechanicsProfile = {
  slug: 'sw-banded-homebrew',
  label: 'Shadowdark / Banded Homebrew',
  mechanicsSummary: 'Custom homebrew profile with Swords & Wizardry ability table',
  abilityTable: 'sw-banded',
  abilityCap: 3,
  saves: ['death', 'wand', 'paralysis', 'breath', 'spell'],
  acMode: 'ascending',
  acAnchor: 10,
  initiativeMode: 'group',
  initiativeDie: 6,
  initiativeUsesDexMod: false,
  tiebreak: 'dex-then-order',
  conditions: ['blinded', 'charmed', 'poisoned'],
};

const character: Character = Character.parse({
  id: 7,
  campaignId: 1,
  name: 'Ayla',
  resources: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

// Already awarded (available: 1, per resourceAvailability's `max - used`), so the Spend
// button's OWN cap/zero gating (`canAdjustSpecialResource`) is satisfied — isolating the
// sync-gate assertions below from that separate disabled condition.
const awardedCharacter: Character = Character.parse({
  ...character,
  resources: { inspiration: { name: 'Inspiration', max: 1, used: 0, recharge: 'special' } },
});

const combatant: Combatant = Combatant.parse({
  id: 202,
  encounterId: 1,
  kind: 'character',
  characterId: 7,
  name: 'Ayla',
  initiative: 5,
  conditions: [],
});

describe('PlayerVitalsHeader special-resource pip — customMechanicsProfile (issue #1944 review)', () => {
  test('renders the pip for an unregistered ruleSystem slug with NO profile (existing 5e-fallback behavior)', () => {
    render(
      <PlayerVitalsHeader
        combatants={[combatant]}
        charactersById={new Map([[7, character]])}
        ruleSystem="sw-banded-homebrew"
      />,
    );
    expect(screen.getByTestId('special-resource-pip-7')).toBeTruthy();
  });

  test('does NOT render the pip when the SAME unregistered slug resolves through its homebrew profile', () => {
    // This is the bug: without customMechanicsProfile threaded through,
    // ruleSystemAdapter('sw-banded-homebrew') falls back to Dnd5eAdapter and this
    // pip renders "Inspiration" for a table that declares no such resource — while
    // CombatantRow (which does receive the profile) correctly shows no Award control.
    render(
      <PlayerVitalsHeader
        combatants={[combatant]}
        charactersById={new Map([[7, character]])}
        ruleSystem="sw-banded-homebrew"
        customMechanicsProfile={HOMEBREW_PROFILE}
      />,
    );
    expect(screen.queryByTestId('special-resource-pip-7')).toBeNull();
  });

  test('a registered slug (dnd5e) still renders the pip even with an (irrelevant) profile passed', () => {
    render(
      <PlayerVitalsHeader
        combatants={[combatant]}
        charactersById={new Map([[7, character]])}
        ruleSystem="dnd5e"
        customMechanicsProfile={HOMEBREW_PROFILE}
      />,
    );
    // A registered slug always wins over a profile per ruleSystemAdapter's own contract
    // (the profile is consulted only for an UNREGISTERED slug) — pinned here so this
    // suite also fails if that resolution order regresses.
    expect(screen.getByTestId('special-resource-pip-7')).toBeTruthy();
  });
});

describe('PlayerVitalsHeader special-resource pip — sync gate (issue #1944 review)', () => {
  test('Spend button is enabled when not syncBlocked and the pool has availability', () => {
    render(
      <PlayerVitalsHeader
        combatants={[combatant]}
        charactersById={new Map([[7, awardedCharacter]])}
        ruleSystem="dnd5e"
        syncBlocked={false}
      />,
    );
    const spend = screen.getByTestId('special-resource-pip-7').querySelector('button') as HTMLButtonElement;
    expect(spend.disabled).toBe(false);
  });

  test('Spend button is disabled while syncBlocked, even though the pool has availability', () => {
    render(
      <PlayerVitalsHeader
        combatants={[combatant]}
        charactersById={new Map([[7, awardedCharacter]])}
        ruleSystem="dnd5e"
        syncBlocked
      />,
    );
    const spend = screen.getByTestId('special-resource-pip-7').querySelector('button') as HTMLButtonElement;
    expect(spend.disabled).toBe(true);
  });
});
