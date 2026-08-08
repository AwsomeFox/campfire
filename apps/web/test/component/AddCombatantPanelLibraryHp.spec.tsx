/**
 * Component-render coverage for the Library-tab HP regression on PR #2086 (issue
 * #2080).
 *
 * The source-scan tests in `e2e/tests/add-combatant-library-hp.unit.spec.ts` and the
 * server-layer tests in `apps/server/test/integration/encounter-library-monster-hp.spec.ts`
 * both predate this fix and both stayed green through the regression: removing the
 * `: 10` fallback made `addFromLibrary` send NO `hpMax` at all for a legacy entry (one
 * with no stored `statblock.hp`), and every campaign-library row saved before #2080
 * shipped is exactly that shape. The server correctly rejects the request — that is
 * tested — but the Library tab rendered no way for a DM to supply an HP and recover,
 * because the only `hpMax` input (the Manual tab's shared field) is `hidden` while the
 * Library tab is active. A source-scan test cannot see that: it can only confirm the
 * word `hpMax` still appears somewhere in the file, not whether a human looking at the
 * rendered Library tab has any way to act on a "HP not set" entry.
 *
 * This test renders the real `AddCombatantPanel`, switches to its real Library tab,
 * and drives its real inline HP input + Add button for a legacy entry — never touching
 * the Manual tab's `hpMax` field at all — then asserts the POST that actually reaches
 * the server carries the HP the DM just typed.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import type { CampaignLibraryMonster } from '@campfire/schema';
import { defaultCombatantStatblock } from '@campfire/schema';
import '../../src/i18n';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(async (_path: string) => [] as unknown),
  postMock: vi.fn(async (_path: string, _json?: unknown) => ({}) as unknown),
}));

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: getMock,
      post: postMock,
    },
  };
});

import { AddCombatantPanel } from '../../src/features/encounters/combat/AddCombatantPanel';

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
});

/** A campaign-library row saved before issue #2080 shipped: no stored HP at all. */
function legacyLibraryEntry(): CampaignLibraryMonster {
  return {
    id: 501,
    campaignId: 1,
    name: 'Ancient Goblin',
    statblock: { ...defaultCombatantStatblock(), hp: null, actions: [] },
    sourceRuleEntryId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderPanel() {
  postMock.mockResolvedValue({});
  return render(
    <AddCombatantPanel
      encounterId={1}
      campaignId={7}
      characters={[]}
      existingCombatantCharacterIds={new Set()}
      rulePack="dnd5e"
      onAdded={vi.fn()}
    />,
  );
}

/**
 * The library monster name also appears in an unrelated `<option>` elsewhere in the
 * panel (a compendium/character picker), so queries must be scoped to the Library
 * tabpanel itself rather than the whole document.
 */
function libraryPanel() {
  const panel = document.getElementById('add-combatant-panel-library');
  if (!panel) throw new Error('Library tabpanel not found — did the tab render?');
  return within(panel);
}

describe('AddCombatantPanel Library tab HP affordance (issue #2080 regression)', () => {
  test('the Manual tab still exposes template Max HP for a not-yet-live combatant (issue #2093)', () => {
    getMock.mockResolvedValue([]);
    renderPanel();

    const editor = within(screen.getByTestId('combatant-statblock-editor'));
    expect(editor.getByText('Max HP')).toBeTruthy();
  });

  test('a legacy library entry (no stored HP) cannot be added with a click alone — no POST fires', async () => {
    getMock.mockResolvedValue([legacyLibraryEntry()]);
    renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }));
    await waitFor(() => expect(libraryPanel().getByText('Ancient Goblin')).toBeTruthy());

    // No click target on this entry's card posts anything by itself: unlike a
    // known-HP entry, this one renders an input + explicit Add button, not a
    // whole-card button. Confirms the whole-card "click to add" behavior this
    // entry HAD before the regression is correctly gone, not just moved.
    expect(getMock).toHaveBeenCalledWith('/api/v1/campaigns/7/library/monsters');
    expect(postMock).not.toHaveBeenCalled();
  });

  test('typing HP into the entry’s own inline field and clicking Add succeeds — without ever touching the Manual tab', async () => {
    getMock.mockResolvedValue([legacyLibraryEntry()]);
    renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }));
    await waitFor(() => expect(libraryPanel().getByText('Ancient Goblin')).toBeTruthy());

    // The Add button starts disabled: no HP has been typed yet, so there is
    // nothing valid to send.
    const addButton = libraryPanel().getByRole('button', { name: 'Add' });
    expect((addButton as HTMLButtonElement).disabled).toBe(true);

    const hpInput = libraryPanel().getByRole('textbox', { name: 'Set HP to add' });
    fireEvent.change(hpInput, { target: { value: '45' } });
    expect((addButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(addButton);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith(
      '/api/v1/encounters/1/combatants',
      expect.objectContaining({
        kind: 'monster',
        libraryMonsterId: 501,
        hpMax: 45,
      }),
    );
  });

  test('a non-numeric or zero HP draft keeps Add disabled — never posts an invalid override', async () => {
    getMock.mockResolvedValue([legacyLibraryEntry()]);
    renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }));
    await waitFor(() => expect(libraryPanel().getByText('Ancient Goblin')).toBeTruthy());

    const addButton = libraryPanel().getByRole('button', { name: 'Add' });
    const hpInput = libraryPanel().getByRole('textbox', { name: 'Set HP to add' });

    fireEvent.change(hpInput, { target: { value: '0' } });
    expect((addButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(hpInput, { target: { value: 'abc' } });
    expect((addButton as HTMLButtonElement).disabled).toBe(true);

    expect(postMock).not.toHaveBeenCalled();
  });

  test('an entry WITH stored HP still adds on a single card click, unchanged', async () => {
    const known: CampaignLibraryMonster = {
      ...legacyLibraryEntry(),
      id: 502,
      name: 'Bonecrusher',
      statblock: { ...defaultCombatantStatblock(), hp: 60, actions: [] },
    };
    getMock.mockResolvedValue([known]);
    renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }));
    const card = await within(document.getElementById('add-combatant-panel-library')!).findByRole('button', { name: /Bonecrusher/ });
    fireEvent.click(card);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [, payload] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.libraryMonsterId).toBe(502);
    // No override typed and no hpMax key at all — the server resolves it from
    // the entry's own stored template HP.
    expect('hpMax' in payload).toBe(false);
  });
});
