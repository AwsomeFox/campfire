/**
 * Session lifecycle phase, client side (issue #1043).
 *
 * THE BUG THESE GUARD. The server emits a thin `{type:'phase'}` frame and classifies it
 * broadcast-safe, but the web parser had no such member in its union and no `case` for it, so
 * `parseAiDmStreamEvent` dropped every phase frame through its `default` branch. Neither
 * `AiTablePage` nor `useAiDmLiveActivity` could therefore invalidate on it.
 *
 * The consequence was not cosmetic. Only the member who pressed Start Session / Wrap Up refetched
 * the session; everyone else kept a stale phase, and a player whose client still believed the
 * session was open would type, submit, and get a 409 they had no way to anticipate.
 *
 * Every sibling thin signal ('state', 'stuck', 'recovered', 'vote', 'takeover') already
 * invalidates, so these assertions hold `phase` to the same contract.
 */
import { expect, test } from '@playwright/test';
import type { AiDmTranscriptEvent } from '@campfire/schema';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAiDmStreamEvent } from './util';
import {
  emptyTranscript,
  transcriptReducer,
  type SystemEntry,
} from '../../src/features/ai-dm/transcript';

const TABLE = resolve(__dirname, '../../src/features/ai-dm/AiTablePage.tsx');
const ACTIVITY = resolve(__dirname, '../../src/features/ai-dm/useAiDmLiveActivity.tsx');
const TRANSCRIPT_UI = resolve(__dirname, '../../src/features/ai-dm/AiDmTranscriptUi.tsx');

const at = '2026-07-27T10:00:00.000Z';

function controlEvent(seq: number, payload: Record<string, unknown>): AiDmTranscriptEvent {
  return {
    campaignId: 1,
    kind: 'control',
    seq,
    eventId: `e${seq}`,
    actorUserId: null,
    actorName: null,
    clientRef: null,
    turnId: null,
    payload,
    at,
  } as AiDmTranscriptEvent;
}

function systemEntries(events: AiDmTranscriptEvent[]): SystemEntry[] {
  return transcriptReducer(emptyTranscript, { type: 'serverEvents', events })
    .entries.filter((e): e is SystemEntry => e.kind === 'system');
}

function catalog(lng: string): Record<string, unknown> {
  const parsed = JSON.parse(
    readFileSync(resolve(__dirname, `../../src/i18n/locales/${lng}/table.json`), 'utf8'),
  ) as { table: Record<string, unknown> };
  return parsed.table;
}

