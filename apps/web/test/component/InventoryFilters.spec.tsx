/**
 * Component-render coverage for issue #2178: Inventory filter chips (owner filter,
 * equipped filter, clear filters button) and total weight carried summary.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { InventoryItem, PartyCharacter, Character, Treasury } from '@campfire/schema';
import '../../src/i18n';
import { AuthContext, type AuthState } from '../../src/app/auth';

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(async (path: string) => {
    if (path.includes('/inventory')) return mockItems;
    if (path.includes('/treasury')) return mockTreasury;
    if (path.includes('/characters/roster')) return mockRoster;
    if (path.includes('/characters')) return mockCharacters;
    return [];
  }),
}));

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: getMock,
    },
  };
});

vi.mock('../../src/app/CampaignAccessContext', () => ({
  useCampaignAccess: () => ({
    isDm: false,
    canPlayerWrite: true,
    adminEnabled: false,
    campaign: null,
  }),
}));

import InventoryPage from '../../src/features/inventory/InventoryPage';

const mockTreasury: Treasury = { campaignId: 1, pp: 0, gp: 100, ep: 0, sp: 0, cp: 0, updatedAt: '2026-08-10T00:00:00Z' };

const mockCharacters: Character[] = [
  { id: 10, campaignId: 1, name: 'Valeros', ownerUserId: '1', role: 'player', isNpc: false, createdAt: '2026-08-10T00:00:00Z', updatedAt: '2026-08-10T00:00:00Z' } as unknown as Character,
];

const mockRoster: PartyCharacter[] = [
  { id: 10, name: 'Valeros', level: 3 } as unknown as PartyCharacter,
];

const mockItems: InventoryItem[] = [
  {
    id: 1,
    campaignId: 1,
    ownerType: 'party',
    characterId: null,
    name: 'Party Rations',
    qty: 5,
    weight: 2,
    equipped: false,
    notes: 'Tasty food',
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:00Z',
  } as unknown as InventoryItem,
  {
    id: 2,
    campaignId: 1,
    ownerType: 'character',
    characterId: 10,
    name: 'Longsword',
    qty: 1,
    weight: 3,
    equipped: true,
    equipSlot: 'Main hand',
    notes: 'Sharp blade',
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:00Z',
  } as unknown as InventoryItem,
  {
    id: 3,
    campaignId: 1,
    ownerType: 'character',
    characterId: 10,
    name: 'Shield',
    qty: 1,
    weight: 6,
    equipped: false,
    notes: 'Steel shield',
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:00Z',
  } as unknown as InventoryItem,
];

const mockAuthState = {
  me: {
    user: { id: 1, username: 'tester', displayName: 'Tester', serverRole: 'user' },
  },
  loading: false,
  error: null,
  roleIn: vi.fn(() => 'player' as const),
  login: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
} as unknown as AuthState;

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

function renderInventoryPage() {
  return render(
    <AuthContext.Provider value={mockAuthState}>
      <MemoryRouter initialEntries={['/c/1/inventory']}>
        <Routes>
          <Route path="/c/:campaignId/inventory" element={<InventoryPage />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('InventoryPage filter chips & weight summary (#2178)', () => {
  test('renders total weight carried summary', async () => {
    renderInventoryPage();
    // Total weight = (5 * 2) + (1 * 3) + (1 * 6) = 10 + 3 + 6 = 19 lb
    const totalWeightBadge = await screen.findByTestId('inventory-total-weight');
    expect(totalWeightBadge.textContent).toContain('19');
  });

  test('filters by owner chips (All / Party stash / Characters)', async () => {
    renderInventoryPage();
    await screen.findByText('Party Rations');
    expect(screen.getByText('Longsword')).toBeTruthy();
    expect(screen.getByText('Shield')).toBeTruthy();

    // Click "Party stash" owner filter chip
    fireEvent.click(screen.getByTestId('filter-owner-party'));
    expect(screen.getByText('Party Rations')).toBeTruthy();
    expect(screen.queryByText('Longsword')).toBeNull();
    expect(screen.queryByText('Shield')).toBeNull();

    // Click "Characters" owner filter chip
    fireEvent.click(screen.getByTestId('filter-owner-characters'));
    expect(screen.queryByText('Party Rations')).toBeNull();
    expect(screen.getByText('Longsword')).toBeTruthy();
    expect(screen.getByText('Shield')).toBeTruthy();

    // Reset to "All" owner filter
    fireEvent.click(screen.getByTestId('filter-owner-all'));
    expect(screen.getByText('Party Rations')).toBeTruthy();
    expect(screen.getByText('Longsword')).toBeTruthy();
  });

  test('filters by equipped status chips (All / Equipped / Unequipped)', async () => {
    renderInventoryPage();
    await screen.findByText('Party Rations');

    // Click "Equipped" filter chip
    fireEvent.click(screen.getByTestId('filter-equipped-equipped'));
    expect(screen.getByText('Longsword')).toBeTruthy();
    expect(screen.queryByText('Party Rations')).toBeNull();
    expect(screen.queryByText('Shield')).toBeNull();

    // Click "Unequipped" filter chip
    fireEvent.click(screen.getByTestId('filter-equipped-unequipped'));
    expect(screen.queryByText('Longsword')).toBeNull();
    expect(screen.getByText('Party Rations')).toBeTruthy();
    expect(screen.getByText('Shield')).toBeTruthy();
  });

  test('clears filters when clear button is clicked', async () => {
    renderInventoryPage();
    await screen.findByText('Party Rations');

    // Filter to Equipped
    fireEvent.click(screen.getByTestId('filter-equipped-equipped'));
    expect(screen.queryByText('Party Rations')).toBeNull();

    // Clear filters
    const clearBtn = screen.getByTestId('filter-clear');
    fireEvent.click(clearBtn);

    expect(screen.getByText('Party Rations')).toBeTruthy();
    expect(screen.getByText('Longsword')).toBeTruthy();
    expect(screen.getByText('Shield')).toBeTruthy();
  });
});
