/**
 * DM lifecycle header gate reasons (issue #1933) — pins the priority between a safety
 * hold, the sync gate, and each button's own roster/turn-state condition, and that
 * `end`/`reopen`/`delete`/`rollInitiative` never claim a safety-hold reason the server
 * does not actually enforce for them (`EncountersService.assertNoSafetyHold` only guards
 * `start`, `nextTurn`, `undoTurn`, `endTurn`).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  actionApplyGateReason,
  gateReasonText,
  nextTurnGateReason,
  rollInitiativeGateReason,
  startGateReason,
  startRosterHintReason,
  syncOnlyGateReason,
  turnTimerControlDisabled,
  turnTimerControlVisible,
  undoTurnGateReason,
} from '../../src/features/encounters/lifecycleGate';

test.describe('rollInitiativeGateReason (issue #1933)', () => {
  test('nothing blocking: no reason', () => {
    expect(rollInitiativeGateReason({ riskyBlocked: false, needsInitiativeCount: 3 })).toBeNull();
  });
  test('sync gate wins over "already rolled"', () => {
    expect(rollInitiativeGateReason({ riskyBlocked: true, needsInitiativeCount: 0 })).toBe('syncBlocked');
  });
  test('every combatant already has initiative', () => {
    expect(rollInitiativeGateReason({ riskyBlocked: false, needsInitiativeCount: 0 })).toBe('allInitiativeRolled');
  });
});

test.describe('startGateReason (issue #1933)', () => {
  const base = { safetyHoldActive: false, riskyBlocked: false, hasNoCombatants: false, needsInitiativeCount: 0 };

  test('nothing blocking: no reason', () => {
    expect(startGateReason(base)).toBeNull();
  });
  test('a safety hold wins over every other condition', () => {
    expect(
      startGateReason({ ...base, safetyHoldActive: true, riskyBlocked: true, hasNoCombatants: true }),
    ).toBe('safetyHold');
  });
  test('sync gate wins over the roster conditions', () => {
    expect(startGateReason({ ...base, riskyBlocked: true, hasNoCombatants: true })).toBe('syncBlocked');
  });
  test('no combatants at all', () => {
    expect(startGateReason({ ...base, hasNoCombatants: true })).toBe('needsCombatantsToStart');
  });
  test('combatants exist but initiative is incomplete', () => {
    expect(startGateReason({ ...base, needsInitiativeCount: 2 })).toBe('needsInitiativeToStart');
  });
});

/**
 * Issue #1933 review round 2. The standing roster paragraph under Start was derived from
 * `startGateReason`'s single winning key, so a safety hold or a sync outage — both of which
 * outrank the roster in that resolver — silently deleted the "add a combatant" / "roll
 * initiative" instruction from the screen. That is precisely when a DM staring at a
 * greyed-out Start most needs to know which setup step is still owed, and the transient
 * reason was only reachable by hover/focus/tap. The hint therefore resolves independently.
 */
