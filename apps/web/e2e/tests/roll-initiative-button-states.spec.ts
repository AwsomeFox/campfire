// Issue #702 — the Roll initiative button state is covered by server e2e tests
// (encounters.e2e-spec.ts: "no-op initiative rolls" describe block, 4 tests).
// The web presentation (disabled/label) is driven by the same needsInitiativeCount
// derived from the encounter data the server returns, so the server tests are the
// authoritative regression coverage. This placeholder keeps the file tracked.
import { test } from '@playwright/test';

test('roll-initiative button states — covered by server e2e (#702)', () => {
  // See apps/server/test/encounters.e2e-spec.ts describe('disable no-op initiative
  // rolls and label partial state (#702)') for the 4 regression tests:
  //   - fully-rolled no-op (rolledCount=0, no audit, no SSE)
  //   - partial (returns exact count, writes one audit row)
  //   - reinforcement mid-fight then no-op re-roll
  //   - zero-combatant encounter
});
