import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

test.describe('concentration checks (issue #606)', () => {
  test('queues single and multi-target damage prompts from authoritative PATCH responses', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toContain('pendingConcentrationChecks');
    expect(source).toContain('api.patch<CombatantUpdateResult>');
    expect(source).toContain('response.concentrationCheck');
    expect(source).toContain('name: response.name');
    expect(source).toContain('appendConcentrationCheck');
  });

  test('clears and protects the prompt queue across encounter navigation', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toContain('setPendingConcentrationChecks([])');
    expect(source).toContain('concentrationQueueEncounterRef.current !== eid');
  });

  test('retains a failed-check prompt until its concentration-clear mutation succeeds', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/combatantTurnState\s*\.mutateAsync/);
    expect(source).toContain('dequeueConcentrationCheck');
    expect(source).toContain('.catch(() => undefined)');
    expect(source).toContain('disabled={combatantTurnState.isPending}');
  });
});
