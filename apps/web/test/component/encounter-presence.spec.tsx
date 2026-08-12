/**
 * Web-client coverage for Co-DM encounter presence (issue #2212, #816 slice 2).
 *
 * Two units are under test:
 *
 *  - `EncounterPresenceIndicator` (presentational): renders the OTHER collaborators on the
 *    encounter from a snapshot roster, never the current user (AC #2212.5), with their
 *    coarse activity, and reconciles to "nobody" when the roster empties (AC #2212.6).
 *  - `useEncounterPresence` (the declare/heartbeat/leave + roster state): declares on open
 *    (AC #2212.2), heartbeats on a cadence inside the server TTL (AC #2212.3), reconciles
 *    `encounter.presence` SSE snapshots into the roster, re-declares on activity change and
 *    SSE reconnect, and leaves on unmount (AC #2212.2).
 *
 * AC #2212.8 ("a second client connecting sees the first's presence; disconnecting removes
 * it") is exercised at the roster level here (the snapshot a second client would receive is
 * fed straight through `applySnapshot`, modelling join then leave). The server-side half of
 * that scenario — the actual SSE fan-out and secrecy gating — is covered by
 * `apps/server/test/encounter-presence.e2e-spec.ts` from slice 1 (#2209).
 */
import { act, render, renderHook, screen, cleanup, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EncounterPresenceEntry, EncounterPresenceSnapshot } from '@campfire/schema';

import '../../src/i18n';
import { EncounterPresenceIndicator } from '../../src/features/encounters/EncounterPresenceIndicator';

const { postMock, deleteMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    // Only the two endpoints the presence hook touches are overridden; `API` (the path
    // prefix) and every other surface stay real.
    api: { ...actual.api, post: postMock, delete: deleteMock },
  };
});

import { useEncounterPresence } from '../../src/features/encounters/useEncounterPresence';
import { API } from '../../src/lib/api';

const ENCOUNTER_ID = 4242;
const PRESENCE_PATH = `${API}/encounters/${ENCOUNTER_ID}/presence`;

function snapshot(members: EncounterPresenceEntry[]): EncounterPresenceSnapshot {
  return { campaignId: 7, encounterId: ENCOUNTER_ID, members };
}

// Safe defaults so the leave-on-unmount cleanup (which calls `api.delete(...).catch`)
// always sees a Promise, even in tests that never touch `deleteMock`. `beforeEach`
// re-applies them so a per-test override in one test cannot leak into the next.
beforeEach(() => {
  postMock.mockResolvedValue(snapshot([]));
  deleteMock.mockResolvedValue(snapshot([]));
});

afterEach(() => {
  cleanup();
  postMock.mockClear();
  deleteMock.mockClear();
  vi.useRealTimers();
});

function entry(userId: string, activity: 'viewing' | 'editing'): EncounterPresenceEntry {
  return { userId, activity };
}

describe('EncounterPresenceIndicator (issue #2212)', () => {
  test('renders each other collaborator with name and coarse activity', () => {
    const names = new Map([
      ['2', 'Alice'],
      ['3', 'Bob'],
    ]);
    render(
      <EncounterPresenceIndicator
        members={[entry('2', 'editing'), entry('3', 'viewing')]}
        selfUserId="1"
        names={names}
      />,
    );
    expect(screen.getByTestId('encounter-presence-roster')).toBeTruthy();
    expect(screen.getByTestId('encounter-presence-chip-2').textContent).toBe('Alice · editing');
    expect(screen.getByTestId('encounter-presence-chip-3').textContent).toBe('Bob · viewing');
  });

  test('never lists the current user, even when the roster includes them (AC #2212.5)', () => {
    const names = new Map([
      ['1', 'Me'],
      ['2', 'Alice'],
    ]);
    render(
      <EncounterPresenceIndicator
        members={[entry('1', 'viewing'), entry('2', 'editing')]}
        selfUserId="1"
        names={names}
      />,
    );
    expect(screen.queryByTestId('encounter-presence-chip-1')).toBeNull();
    expect(screen.getByTestId('encounter-presence-chip-2').textContent).toBe('Alice · editing');
  });

  test('renders nothing when only the current user is present (a solo DM sees no indicator)', () => {
    const names = new Map([['1', 'Me']]);
    const { container } = render(
      <EncounterPresenceIndicator members={[entry('1', 'viewing')]} selfUserId="1" names={names} />,
    );
    expect(container.querySelector('[data-testid="encounter-presence-roster"]')).toBeNull();
  });

  test('renders nothing when the roster is empty', () => {
    const { container } = render(
      <EncounterPresenceIndicator members={[]} selfUserId="1" names={new Map()} />,
    );
    expect(container.querySelector('[data-testid="encounter-presence-roster"]')).toBeNull();
  });

  test('falls back to the raw userId when no roster name is available', () => {
    render(
      <EncounterPresenceIndicator
        members={[entry('99', 'viewing')]}
        selfUserId="1"
        names={new Map()}
      />,
    );
    expect(screen.getByTestId('encounter-presence-chip-99').textContent).toBe('99 · viewing');
  });

  test('reconciles a new snapshot: a collaborator leaving disappears (AC #2212.6, #2212.8)', () => {
    const names = new Map([
      ['2', 'Alice'],
      ['3', 'Bob'],
    ]);
    const { rerender } = render(
      <EncounterPresenceIndicator
        members={[entry('2', 'viewing'), entry('3', 'viewing')]}
        selfUserId="1"
        names={names}
      />,
    );
    expect(screen.getByTestId('encounter-presence-chip-2')).toBeTruthy();
    expect(screen.getByTestId('encounter-presence-chip-3')).toBeTruthy();
    // Bob disconnects → the server emits a snapshot without him.
    rerender(
      <EncounterPresenceIndicator
        members={[entry('2', 'viewing')]}
        selfUserId="1"
        names={names}
      />,
    );
    expect(screen.getByTestId('encounter-presence-chip-2')).toBeTruthy();
    expect(screen.queryByTestId('encounter-presence-chip-3')).toBeNull();
  });
});

