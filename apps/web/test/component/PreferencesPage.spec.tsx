/**
 * Component-render coverage for the colorVisionAssist preference wiring
 * (issue #1942), converting the source-scan assertion in
 * `e2e/tests/color-vision-assist.unit.spec.ts` ("PreferencesPage:
 * colorVisionAssist toggle is wired to state and PATCH /me/preferences") to a
 * rendered assertion, per issue #2025.
 *
 * A source-scan test can only prove the strings `checked={colorVisionAssist}`
 * and `colorVisionAssist,` still appear in the file — it cannot tell an
 * inverted condition, a disconnected onChange, or a payload that silently
 * drops the field from one that works. This test drives the real rendered
 * checkbox and Save button and asserts on the actual PATCH payload sent.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Me } from '@campfire/schema';
import '../../src/i18n';
import { AuthContext, type AuthState } from '../../src/app/auth';

// vi.mock is hoisted above every top-level statement in this file, so the
// mocks it references must be created through vi.hoisted rather than a plain
// top-level const (which would still be in the temporal dead zone at hoist
// time).
const { patchMock, getMock } = vi.hoisted(() => ({
  patchMock: vi.fn(async (_path: string, _json?: Record<string, unknown>) => ({}) as unknown),
  getMock: vi.fn(async (_path: string) => ({ campaigns: [] }) as unknown),
}));

// Hoisted above the imports below by Vitest, so PreferencesPage (and the
// NotificationPreferencesCard it renders) pick up the mocked module.
vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      patch: patchMock,
      get: getMock,
    },
  };
});

import PreferencesPage from '../../src/features/preferences/PreferencesPage';

function baseMe(overrides: Partial<Me['user']> = {}): Me {
  return {
    user: {
      id: 1,
      username: 'tester',
      displayName: 'Tester',
      serverRole: 'user',
      disabled: false,
      accentColor: null,
      textSize: 'default',
      diceTheme: 'nocturne',
      timeFormat: 'system',
      animateOthersRolls: true,
      canCreateCampaigns: false,
      colorVisionAssist: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
    memberships: [],
    instance: { instanceId: 'test-instance', dataGeneration: 0 },
  };
}

function renderWithAuth(me: Me) {
  // Model the real PATCH /me/preferences contract: the server always echoes
  // back the persisted record (every field of `User`, not just the ones this
  // request touched), not merely the fields the caller sent. `patchMock`
  // returns the ORIGINAL user merged with the request body, so a field the
  // component doesn't consume from the response — and any field it does,
  // e.g. `displayName` — reflects what the server would actually have on
  // file after this save, the same way a bare `{}` response never would.
  // (Review finding on PR #2033: a bare `{}` response let a later
  // `setColorVisionAssist(updated.colorVisionAssist ?? false)` silently
  // revert the just-saved preference, and the test never noticed because it
  // only asserted on the outgoing request, not the resulting UI state.)
  patchMock.mockImplementation(async (_path: string, json?: Record<string, unknown>) => ({
    ...me.user,
    ...(json ?? {}),
  }));

  const authState: AuthState = {
    me,
    ready: true,
    connectionError: false,
    staleIdentity: false,
    lastSyncedAt: Date.now(),
    sessionExpired: false,
    isAdmin: false,
    roleIn: () => null,
    refresh: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
  };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authState}>
        <PreferencesPage />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('PreferencesPage colorVisionAssist wiring (issue #1942, harness issue #2025)', () => {
  beforeEach(() => {
    patchMock.mockClear();
    getMock.mockClear();
  });

  afterEach(() => cleanup());

  test('toggling the checkbox and saving PATCHes colorVisionAssist: true, and the checkbox stays checked after save', async () => {
    renderWithAuth(baseMe({ colorVisionAssist: false }));

    const checkbox = document.getElementById('prefs-color-vision-assist') as HTMLInputElement;
    const displayNameInput = document.getElementById('prefs-display-name') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(false);

    const saveButton = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    const [path, body] = patchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/api/v1/me/preferences');
    expect(body).toMatchObject({ colorVisionAssist: true });

    // Post-save UI state: once the (realistic, merged) server response lands
    // and the component re-syncs its local state from it, the just-saved
    // checkbox must stay checked and the untouched displayName must stay
    // put — with the old `{}` response, both would have silently reverted
    // to their zero-value defaults (unchecked, empty) right here.
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(displayNameInput.value).toBe('Tester');
  });

  test('unchecking an already-on preference PATCHes colorVisionAssist: false, and the checkbox stays unchecked after save', async () => {
    renderWithAuth(baseMe({ colorVisionAssist: true }));

    const checkbox = document.getElementById('prefs-color-vision-assist') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    const [, body] = patchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toMatchObject({ colorVisionAssist: false });

    // Without the realistic merged mock response, `setColorVisionAssist(updated.colorVisionAssist ?? false)`
    // would still land on `false` here by coincidence (`??` on `undefined`) — the first test above is the one
    // that actually distinguishes a merged response from a bare `{}`, since it saves to `true`.
    await waitFor(() => expect(checkbox.checked).toBe(false));
  });
});