test.describe('startRosterHintReason (issue #1933) — standing, not priority-ranked', () => {
  test('no roster problem: no hint', () => {
    expect(startRosterHintReason({ hasNoCombatants: false, needsInitiativeCount: 0 })).toBeNull();
  });
  test('no combatants at all', () => {
    expect(startRosterHintReason({ hasNoCombatants: true, needsInitiativeCount: 0 })).toBe('needsCombatantsToStart');
  });
  test('combatants exist but initiative is incomplete', () => {
    expect(startRosterHintReason({ hasNoCombatants: false, needsInitiativeCount: 2 })).toBe('needsInitiativeToStart');
  });

  // The regression itself: these are the two states where the old derivation dropped it.
  test('survives a safety hold — the roster step is still what the DM must fix', () => {
    const roster = { hasNoCombatants: true, needsInitiativeCount: 0 };
    expect(startGateReason({ ...roster, safetyHoldActive: true, riskyBlocked: false })).toBe('safetyHold');
    expect(startRosterHintReason(roster)).toBe('needsCombatantsToStart');
  });
  test('survives a sync outage', () => {
    const roster = { hasNoCombatants: false, needsInitiativeCount: 3 };
    expect(startGateReason({ ...roster, safetyHoldActive: false, riskyBlocked: true })).toBe('syncBlocked');
    expect(startRosterHintReason(roster)).toBe('needsInitiativeToStart');
  });

  // ...while still agreeing with the tooltip about WHICH roster step it is, whenever the
  // gate resolver gets far enough down its priority list to name one at all.
  test('agrees with startGateReason whenever no transient gate outranks the roster', () => {
    for (const hasNoCombatants of [false, true]) {
      for (const needsInitiativeCount of [0, 1, 5]) {
        const roster = { hasNoCombatants, needsInitiativeCount };
        expect(startGateReason({ ...roster, safetyHoldActive: false, riskyBlocked: false })).toBe(
          startRosterHintReason(roster),
        );
      }
    }
  });

  /**
   * Issue #2123: a rule system with no initiative roll (Starforged) never satisfies
   * "everyone has rolled", and `EncountersService.start` no longer asks it to — turn order
   * there is the roster order. Without this, Start stayed permanently greyed out with
   * "Roll initiative for all combatants before starting" beside it, pointing at a control
   * the cockpit no longer renders and a write the server refuses.
   */
  test('an unrolled roster is not a setup step for a system with no initiative roll', () => {
    const roster = { hasNoCombatants: false, needsInitiativeCount: 4, initiativeRollSupported: false };
    expect(startRosterHintReason(roster)).toBeNull();
    expect(startGateReason({ ...roster, safetyHoldActive: false, riskyBlocked: false })).toBeNull();
  });
  test('an EMPTY roster still blocks Start for such a system — that gate is not about initiative', () => {
    const roster = { hasNoCombatants: true, needsInitiativeCount: 0, initiativeRollSupported: false };
    expect(startRosterHintReason(roster)).toBe('needsCombatantsToStart');
    expect(startGateReason({ ...roster, safetyHoldActive: false, riskyBlocked: false })).toBe('needsCombatantsToStart');
  });
  test('omitting the flag means the system DOES roll, so every existing caller is unchanged', () => {
    expect(startRosterHintReason({ hasNoCombatants: false, needsInitiativeCount: 4 })).toBe('needsInitiativeToStart');
    expect(
      startRosterHintReason({ hasNoCombatants: false, needsInitiativeCount: 4, initiativeRollSupported: true }),
    ).toBe('needsInitiativeToStart');
  });
  test('the transient gates still outrank it — a hold is what the server would reject first', () => {
    const roster = { hasNoCombatants: false, needsInitiativeCount: 4, initiativeRollSupported: false };
    expect(startGateReason({ ...roster, safetyHoldActive: true, riskyBlocked: false })).toBe('safetyHold');
    expect(startGateReason({ ...roster, safetyHoldActive: false, riskyBlocked: true })).toBe('syncBlocked');
  });
});

/**
 * The resolver above only helps if the header actually calls it for the paragraph. A pure
 * unit test cannot see a component that goes back to deriving the hint from
 * `startGateReason`'s winning key — which is exactly how the first fix for this shipped —
 * so pin the source too. (The user-visible proof lives in the browser spec
 * `gated-control-start-hint.spec.ts`, which raises a real safety hold over REST and asserts
 * the paragraph is still on screen; this is the cheap guard that fails in seconds.)
 */