test.describe('session lifecycle phase — client wiring (#1043)', () => {
  test('the parser returns the phase frame instead of dropping it', () => {
    for (const phase of ['greeting', 'active', 'wrap_up', 'ended']) {
      expect(parseAiDmStreamEvent({ type: 'phase', campaignId: 1, phase, at })).toEqual({
        type: 'phase',
        campaignId: 1,
        phase,
        at,
      });
    }
  });


  test('an unknown phase name still parses, so an older client survives a newer server', () => {
    // Deliberately NOT an allowlist. The server owns the phase vocabulary; a client that dropped
    // a phase it did not recognise would skip the invalidation and go stale — the exact failure
    // this fixes. The refetched session is what the UI actually renders from.
    expect(parseAiDmStreamEvent({ type: 'phase', campaignId: 1, phase: 'intermission', at })).toMatchObject({
      type: 'phase',
      phase: 'intermission',
    });
  });

  test('both stream consumers invalidate the session on a phase frame', () => {
    // A member who did NOT press the button learns the phase changed only from this frame. If
    // either consumer omits it, that member keeps a stale phase and can type into an ended
    // session — the 409 they cannot anticipate.
    for (const file of [TABLE, ACTIVITY]) {
      const src = readFileSync(file, 'utf8');
      expect(src).toMatch(/event\.type === 'phase'/);
    }
  });

  test('an ended session locks the composer, and says why', () => {
    // After a normal wrap-up the server refuses every player action with AI_DM_SESSION_ENDED, so
    // an enabled composer is an input that CANNOT succeed — for every up-to-date client, not just
    // one that missed a phase frame. The lock has to state its cause and leave the one-click cure
    // in reach, or it just trades a confusing error for a confusing dead box.
    const src = readFileSync(TABLE, 'utf8');
    expect(src).toMatch(/const ended = phase === 'ended'/);
    expect(src).toMatch(/locked = streaming \|\| paused \|\| humanControl \|\| awaiting \|\| ended/);
    expect(src).toMatch(/composerLockedEnded/);
    // Start Session is still rendered while `ended`, so the lock is never a dead end...
    expect(src).toMatch(/canCompose && phase !== 'greeting' && phase !== 'wrap_up'/);
    // ...but only for roles the server would actually accept. A viewer shown a button that
    // always 403s is the same "control that cannot succeed" defect as the unlocked composer.
    expect(src).toMatch(/const canCompose = role === 'dm' \|\| role === 'player'/);

    for (const lng of ['en', 'ar']) {
      expect(catalog(lng).composerLockedEnded).toBeTruthy();
    }
  });

  test('the durable phase control rows fold to their own variant, not to the generic info line', () => {
    // THE BUG. Every successful lifecycle turn writes TWO `control: 'phase'` transcript rows —
    // one for the transient phase, one for the settled one. `foldServerEvent` recognised neither
    // control, so both fell through to the `info` variant, whose copy is `State: {{state}}`, and
    // these rows carry `phase`, not `state`. The result was two blank `State:` lines in the
    // durable, shared, replayed-on-reload transcript for every session that opened or closed.
    //
    // NOTE the live `{type:'phase'}` SSE FRAME is a different thing and is correctly dropped by
    // `foldStreamEvent` — it exists to trigger invalidation, and folding it too would double the
    // line. That the frame is handled says nothing about whether the ROW is.
    const entries = systemEntries([
      controlEvent(1, { control: 'phase', phase: 'greeting' }),
      controlEvent(2, { control: 'phase', phase: 'active' }),
      controlEvent(3, { control: 'phase_interrupted', interrupted: 'wrap_up', phase: 'active' }),
    ]);
    expect(entries.map((e) => e.variant)).toEqual(['phase', 'phase', 'phaseInterrupted']);
    // And the data the renderer needs actually arrives with them.
    expect(entries[0].data?.phase).toBe('greeting');
    expect(entries[2].data?.interrupted).toBe('wrap_up');
    // `info` remains the fallback for controls nobody has taught the client about.
    expect(systemEntries([controlEvent(4, { control: 'intermission' })])[0].variant).toBe('info');
  });

  test('every phase variant has copy in every catalog, in both directions', () => {
    // A variant without copy renders a missing-key placeholder, which is the blank `State:` line
    // wearing a different hat. `systemText` must have a case for each, and both catalogs must
    // carry a line for each phase the server can publish.
    const src = readFileSync(TRANSCRIPT_UI, 'utf8');
    expect(src).toMatch(/case 'phase':/);
    expect(src).toMatch(/case 'phaseInterrupted':/);

    for (const lng of ['en', 'ar']) {
      const cat = catalog(lng);
      const systemPhase = cat.systemPhase as Record<string, string>;
      const phaseName = cat.phaseName as Record<string, string>;
      for (const phase of ['active', 'greeting', 'wrap_up', 'ended']) {
        expect(systemPhase?.[phase], `${lng}.systemPhase.${phase}`).toBeTruthy();
        expect(phaseName?.[phase], `${lng}.phaseName.${phase}`).toBeTruthy();
      }
      // The forward-compatible fallbacks: a phase a newer server invents must still read as a
      // sentence rather than as a raw key.
      expect(cat.systemPhaseUnknown, `${lng}.systemPhaseUnknown`).toBeTruthy();
      expect(cat.systemPhaseInterrupted, `${lng}.systemPhaseInterrupted`).toBeTruthy();
    }
  });
});
