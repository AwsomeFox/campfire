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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, test, expect, vi, afterEach, beforeAll } from 'vitest';
import { Character } from '@campfire/schema';
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
    // Issue #1944: DM-only Award control mount gate, same shape as canRemove above.
    canAwardSpecialResource: false,
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
  // A PC row mounts CharacterStatCard, which issues a react-query useQuery for the
  // combatant's usable actions — so the row needs a client in context. Retries off and
  // a fresh client per render keep one test's fetch state out of the next one's.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CombatantRow {...props} />
      </QueryClientProvider>
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

/**
 * Mount-gate coverage for the DM Award control (issue #1944).
 *
 * The helpers behind it (`findSpecialResource`, `canAdjustSpecialResource`,
 * `specialResourceAdjustBody`) are unit-tested in
 * `e2e/tests/character-special-resource.unit.spec.ts`, but nothing covered the
 * four-condition JSX gate that decides whether the control appears at all:
 * `kind === 'character' && character && canAwardSpecialResource && specialResourceDef`.
 * That gate is where the consequential failures live — a non-DM seeing an Award
 * button, or a 5e-shaped affordance appearing for a table whose adapter declares
 * neither inspiration nor hero points. A source-scan test cannot tell `&&` from
 * `||` here; this renders the real row for each combination instead.
 */
function pcCombatant() {
  return baseCombatant({ id: 202, kind: 'character', characterId: 7, name: 'Ayla' });
}

// Built through the real schema rather than hand-written, so a new required field
// on `Character` fails here loudly instead of being papered over by a blind cast.
const partyCharacter: Character = Character.parse({
  id: 7,
  campaignId: 1,
  name: 'Ayla',
  resources: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('CombatantRow special-resource Award gate (issue #1944)', () => {
  test('renders for a DM on a PC row when the adapter declares inspiration', () => {
    renderRow({ combatant: pcCombatant(), character: partyCharacter, canAwardSpecialResource: true, ruleSystem: 'dnd5e' });
    const award = screen.getByTestId('award-special-resource-202');
    expect(award.textContent).toContain('Inspiration');
  });

  test('does not render for a non-DM viewer, even on the same PC row and adapter', () => {
    renderRow({ combatant: pcCombatant(), character: partyCharacter, canAwardSpecialResource: false, ruleSystem: 'dnd5e' });
    expect(screen.queryByTestId('award-special-resource-202')).toBeNull();
  });

  test('does not render when the adapter declares neither inspiration nor hero points', () => {
    // 'osr' declares no resources at all. Note the contrast with `ruleSystem: null`,
    // which is NOT this case: `ruleSystemAdapter(null)` resolves to dnd5e app-wide, so an
    // unset rule system deliberately DOES show Inspiration, consistent with every other
    // 5e-shaped affordance on the page. Asserting null-means-nothing here would have
    // pinned the wrong contract.
    renderRow({ combatant: pcCombatant(), character: partyCharacter, canAwardSpecialResource: true, ruleSystem: 'osr' });
    expect(screen.queryByTestId('award-special-resource-202')).toBeNull();
  });

  test('does not render on a monster row, which has no character to award to', () => {
    renderRow({ combatant: baseCombatant(), character: null, canAwardSpecialResource: true, ruleSystem: 'dnd5e' });
    expect(screen.queryByTestId('award-special-resource-101')).toBeNull();
  });

  test('is enabled on an untouched pool (nothing awarded yet) and disabled at the adapter cap', () => {
    renderRow({ combatant: pcCombatant(), character: partyCharacter, canAwardSpecialResource: true, ruleSystem: 'dnd5e' });
    const untouched = screen.getByTestId('award-special-resource-202').querySelector('button') as HTMLButtonElement;
    expect(untouched.disabled).toBe(false);
    cleanup();

    // `used: 0` of `max: 1` is a FULL pool per `resourceAvailability` — there is
    // nothing left to top up, so Award must be off. This is the boundary the sheet's
    // own Restore button uses, and getting it backwards is invisible without a render.
    // No `key` field — the map key IS the resource key in `Character.resources`.
    const atCap: Character = { ...partyCharacter, resources: { inspiration: { name: 'Inspiration', max: 1, used: 0, recharge: 'special' } } };
    renderRow({ combatant: pcCombatant(), character: atCap, canAwardSpecialResource: true, ruleSystem: 'dnd5e' });
    const full = screen.getByTestId('award-special-resource-202').querySelector('button') as HTMLButtonElement;
    expect(full.disabled).toBe(true);
  });

  // Issue #1944 review: `CombatantRowProps.syncBlocked`'s own doc says "EVERY control
  // that performs a write must consult both — permission for mount, this for disabled".
  // The Award button (added by this same feature) did not, until this fix.
  test('is disabled while syncBlocked, even on an otherwise-awardable untouched pool', () => {
    renderRow({ combatant: pcCombatant(), character: partyCharacter, canAwardSpecialResource: true, ruleSystem: 'dnd5e', syncBlocked: false });
    const notBlocked = screen.getByTestId('award-special-resource-202').querySelector('button') as HTMLButtonElement;
    expect(notBlocked.disabled).toBe(false);
    cleanup();

    renderRow({ combatant: pcCombatant(), character: partyCharacter, canAwardSpecialResource: true, ruleSystem: 'dnd5e', syncBlocked: true });
    const blocked = screen.getByTestId('award-special-resource-202').querySelector('button') as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
  });
});
