/**
 * Rendered coverage for the DM lifecycle header's initiative controls under a rule system
 * that has no initiative roll (issue #2123, `hasInitiativeRoll: false` — Ironsworn:
 * Starforged).
 *
 * `lifecycle-gate.unit.spec.ts` pins the pure resolvers, but the defect this closes is about
 * what the DM can actually press: the bulk roll button must not be rendered at all (the
 * server 400s that write), and Start must not stay disabled waiting for a roll nobody can
 * make — `EncountersService.start` no longer asks for one either. Both are conditional
 * renders and a `disabled` expression in JSX, so only a real render can tell.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import '../../src/i18n';
import { DmLifecycleHeader, type Props } from '../../src/features/encounters/DmLifecycleHeader';
import { dmLifecycleActions } from '../../src/features/encounters/encounterLifecycleActions';

afterEach(() => cleanup());

/**
 * `GatedControl` swaps the native `disabled` attribute for `aria-disabled` whenever it has a
 * reason to show, so "is this control refusing clicks" has to consider both forms — and this
 * file deliberately asserts across cases that differ in exactly that.
 */
function isDisabled(el: HTMLElement): boolean {
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
}

function renderHeader(overrides: Partial<Props> = {}) {
  const props: Props = {
    canDmWrite: true,
    lifecycle: dmLifecycleActions('preparing'),
    headerBusy: false,
    riskyBlocked: false,
    safetyHoldActive: false,
    needsInitiativeCount: 3,
    initiativeRollSupported: true,
    hasNoCombatants: false,
    undoTurnDisabled: false,
    nextTurnAriaKeyshortcuts: undefined,
    nextTurnTitle: 'Next turn',
    deleteLabel: 'Cancel',
    onRollInitiative: vi.fn(),
    onStart: vi.fn(),
    onUndoTurn: vi.fn(),
    onNextTurn: vi.fn(),
    onRequestEnd: vi.fn(),
    onRequestReopen: vi.fn(),
    onRequestDelete: vi.fn(),
    turnTimerSeconds: 0,
    onSetTurnTimerSeconds: vi.fn(),
    ...overrides,
  };
  return render(<DmLifecycleHeader {...props} />);
}

describe('DmLifecycleHeader — a system with no initiative roll (issue #2123)', () => {
  test('renders no bulk roll control while preparing, and leaves Start enabled with an entirely unrolled roster', () => {
    renderHeader({ initiativeRollSupported: false });

    expect(screen.queryByRole('button', { name: /Roll remaining/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Roll initiative/ })).toBeNull();
    expect(isDisabled(screen.getByRole('button', { name: 'Start' }))).toBe(false);
    // The standing roster hint must not instruct the DM to roll either — the paragraph and
    // the tooltip both come from `startRosterHintReason`.
    expect(screen.queryByText(/Roll initiative for all combatants/)).toBeNull();
  });

  test('contrast case: the same unrolled roster under a system that DOES roll keeps the control and blocks Start', () => {
    renderHeader({ initiativeRollSupported: true });

    expect(screen.getByRole('button', { name: 'Roll remaining (3)' })).toBeTruthy();
    expect(isDisabled(screen.getByRole('button', { name: 'Start' }))).toBe(true);
    expect(screen.getByText(/Roll initiative for all combatants/)).toBeTruthy();
  });

  test('an empty roster still blocks Start for a no-initiative system — that gate is not about initiative', () => {
    renderHeader({ initiativeRollSupported: false, hasNoCombatants: true, needsInitiativeCount: 0 });

    expect(isDisabled(screen.getByRole('button', { name: 'Start' }))).toBe(true);
    expect(screen.getByText(/Add at least one combatant/)).toBeTruthy();
  });

  test('renders no roll control mid-fight either, while Next turn stays available', () => {
    renderHeader({ initiativeRollSupported: false, lifecycle: dmLifecycleActions('running') });

    expect(screen.queryByRole('button', { name: /Roll remaining/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Roll initiative/ })).toBeNull();
    expect(screen.getByTestId('encounter-header-next-turn')).toBeTruthy();
  });

  test('contrast case: mid-fight reinforcements under a rolling system still get the control (issue #54)', () => {
    renderHeader({ initiativeRollSupported: true, lifecycle: dmLifecycleActions('running') });

    expect(screen.getByRole('button', { name: 'Roll remaining (3)' })).toBeTruthy();
  });
});
