import {
  aiDmReadinessCheckBlocks,
  aiDmReadinessProgress,
  aiDmSetupComplete,
  type AiDmMode,
  type AiDmReadiness,
  type AiDmReadinessCheck,
} from '@campfire/schema';

/**
 * The readiness rules the AI setup checklist renders from (issue #519).
 *
 * These are asserted here — in the server suite, which CI actually runs — rather than in a
 * web `*.unit.spec.ts` (never executed; issue #1516), because they encode two invariants
 * that a UI regression would otherwise break silently:
 *
 *   1. an OFF seat is never "ready", however green its prerequisites are. `driverOk` used
 *      to be derived from the configuration checks alone (none of which reads seat.mode),
 *      so a fully configured but switched-off table got a green "the AI DM is ready … the
 *      AI is co-DMing" banner over an AI that does nothing;
 *   2. the progress tally reaches its total EXACTLY when the ready banner fires. Counting
 *      advisory `warning` checks against the total stranded a runnable table at "10 of 11"
 *      beside that same green banner — one checklist saying two contradictory things about
 *      one state, which is the defect class this checklist exists to remove.
 */

const MODES: readonly AiDmMode[] = ['off', 'co_dm', 'driver'];

function check(over: Partial<AiDmReadinessCheck> & Pick<AiDmReadinessCheck, 'key'>): AiDmReadinessCheck {
  return {
    ok: true,
    status: 'ok',
    actor: 'dm',
    title: over.key,
    detail: over.key,
    detailKey: `${over.key}.ok`,
    detailParams: {},
    requiredForDriver: false,
    fixHref: null,
    ...over,
  };
}

/**
 * Build readiness the way `AiDmService.getReadiness` does — including its two aggregates —
 * so the property below is exercised against the server's real formulas rather than against
 * values hand-picked to satisfy it.
 */
function readinessFor(mode: AiDmMode, checks: AiDmReadinessCheck[]): Pick<AiDmReadiness, 'ok' | 'driverOk' | 'mode' | 'checks'> {
  const modeCheck = checks.find((c) => c.key === 'mode');
  const seatArmed = !!modeCheck?.ok;
  return {
    mode,
    checks,
    ok: checks.every((c) => c.ok || c.status === 'warning'),
    driverOk: checks.filter((c) => c.requiredForDriver).every((c) => c.ok) && seatArmed && mode === 'driver',
  };
}

/** The blocking checks a fully configured table produces, parameterised by mode. */
function configuredChecks(mode: AiDmMode): AiDmReadinessCheck[] {
  const armed = mode !== 'off';
  return [
    check({ key: 'serverFlag', requiredForDriver: true }),
    check({ key: 'serverCap', requiredForDriver: true }),
    check({ key: 'provider', requiredForDriver: true }),
    check({ key: 'model', requiredForDriver: true }),
    check({ key: 'mode', ok: armed, status: armed ? 'ok' : 'blocked' }),
    check({ key: 'budget', requiredForDriver: true }),
    check({ key: 'writeMode', requiredForDriver: true }),
    check({ key: 'secretPolicy' }),
    check({ key: 'driverTools', requiredForDriver: true }),
  ];
}

/** The advisory checks that are never ticked off for a table with no session-zero content. */
const ADVISORY: AiDmReadinessCheck[] = [
  check({ key: 'rulesContent', ok: false, status: 'warning' }),
  check({ key: 'supportConsent', ok: false, status: 'warning' }),
];

