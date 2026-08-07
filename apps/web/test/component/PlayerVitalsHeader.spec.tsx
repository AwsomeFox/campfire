/**
 * Component-render coverage for the condition-tag rules-hint affordance in
 * `PlayerVitalsHeader` (issue #1939).
 *
 * A source scan can confirm `conditionHintKey(` and `<RulesHintPopover` both appear in the
 * file; it cannot tell whether the popover is actually gated on the right adapter, whether
 * a non-5e campaign leaks 5e condition text, or whether the "Full rule" link is wired to the
 * right compendium query. This test renders the real header and drives it.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, test, expect, afterEach, beforeAll } from 'vitest';
import type { ComponentProps } from 'react';
import type { Combatant } from '@campfire/schema';
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
