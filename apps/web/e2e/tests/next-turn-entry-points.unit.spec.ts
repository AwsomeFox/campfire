/**
 * Every way to advance a turn honours the safety hold (issue #1933 review round 3).
 *
 * `EncountersService.nextTurn` rejects under `assertNoSafetyHold`. The run page offers
 * THREE ways to call it, and the first pass at #1933 guarded two:
 *
 *  1. the `encounterNextTurn` keyboard shortcut — guarded via `canExecute`;
 *  2. `DmLifecycleHeader`'s Next-turn button — wrapped in `GatedControl` with
 *     `nextTurnGateReason`;
 *  3. the lair-action card's `Done →` button — missed, still `disabled={headerBusy ||
 *     riskyBlocked}` with the same `nextTurn` handler.
 *
 * A DM resolving a lair action during a table pause therefore fired a write the server
 * refuses and got a bare error, which is the precise outcome this issue exists to remove —
 * on the one entry point nobody thought to look at. Both Devin and Codex found it
 * independently, which is a fair signal that "three call sites, two remembered" is a shape
 * worth pinning rather than re-checking by eye each round.
 *
 * Source-assertion spec (this repo's Playwright "unit" convention — see
 * action-use-system-math-notice.unit.spec.ts): the failure is a MISSING wrapper, and no
 * rendered assertion can enumerate the call sites that were never written.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_SESSION_FILE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

test.describe('nextTurn entry points (issue #1933)', () => {
  test('every entry point consults the safety hold', () => {
    const code = readFileSync(RUN_SESSION_FILE, 'utf8');

    // (1) Keyboard shortcut: refuses to execute while held.
    const canExecute = code.slice(code.indexOf('canExecute: () =>'), code.indexOf('execute: nextTurn'));
    expect(canExecute).toMatch(/safetyHoldActive/);

    // (3) Every button on THIS page that calls `nextTurn` directly sits inside a
    // GatedControl carrying the shared resolver's reason. Enumerated from the handler
    // bindings rather than by naming the lair-action button, so a FOURTH such control added
    // later fails here too — which is the whole point, since the defect was an entry point
    // nobody remembered to look at.
    const bindings = [...code.matchAll(/onClick=\{nextTurn\}/g)];
    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      const preceding = code.slice(Math.max(0, binding.index - 700), binding.index);
      expect(preceding).toMatch(/<GatedControl reason=\{gateReasonText\(nextTurnGateReason\(/);
    }

    // (2) The header's binding is the `onNextTurn` prop, gated inside DmLifecycleHeader —
    // out of reach of the loop above, so assert it at its own source.
    const header = readFileSync(
      resolve(__dirname, '../../src/features/encounters/DmLifecycleHeader.tsx'),
      'utf8',
    );
    expect(header).toMatch(/<GatedControl reason=\{gateReasonText\(nextTurnGateReason\(\{ safetyHoldActive, riskyBlocked \}\), t\)\}>/);

    // One shared resolver, one shared string lookup — `gateReasonText` lives in
    // lifecycleGate.ts precisely so a per-component copy cannot drift again.
    expect(code).toMatch(/import \{ gateReasonText, nextTurnGateReason \} from '\.\/lifecycleGate'/);
    expect(header).not.toMatch(/function gateReasonText/);
  });
});
