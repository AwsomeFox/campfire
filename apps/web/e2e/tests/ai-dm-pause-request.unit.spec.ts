import { expect, test } from '@playwright/test';
import { aiDmPauseRequest } from '../../src/features/ai-dm/aiDmPause';

/**
 * Issue #1501 — the AI DM pause/resume call sites. The POST /ai-dm/pause DTO is strict
 * (`{ paused: boolean }`) and 400'd on the empty body both the AI Table header and the encounter
 * dock used to send. This pins the { action, body } pair the shared helper produces so neither call
 * site can drift back to a bodyless POST.
 */
test.describe('aiDmPauseRequest — pause/resume body (issue #1501)', () => {
  test('pausing posts the pause action with { paused: true }', () => {
    expect(aiDmPauseRequest(false)).toEqual({ action: 'pause', body: { paused: true } });
  });

  test('resuming posts the resume action with { paused: false }', () => {
    expect(aiDmPauseRequest(true)).toEqual({ action: 'resume', body: { paused: false } });
  });

  test('the body always carries a boolean paused (never omitted)', () => {
    expect(typeof aiDmPauseRequest(false).body.paused).toBe('boolean');
    expect(typeof aiDmPauseRequest(true).body.paused).toBe('boolean');
  });
});