describe('AI-DM readiness rules (#519)', () => {
  describe('aiDmSetupComplete', () => {
    it('never calls an off seat ready, however green the prerequisites are', () => {
      // The exact shape the bug produced: everything configured, mode still off.
      expect(aiDmSetupComplete({ ok: true, driverOk: true, mode: 'off' })).toBe(false);
      expect(aiDmSetupComplete({ ok: false, driverOk: false, mode: 'off' })).toBe(false);
    });

    it('gives each mode its own readiness', () => {
      // Driver: the driver aggregate decides — and it includes "the seat is in driver mode".
      expect(aiDmSetupComplete({ ok: true, driverOk: true, mode: 'driver' })).toBe(true);
      expect(aiDmSetupComplete({ ok: true, driverOk: false, mode: 'driver' })).toBe(false);
      // …and a blocking check outside the driver-required set still blocks the banner, so it
      // can never fire while the tally is short.
      expect(aiDmSetupComplete({ ok: false, driverOk: true, mode: 'driver' })).toBe(false);
      // Co-DM is propose-only, so the blocking-check aggregate decides; driver extras are moot.
      expect(aiDmSetupComplete({ ok: true, driverOk: false, mode: 'co_dm' })).toBe(true);
      expect(aiDmSetupComplete({ ok: false, driverOk: true, mode: 'co_dm' })).toBe(false);
    });
  });

  describe('aiDmReadinessProgress', () => {
    it('excludes advisory checks from both the tally and its total', () => {
      const progress = aiDmReadinessProgress({ checks: [...configuredChecks('driver'), ...ADVISORY] });
      expect(progress).toEqual({ done: 9, total: 9 });
    });

    it('counts a blocking check that is not ok against the total', () => {
      const checks = configuredChecks('driver').map((c) =>
        c.key === 'budget' ? { ...c, ok: false, status: 'blocked' as const } : c,
      );
      expect(aiDmReadinessProgress({ checks })).toEqual({ done: 8, total: 9 });
    });

    it('does not count an `unknown` check (the server flag, for a non-admin) as done', () => {
      const checks = configuredChecks('co_dm').map((c) =>
        c.key === 'serverFlag' ? { ...c, ok: false, status: 'unknown' as const } : c,
      );
      const progress = aiDmReadinessProgress({ checks });
      expect(progress.done).toBe(progress.total - 1);
    });
  });

  /**
   * The property, asserted as a property: across every mode and every single-check failure,
   * "the banner says ready" and "the tally reached its total" must agree. This is what makes
   * the two independent computations safe to keep independent.
   *
   * The generator mirrors the server's own coupling between the seat mode and the `mode`
   * check (blocked exactly when the seat is off/disabled) — that coupling is what makes the
   * `off` case agree, and it is pinned end-to-end in ai-dm-driver.e2e-spec.ts.
   */
  it('the ready banner and the progress tally can never disagree', () => {
    const failable = configuredChecks('driver').map((c) => c.key);
    const cases: { name: string; mode: AiDmMode; checks: AiDmReadinessCheck[] }[] = [];
    for (const mode of MODES) {
      const base = configuredChecks(mode);
      cases.push({ name: `${mode}: all blocking ok, no advisory`, mode, checks: base });
      cases.push({ name: `${mode}: all blocking ok, advisory unmet`, mode, checks: [...base, ...ADVISORY] });
      for (const key of failable) {
        for (const status of ['blocked', 'unknown'] as const) {
          cases.push({
            name: `${mode}: ${key} ${status}`,
            mode,
            checks: [...base.map((c) => (c.key === key ? { ...c, ok: false, status } : c)), ...ADVISORY],
          });
        }
      }
    }
    expect(cases.length).toBeGreaterThan(50);

    for (const { name, mode, checks } of cases) {
      const readiness = readinessFor(mode, checks);
      const progress = aiDmReadinessProgress(readiness);
      expect({ name, agree: aiDmSetupComplete(readiness) === (progress.done === progress.total) }).toEqual({
        name,
        agree: true,
      });
      // And the two never disagree with the per-check rule either: the tally is short by
      // exactly the number of blocking checks that are not ok.
      expect({ name, short: progress.total - progress.done }).toEqual({
        name,
        short: checks.filter(aiDmReadinessCheckBlocks).length,
      });
    }
  });
});