describe('useEncounterPresence (issue #2212)', () => {
  test('declares presence on open and seeds the roster from the response (AC #2212.2)', async () => {
    postMock.mockResolvedValue(snapshot([entry('1', 'viewing'), entry('2', 'editing')]));
    const { result } = renderHook(() =>
      useEncounterPresence({
                encounterId: ENCOUNTER_ID,
        enabled: true,
        activity: 'viewing',
        heartbeatMs: 60_000,
      }),
    );
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(PRESENCE_PATH, { activity: 'viewing' }));
    await waitFor(() => expect(result.current.members).toEqual([entry('1', 'viewing'), entry('2', 'editing')]));
  });

  test('does not declare while disabled (non-DM / not running)', () => {
    postMock.mockResolvedValue(snapshot([]));
    renderHook(() =>
      useEncounterPresence({
                encounterId: ENCOUNTER_ID,
        enabled: false,
        activity: 'viewing',
        heartbeatMs: 60_000,
      }),
    );
    expect(postMock).not.toHaveBeenCalled();
  });

  test('a coarse-activity change re-declares promptly so a Co-DM sees "editing"', async () => {
    postMock.mockResolvedValue(snapshot([entry('1', 'viewing')]));
    let activity: 'viewing' | 'editing' = 'viewing';
    const { rerender } = renderHook(() =>
      useEncounterPresence({
                encounterId: ENCOUNTER_ID,
        enabled: true,
        activity,
        heartbeatMs: 60_000,
      }),
    );
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    activity = 'editing';
    rerender();
    await waitFor(() =>
      expect(postMock).toHaveBeenLastCalledWith(PRESENCE_PATH, { activity: 'editing' }),
    );
  });

  test('reconciles an encounter.presence SSE snapshot via applySnapshot (AC #2212.1, #2212.8)', () => {
    postMock.mockResolvedValue(snapshot([entry('1', 'viewing')]));
    const { result } = renderHook(() =>
      useEncounterPresence({
                encounterId: ENCOUNTER_ID,
        enabled: true,
        activity: 'viewing',
        heartbeatMs: 60_000,
      }),
    );
    // A second collaborator (Bob) connects server-side; the broadcast snapshot includes
    // both the caller and Bob.
    act(() => {
      result.current.applySnapshot([entry('1', 'viewing'), entry('2', 'viewing')]);
    });
    expect(result.current.members).toEqual([entry('1', 'viewing'), entry('2', 'viewing')]);
    // Bob disconnects; the server emits the updated snapshot.
    act(() => {
      result.current.applySnapshot([entry('1', 'viewing')]);
    });
    expect(result.current.members).toEqual([entry('1', 'viewing')]);
  });

  test('redeclare() re-declares immediately (used on SSE reconnect to restore presence)', async () => {
    postMock.mockResolvedValue(snapshot([entry('1', 'viewing')]));
    const { result } = renderHook(() =>
      useEncounterPresence({
                encounterId: ENCOUNTER_ID,
        enabled: true,
        activity: 'viewing',
        heartbeatMs: 60_000,
      }),
    );
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.redeclare();
    });
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
  });

  test('redeclare() is a no-op when presence is not enabled', () => {
    postMock.mockResolvedValue(snapshot([]));
    const { result } = renderHook(() =>
      useEncounterPresence({
                encounterId: ENCOUNTER_ID,
        enabled: false,
        activity: 'viewing',
        heartbeatMs: 60_000,
      }),
    );
    act(() => {
      result.current.redeclare();
    });
    expect(postMock).not.toHaveBeenCalled();
  });

  test('heartbeats on a cadence inside the server TTL while visible (AC #2212.3)', async () => {
    postMock.mockResolvedValue(snapshot([entry('1', 'viewing')]));
    renderHook(() =>
      useEncounterPresence({
                encounterId: ENCOUNTER_ID,
        enabled: true,
        activity: 'viewing',
        heartbeatMs: 20,
      }),
    );
    // Initial declare, then at least one heartbeat tick within a short window.
    await waitFor(() => expect(postMock.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
    });
  });

  test('leaves on unmount via a keepalive DELETE (AC #2212.2)', async () => {
    deleteMock.mockResolvedValue(snapshot([]));
    postMock.mockResolvedValue(snapshot([entry('1', 'viewing')]));
    const { unmount } = renderHook(() =>
      useEncounterPresence({
                encounterId: ENCOUNTER_ID,
        enabled: true,
        activity: 'viewing',
        heartbeatMs: 60_000,
      }),
    );
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    unmount();
    expect(deleteMock).toHaveBeenCalledWith(PRESENCE_PATH, { keepalive: true });
  });

  test('leaves when eligibility is lost (DM downgraded / encounter stopped)', async () => {
    deleteMock.mockResolvedValue(snapshot([]));
    postMock.mockResolvedValue(snapshot([entry('1', 'viewing')]));
    let enabled = true;
    const { rerender } = renderHook(() =>
      useEncounterPresence({
                encounterId: ENCOUNTER_ID,
        enabled,
        activity: 'viewing',
        heartbeatMs: 60_000,
      }),
    );
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    enabled = false;
    rerender();
    expect(deleteMock).toHaveBeenCalledWith(PRESENCE_PATH, { keepalive: true });
  });
});
