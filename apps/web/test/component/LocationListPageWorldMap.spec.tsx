/**
 * Component-render coverage for issue #1317: World screen interactive campaign map
 * embedding on LocationListPage.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Attachment, Campaign, Location } from '@campfire/schema';
import '../../src/i18n';
import { AuthContext, type AuthState } from '../../src/app/auth';

const mockAttachment: Attachment = {
  id: 100,
  filename: 'world-map.jpg',
  mimeType: 'image/jpeg',
  byteSize: 1000,
  derivatives: [],
  createdAt: '2026-08-10T00:00:00Z',
  updatedAt: '2026-08-10T00:00:00Z',
} as unknown as Attachment;

const { getMock, accessState } = vi.hoisted(() => ({
  getMock: vi.fn(async (path: string) => {
    if (path.includes('/locations')) return mockLocations;
    if (path.includes('/attachments')) return mockAttachment;
    if (path.includes('/campaigns/1')) return mockCampaign;
    return [];
  }),
  accessState: {
    isDm: true,
    canDmWrite: true,
    canPlayerWrite: true,
    adminEnabled: false,
    campaign: null as Campaign | null,
  },
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
  useCampaignAccess: () => accessState,
  useCampaignAccessFor: () => accessState,
}));

import LocationListPage from '../../src/features/locations/LocationListPage';

const mockCampaign: Campaign = {
  id: 1,
  name: 'Sword Coast Campaign',
  dmUserId: '1',
  mapAttachmentId: 100,
  createdAt: '2026-08-10T00:00:00Z',
  updatedAt: '2026-08-10T00:00:00Z',
} as unknown as Campaign;

const mockLocations: Location[] = [
  {
    id: 10,
    campaignId: 1,
    name: 'Neverwinter',
    kind: 'city',
    status: 'current',
    mapX: 45,
    mapY: 60,
    body: 'A vibrant coastal city.',
    parentId: null,
    dmSecret: null,
    portraitUrl: null,
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:00Z',
  } as unknown as Location,
  {
    id: 20,
    campaignId: 1,
    name: 'Cragmaw Hideout',
    kind: 'dungeon',
    status: 'unexplored',
    mapX: null,
    mapY: null,
    body: 'Goblin cave system.',
    parentId: null,
    dmSecret: null,
    portraitUrl: null,
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:00Z',
  } as unknown as Location,
];

const mockAuthState = {
  me: {
    user: { id: 1, username: 'dm', displayName: 'DM', serverRole: 'user' },
  },
  loading: false,
  error: null,
  roleIn: vi.fn(() => 'dm' as const),
  login: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
} as unknown as AuthState;

afterEach(() => {
  cleanup();
  getMock.mockClear();
  accessState.isDm = true;
  accessState.canDmWrite = true;
});

function renderLocationListPage(isDm: boolean = true) {
  accessState.isDm = isDm;
  accessState.canDmWrite = isDm;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={mockAuthState}>
        <MemoryRouter initialEntries={['/c/1/locations']}>
          <Routes>
            <Route path="/c/:campaignId/locations" element={<LocationListPage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('LocationListPage interactive campaign map (#1317)', () => {
  test('renders RegionMap with pins and unpinned locations for DM', async () => {
    renderLocationListPage(true);
    // RegionMap renders with data-testid="dashboard-map"
    const mapCard = await screen.findByTestId('dashboard-map');
    expect(mapCard).toBeTruthy();
    expect(screen.getByText('World map')).toBeTruthy();
    expect(screen.getAllByText('Neverwinter').length).toBeGreaterThanOrEqual(1);

    // DM should see unpinned location chip for Cragmaw Hideout (unpinned chip + location roster row)
    expect(screen.getAllByText(/Cragmaw Hideout/).length).toBeGreaterThanOrEqual(2);
  });

  test('renders RegionMap in read-only mode for non-DM players', async () => {
    renderLocationListPage(false);
    const mapCard = await screen.findByTestId('dashboard-map');
    expect(mapCard).toBeTruthy();
    expect(screen.getByText('World map')).toBeTruthy();

    // Non-DM player should not see DM edit buttons like "Replace map" or "Remove map"
    expect(screen.queryByText('Replace map')).toBeNull();
    expect(screen.queryByText('Remove map')).toBeNull();
  });
});
