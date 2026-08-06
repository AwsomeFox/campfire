import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const runSessionSource = readFileSync(resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx'), 'utf8');
const combatantRowSource = readFileSync(resolve(__dirname, '../../src/features/encounters/combat/CombatantRow.tsx'), 'utf8');
const deathSavesSource = readFileSync(resolve(__dirname, '../../src/features/encounters/combat/DeathSaves.tsx'), 'utf8');
const playerVitalsSource = readFileSync(resolve(__dirname, '../../src/features/encounters/PlayerVitalsHeader.tsx'), 'utf8');
const combatLogSource = readFileSync(resolve(__dirname, '../../src/features/encounters/CombatLog.tsx'), 'utf8');

// Issue #1919 — "make death saves a table-holds-breath moment instead of a silent
// mutation". These are source-level regression guards for the wiring a rendering test
// harness cannot cheaply exercise here (this repo's web "unit" specs are plain-Node
// Playwright specs, not a DOM test renderer) — see `deathSaveOutcome.unit.spec.ts` for
// the pure classifier's real behavioral table tests.

test.describe('roller side: the tracker receives and forwards the settled outcome', () => {
  test('CombatantRow threads deathSaveOutcome through to DeathSaveTracker, matched to its own combatant', () => {
    expect(runSessionSource).toContain(
      "deathSaveOutcome={deathSaveOutcome?.combatantId === c.id ? deathSaveOutcome.outcome : null}",
    );
    expect(combatantRowSource).toContain('deathSaveOutcome?: DeathSaveOutcome | null;');
    expect(combatantRowSource).toContain('outcome={deathSaveOutcome}');
  });

  test('DeathSaveTracker flashes the pip group the roll actually changed, not a fixed one', () => {
    expect(deathSavesSource).toContain(
      "outcome == null || outcome.natural === 20 ? null : outcome.natural >= 10 ? 'deathSaveSuccesses' : 'deathSaveFailures'",
    );
    expect(deathSavesSource).toContain("flash={flashGroup === 'deathSaveSuccesses'}");
    expect(deathSavesSource).toContain("flash={flashGroup === 'deathSaveFailures'}");
  });

  test('the outcome banner carries no ARIA live role of its own (single SR channel, issue #1906 convention)', () => {
    expect(deathSavesSource).not.toContain('role="status"');
    expect(deathSavesSource).toContain('data-testid="death-save-outcome"');
  });
});

test.describe('own-character dying state: PlayerVitalsHeader gets a working Roll button', () => {
  test('the dying strip only offers Roll while deathState is dying, gated the same as DeathSaveTracker', () => {
    expect(playerVitalsSource).toContain("const dying = c.deathState === 'dying';");
    expect(playerVitalsSource).toContain('const canRoll = dying && onRollDeathSave != null;');
    expect(playerVitalsSource).toContain('disabled={busy || syncBlocked}');
  });

  test('RunSessionPage wires the same server-authoritative roll action and sync gate', () => {
    expect(runSessionSource).toContain('onRollDeathSave={(id) => rollDeathSave({ id })}');
    expect(runSessionSource).toContain('isDeathSaveBusy={(id) => pendingCombatantIds.has(id) || reconcileBlocks}');
    expect(runSessionSource).toContain('syncBlocked={riskyBlocked}');
  });
});

test.describe('table side: a compact spectator toast, never the roller\'s own roll twice', () => {
  test('recognizes a death-save roll strictly through the pure, already role-projected extractor, not a new SSE type', () => {
    expect(runSessionSource).toContain('const info = deathSaveSpectatorToastInfo(event);');
    expect(runSessionSource).toContain('if (!info) continue;');
    expect(runSessionSource).not.toContain('dice.rolled');
  });

  test('suppresses the toast for the combatant THIS client just rolled itself', () => {
    expect(runSessionSource).toContain('recentDeathSaveSelfRollRef.current.set(combatantId, Date.now());');
    expect(runSessionSource).toContain(
      'const selfRolledAt = event.targetId != null ? recentDeathSaveSelfRollRef.current.get(event.targetId) : undefined;',
    );
    expect(runSessionSource).toContain('if (now - selfRolledAt < DEATH_SAVE_SELF_ROLL_WINDOW_MS) continue;');
  });

  // The actual secrecy-boundary pin (redacted target passes through verbatim, a
  // nameless event produces no toast) lives in death-save-outcome.unit.spec.ts's
  // `deathSaveSpectatorToastInfo secrecy boundary` describe block, against the real
  // pure function — this just confirms RunSessionPage calls it rather than re-deriving.
  test('never re-derives the name itself — only consumes the pure extractor\'s result', () => {
    expect(runSessionSource).not.toContain('event.target?.trim()');
  });

  test('a fresh page load does not toast pre-existing history (same null-cursor baseline as the SR announcer)', () => {
    expect(runSessionSource).toContain('if (!cursor) return;');
  });

  test('CombatLog highlights a death-save roll row distinctly', () => {
    expect(combatLogSource).toContain("const isDeathSaveRoll = !chain.chainId && isDeathSaveRollEvent(head);");
    expect(combatLogSource).toContain("className={isDeathSaveRoll ? 'cf-combat-log-death-save' : undefined}");
  });
});

test('encounter.updated also refetches the events feed so the spectator toast is not stuck behind the 5s poll', () => {
  expect(runSessionSource).toContain(
    "void queryClient.invalidateQueries({ queryKey: queryKeys.encounterEvents(eid) });",
  );
});
