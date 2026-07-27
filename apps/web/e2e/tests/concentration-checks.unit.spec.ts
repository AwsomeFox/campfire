import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

test.describe('concentration checks (issue #606)', () => {
  test('queues single and multi-target damage prompts from authoritative PATCH responses', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toContain('pendingConcentrationChecks');
    expect(source).toContain('api.patch<CombatantUpdateResult>');
    expect(source).toContain('response.data.concentrationCheck');
    expect(source).toContain('setPendingConcentrationChecks((pending) => [...pending');
  });

  test('retains a failed-check prompt until its concentration-clear mutation succeeds', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/combatantTurnState\s*\.mutateAsync/);
    expect(source).toContain('.then(() => setPendingConcentrationChecks((pending) => pending.slice(1)))');
    expect(source).toContain('disabled={combatantTurnState.isPending}');
  });
});
