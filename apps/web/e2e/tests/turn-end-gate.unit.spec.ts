/**
 * End-turn gate priority (issue #1933) — pins which reason wins when a safety hold, the
 * sync gate, and the `dmControlsTurns` setting are true at once, without a browser.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { turnEndGateReason, turnEndStandingReason } from '../../src/features/encounters/turnEndGate';

const BASE = {
  canEndTurn: true,
  isYourTurn: true,
  dmControlsTurns: false,
  safetyHoldActive: false,
  syncBlocked: false,
};

test.describe('turnEndGateReason (issue #1933)', () => {
  test('nothing blocking: no reason', () => {
    expect(turnEndGateReason(BASE)).toBeNull();
  });

  test('a safety hold wins over everything else, even when canEndTurn is false too', () => {
    expect(turnEndGateReason({ ...BASE, safetyHoldActive: true })).toBe('safetyHold');
    expect(
      turnEndGateReason({
        ...BASE,
        canEndTurn: false,
        dmControlsTurns: true,
        safetyHoldActive: true,
        syncBlocked: true,
      }),
    ).toBe('safetyHold');
  });

  test('canEndTurn true but the sync gate is blocking: syncBlocked', () => {
    expect(turnEndGateReason({ ...BASE, syncBlocked: true })).toBe('syncBlocked');
  });

  test('a player on their own turn but the DM controls turns: dmControlsTurns', () => {
    expect(
      turnEndGateReason({ ...BASE, canEndTurn: false, isYourTurn: true, dmControlsTurns: true }),
    ).toBe('dmControlsTurns');
  });

  test('a plain onlooker (not the DM, not this turn\'s owner): no reason — applicability wins over dmControlsTurns', () => {
    // TurnWorkspace renders for every viewer of a running encounter, not only the DM/owner
    // (only its action-economy detail section is owner/DM-gated) — a true onlooker reaches
    // this resolver with both canEndTurn and isYourTurn false.
    expect(
      turnEndGateReason({ ...BASE, canEndTurn: false, isYourTurn: false, dmControlsTurns: false }),
    ).toBeNull();
  });

  test('a plain onlooker during a safety hold STILL gets no reason — applicability must be decided before the hold, or a disabled End-turn button flickers into existence for viewers who never had one', () => {
    expect(
      turnEndGateReason({
        ...BASE,
        canEndTurn: false,
        isYourTurn: false,
        dmControlsTurns: false,
        safetyHoldActive: true,
      }),
    ).toBeNull();
  });

  test('syncBlocked is ignored once canEndTurn is already false for a different reason', () => {
    // dmControlsTurns wins; syncBlocked does not also apply once the button is
    // fundamentally not the player's to press right now.
    expect(
      turnEndGateReason({ ...BASE, canEndTurn: false, dmControlsTurns: true, syncBlocked: true }),
    ).toBe('dmControlsTurns');
  });
});

/**
 * The resolver is pure and knows nothing about in-flight requests, so the busy suppression
 * lives at the adoption site — and a pure test cannot see a component that forgets it
 * (issue #1933 review). `showButton` must keep keying off the UNsuppressed reason, or an
 * in-flight request would make the button vanish for a player who had one.
 */
test.describe('TurnWorkspace adoption (issue #1933)', () => {
  test('the end-turn reason is suppressed while busy, but applicability is not', () => {
    const code = readFileSync(
      resolve(__dirname, '../../src/features/encounters/TurnWorkspace.tsx'),
      'utf8',
    );
    // Narrow flag on purpose: the broad `busy` also covers unrelated action-economy
    // writes, and suppressing on those would blank a standing dmControlsTurns explanation
    // mid-save (issue #1933 review).
    expect(code).toMatch(/const gateReason = gateReasonKey && !endTurnBusy \? t\(`run\.gate\.\$\{gateReasonKey\}`\) : undefined;/);
    expect(code).not.toMatch(/gateReasonKey && !busy/);
    expect(code).toMatch(/const showButton = turn\.canEndTurn \|\| gateReasonKey != null;/);
  });
});

/**
 * `dmControlsTurns` is a campaign SETTING, not a passing condition, so it gets a
 * permanently visible line rather than a hover-only tooltip — the same distinction the
 * Start button draws between its roster hints and the transient gates (issue #1933 review).
 * Adopting GatedControl had replaced that line with a bubble, leaving a sighted mouse user
 * with a dead control and no explanation.
 */