test.describe('DmLifecycleHeader adoption (issue #1933)', () => {
  test('the standing paragraph is resolved independently of the gate priority', () => {
    const code = readFileSync(
      resolve(__dirname, '../../src/features/encounters/DmLifecycleHeader.tsx'),
      'utf8',
    );

    // `initiativeRollSupported` joined the call in issue #2123 — the paragraph and the
    // tooltip have to agree about whether an unrolled roster is a step the DM still owes.
    expect(code).toMatch(
      /const standingHintKey = startRosterHintReason\(\{ hasNoCombatants, needsInitiativeCount, initiativeRollSupported \}\)/,
    );
    // The paragraph renders off the standing key; only the GatedControl reason uses the
    // priority-ranked one.
    expect(code).toMatch(/\{standingHint && \(/);
    expect(code).not.toMatch(/startReasonKey === 'needsCombatantsToStart'/);
    // ...and it stays wired to the button for assistive tech, as it was before #1933.
    expect(code).toMatch(/aria-describedby=\{standingHint \? START_ROSTER_HINT_ID : undefined\}/);
  });
});

/**
 * `busy` suppresses the reason entirely (issue #1933 review round 4).
 *
 * `GatedControl` strips the native `disabled` attribute whenever a reason is present. So a
 * lifecycle button disabled BECAUSE a request is in flight, which also happens to match some
 * other gate, would become focusable and announce a reason that is not the operative
 * blocker — telling a DM the table is paused when the truth is "your last click is still
 * going". Every resolver deliberately ignores `headerBusy`, so the suppression has to happen
 * where the key is turned into a string. Same rule `syncGateReason` already applies to the
 * death-save controls; this is it applied to the lifecycle header.
 */
test.describe('gateReasonText busy suppression (issue #1933)', () => {
  const t = (key: string) => key;

  test('resolves a reason when nothing is in flight', () => {
    expect(gateReasonText('safetyHold', t)).toBe('run.gate.safetyHold');
    expect(gateReasonText('safetyHold', t, false)).toBe('run.gate.safetyHold');
  });

  test('claims no reason while a request is in flight, even with a live gate', () => {
    for (const key of ['safetyHold', 'syncBlocked', 'needsCombatantsToStart', 'allInitiativeRolled'] as const) {
      expect(gateReasonText(key, t, true)).toBeUndefined();
    }
  });

  test('no key and not busy is still no reason', () => {
    expect(gateReasonText(null, t, false)).toBeUndefined();
  });

  test('every lifecycle-header control passes its busy flag', () => {
    const header = readFileSync(
      resolve(__dirname, '../../src/features/encounters/DmLifecycleHeader.tsx'),
      'utf8',
    );
    // A resolver call that forgets the third argument is the regression — the reason would
    // resolve normally while a request is in flight. Enumerated rather than counted, so a
    // NEW control added to this header fails here too.
    const calls = [...header.matchAll(/gateReasonText\(/g)].map((m) => {
      // Balanced-paren scan — the resolver arguments contain nested calls and object
      // literals, so a non-greedy regex would stop at the first inner `)` and every
      // assertion below would pass vacuously.
      let depth = 0;
      for (let i = m.index + 'gateReasonText'.length; i < header.length; i += 1) {
        if (header[i] === '(') depth += 1;
        else if (header[i] === ')') {
          depth -= 1;
          if (depth === 0) return header.slice(m.index, i + 1);
        }
      }
      throw new Error('unbalanced gateReasonText( call');
    });
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const call of calls) {
      // The standing roster hint is the one deliberate exception: it is a paragraph, not a
      // gated control, so `GatedControl` never touches it and `busy` is irrelevant to it.
      if (call.includes('standingHintKey')) continue;
      expect(call).toMatch(/,\s*headerBusy\s*\)$/);
    }
  });
});

test.describe('actionApplyGateReason (issue #1933)', () => {
  const base = { safetyHoldActive: false, riskyBlocked: false };

  test('nothing blocking: no reason', () => {
    expect(actionApplyGateReason(base)).toBeNull();
  });
  // `ActionResolverService.apply` calls its OWN `assertNotHeld` — a separate gate from
  // `EncountersService.assertNoSafetyHold`, and the one this resolver mirrors.
  test('a safety hold wins over the sync gate', () => {
    expect(actionApplyGateReason({ safetyHoldActive: true, riskyBlocked: true })).toBe('safetyHold');
  });
  test('sync gate alone', () => {
    expect(actionApplyGateReason({ ...base, riskyBlocked: true })).toBe('syncBlocked');
  });

  test('the Apply control is gated, and the preview/roll controls are deliberately not', () => {
    const page = readFileSync(
      resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx'),
      'utf8',
    );
    expect(page).toMatch(/applyGateReason=\{gateReasonText\(actionApplyGateReason\(\{ safetyHoldActive, riskyBlocked \}\), t\)\}/);
    // `applyDisabled` must stay riskyBlocked-only: it also feeds the panel's
    // QuickRollButtons, and `/quick-roll` carries no server-side hold guard (only `apply`
    // does), so folding the hold in here would disable a control the server allows. The
    // hold reaches Apply alone, through `applyGateReason` (issue #1933 review).
    expect(page).toMatch(/applyDisabled=\{riskyBlocked\}/);
    expect(page).not.toMatch(/applyDisabled=\{riskyBlocked \|\| safetyHoldActive\}/);

    const flow = readFileSync(
      resolve(__dirname, '../../src/features/encounters/ActionUseFlow.tsx'),
      'utf8',
    );
    // Scoped to Apply: the server keeps `resolve` open during a hold, so gating the roll
    // buttons would disable something it would have allowed — the mirror-image defect.
    expect(flow).toMatch(/data-testid="action-use-apply"/);
    const quickRolls = flow.slice(flow.indexOf('<QuickRollButtons'), flow.indexOf('<QuickRollButtons') + 400);
    expect(quickRolls).not.toMatch(/applyGateReason/);
    // ...and the Apply-only blocker lives on the Apply button itself, not in the shared
    // `applyDisabled` that QuickRollButtons reads.
    expect(flow).toMatch(/applyDisabled \|\| applyGateReason != null/);
  });
});

test.describe('undoTurnGateReason (issue #1933)', () => {
  const base = { safetyHoldActive: false, riskyBlocked: false, undoTurnDisabled: false };

  test('nothing blocking: no reason', () => {
    expect(undoTurnGateReason(base)).toBeNull();
  });
  test('a safety hold wins over the sync gate and "first turn"', () => {
    expect(
      undoTurnGateReason({ safetyHoldActive: true, riskyBlocked: true, undoTurnDisabled: true }),
    ).toBe('safetyHold');
  });
  test('sync gate wins over "first turn, nothing to undo"', () => {
    expect(undoTurnGateReason({ ...base, riskyBlocked: true, undoTurnDisabled: true })).toBe('syncBlocked');
  });
  test('the first turn of the fight: nothing earlier to undo', () => {
    expect(undoTurnGateReason({ ...base, undoTurnDisabled: true })).toBe('undoNothingToUndo');
  });
});

test.describe('nextTurnGateReason (issue #1933)', () => {
  test('nothing blocking: no reason', () => {
    expect(nextTurnGateReason({ safetyHoldActive: false, riskyBlocked: false })).toBeNull();
  });
  test('a safety hold wins over the sync gate', () => {
    expect(nextTurnGateReason({ safetyHoldActive: true, riskyBlocked: true })).toBe('safetyHold');
  });
  test('sync gate alone', () => {
    expect(nextTurnGateReason({ safetyHoldActive: false, riskyBlocked: true })).toBe('syncBlocked');
  });
});

test.describe('syncOnlyGateReason (issue #1933) — end/reopen/delete are not safety-hold guarded', () => {
  test('not sync-blocked: no reason', () => {
    expect(syncOnlyGateReason(false)).toBeNull();
  });
  test('sync-blocked: syncBlocked', () => {
    expect(syncOnlyGateReason(true)).toBe('syncBlocked');
  });
});

test.describe('turnTimerControlVisible / turnTimerControlDisabled (issue #1935 review) — gated like its siblings', () => {
  test('visible while preparing/running (reopen not yet allowed)', () => {
    expect(turnTimerControlVisible(false)).toBe(true);
  });

  test('hidden once ended (reopen allowed) — a PATCH there would 409 via assertMutable', () => {
    expect(turnTimerControlVisible(true)).toBe(false);
  });

  test('enabled when nothing is blocking', () => {
    expect(turnTimerControlDisabled({ headerBusy: false, riskyBlocked: false })).toBe(false);
  });

  test('disabled while a request is already in flight', () => {
    expect(turnTimerControlDisabled({ headerBusy: true, riskyBlocked: false })).toBe(true);
  });

  test('disabled on a stale sync state, same as the other conflict-prone writes in this header', () => {
    expect(turnTimerControlDisabled({ headerBusy: false, riskyBlocked: true })).toBe(true);
  });
});

test.describe('Turn-timer wiring (issue #1935 review) — the control is actually gated, not just the pure functions', () => {
  // The control moved out of DmLifecycleHeader into RunSessionPage's header meta pill,
  // beside the `Round N · m:ss` readout it configures — it used to sit at the head of the
  // lifecycle control group as an unlabeled stopwatch, a row away from its own effect.
  // Both gates moved with it, which is what this tripwire exists to hold.
  const header = readFileSync(
    resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx'),
    'utf8',
  );

  test('the control is rendered behind turnTimerControlVisible(lifecycle.reopen)', () => {
    // Not anchored to an opening brace: at its new site the guard is one conjunct of a
    // longer condition (`{isDm && turnTimerControlVisible(lifecycle.reopen) && …`). What
    // must hold is that the render is gated on this predicate, not where it sits in the
    // expression.
    expect(header).toMatch(/turnTimerControlVisible\(lifecycle\.reopen\)\s*&&\s*\(/);
  });

  test('its disabled prop comes from turnTimerControlDisabled, not a bare headerBusy', () => {
    const controlBlock = header.slice(header.indexOf('<TurnTimerControl'), header.indexOf('<TurnTimerControl') + 300);
    expect(controlBlock).toMatch(/disabled=\{turnTimerControlDisabled\(\{\s*headerBusy,\s*riskyBlocked\s*\}\)\}/);
  });
});