test.describe('turnEndStandingReason (issue #1933) — standing, not transient', () => {
  test('a player whose DM controls turns gets the standing reason', () => {
    expect(turnEndStandingReason({ canEndTurn: false, isYourTurn: true, dmControlsTurns: true })).toBe('dmControlsTurns');
  });
  test('it is unaffected by the transient gates that outrank it in the tooltip', () => {
    const standing = { canEndTurn: false, isYourTurn: true, dmControlsTurns: true };
    expect(turnEndGateReason({ ...standing, safetyHoldActive: true, syncBlocked: true })).toBe('safetyHold');
    expect(turnEndStandingReason(standing)).toBe('dmControlsTurns');
  });
  test('a plain onlooker still gets nothing — applicability wins', () => {
    expect(turnEndStandingReason({ canEndTurn: false, isYourTurn: false, dmControlsTurns: true })).toBeNull();
  });
  test('a viewer who CAN end the turn has no standing reason', () => {
    expect(turnEndStandingReason({ canEndTurn: true, isYourTurn: true, dmControlsTurns: true })).toBeNull();
  });

  test('the workspace renders it as a visible line and de-dupes the tooltip', () => {
    const code = readFileSync(
      resolve(__dirname, '../../src/features/encounters/TurnWorkspace.tsx'),
      'utf8',
    );
    expect(code).toMatch(/const standingKey = turnEndStandingReason\(/);
    expect(code).toMatch(/\{standingReason && \(/);
    // The tooltip must not repeat what the visible line already says.
    expect(code).toMatch(/const tooltipReason = gateReasonKey === standingKey \? undefined : gateReason;/);
    expect(code).toMatch(/<GatedControl reason=\{tooltipReason\}>/);
    expect(code).toMatch(/aria-describedby=\{standingReason \? TURN_END_STANDING_ID : undefined\}/);
    // The child's own `disabled` must cover permission independently. GatedControl only
    // swallows the click while a reason is present, and the dedupe above deliberately passes
    // undefined — so relying on the wrapper to block the write leaves the button live for a
    // player who may never end their turn (issue #1933 review). The wrapper is an affordance,
    // not an authorization.
    //
    // Anchored on the End-turn button, NOT grepped file-wide. The first version of this
    // assertion searched for the literal anywhere in TurnWorkspace.tsx, so it went green
    // while the guard actually sat on `SlotChip` three hundred lines away — disabling the
    // action-economy chips for that same player while End turn stayed live. A placement bug
    // the placement test could not see; Codex and Devin both caught it, neither did this.
    const endTurnAnchor = code.indexOf('data-testid="workspace-end-turn"');
    expect(endTurnAnchor).toBeGreaterThan(-1);
    const endTurnBtn = code.slice(code.lastIndexOf('<Btn', endTurnAnchor), endTurnAnchor);
    // Issue #1914: renamed from `controlsDisabled` to `endTurnControlsDisabled` (=
    // `busy || endTurnBlocked`) — end/next/undo turn is a turn-topology write, unblockable
    // only by the DM-grade override, never by the scoped player 'own-combatant' override
    // that may now relax `actionsDisabled` for the OTHER controls in this workspace.
    expect(endTurnBtn).toMatch(/disabled=\{endTurnControlsDisabled \|\| !turn\.canEndTurn\}/);

    // ...and the action-economy chips must NOT inherit it. `canEndTurn` is
    // `isDm || (isYourTurn && !dmControlsTurns)`, but nothing server-side gates a player's
    // own /turn-state writes on ending the turn — movement and slot use stay theirs, and the
    // standard-action bar beside these chips is keyed to `actionDisabled` alone.
    const chipAnchor = code.indexOf('<SlotChip');
    expect(chipAnchor).toBeGreaterThan(-1);
    const chip = code.slice(chipAnchor, code.indexOf('/>', chipAnchor));
    expect(chip).toMatch(/disabled=\{controlsDisabled\}/);
    // Scoped to the `disabled` expression, not the whole chip: the comment sitting on this
    // prop explains why the permission is deliberately absent, so it names `canEndTurn` in
    // prose. A bare substring search would fail on the documentation of the very rule.
    expect(chip).not.toMatch(/disabled=\{[^}]*canEndTurn/);
  });
});

/**
 * Issue #1914 — the scoped player override for own-combatant writes must NOT also unblock
 * End-turn (a turn-topology write). `TurnWorkspace` bundled every conflict-prone control
 * (action economy, spellbook, delay/ready, the in-workspace death-save roll, AND End-turn)
 * behind one `actionsDisabled` flag; relaxing that flag for a scoped override without
 * splitting End-turn out would have silently let a player end their own turn during an
 * outage the moment they confirmed the unrelated "update my own combatant" prompt — the
 * exact "guard applied to one branch but not its mirror" shape this issue calls out.
 */
test.describe('TurnWorkspace endTurnBlocked split (issue #1914)', () => {
  test('turnEndGateReason reads endTurnBlocked, NOT actionsDisabled, for its syncBlocked input', () => {
    const code = readFileSync(
      resolve(__dirname, '../../src/features/encounters/TurnWorkspace.tsx'),
      'utf8',
    );
    expect(code).toMatch(/syncBlocked: endTurnBlocked,/);
    expect(code).not.toMatch(/syncBlocked: actionsDisabled,/);
  });

  test('endTurnBlocked defaults to actionsDisabled for an un-migrated caller, but RunSessionPage passes it explicitly and independently', () => {
    const workspaceCode = readFileSync(
      resolve(__dirname, '../../src/features/encounters/TurnWorkspace.tsx'),
      'utf8',
    );
    expect(workspaceCode).toMatch(/endTurnBlocked = actionsDisabled,/);

    const runSessionCode = readFileSync(
      resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx'),
      'utf8',
    );
    // The parent wires the two independently: `actionsDisabled` may be relaxed by ownership
    // via `gateForWrite('own-combatant', …)`, while `endTurnBlocked` stays `riskyBlocked` —
    // the unrelaxed, DM-grade-only gate — so ending a turn can never ride along on a
    // same-outage own-combatant confirmation.
    expect(runSessionCode).toMatch(/actionsDisabled=\{gateForWrite\('own-combatant', \{ isOwnCombatant: turnWorkspace\?\.isYourTurn === true \}, encounterSync, effectiveEncounterSyncOverride\)\}/);
    expect(runSessionCode).toMatch(/endTurnBlocked=\{riskyBlocked\}/);
  });
});
