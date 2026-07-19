/**
 * App router. Feature pages beyond auth/home are owned by other devs and
 * imported lazily so a missing/broken module only breaks its own route
 * (caught by RouteErrorBoundary) rather than the whole app at build time.
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { Layout } from './Layout';
import { AuthedLayout } from './AuthedLayout';
import { RouteErrorBoundary } from './RouteErrorBoundary';
import { Skeleton } from '../components/ui';
import { SetupPage } from '../features/auth/SetupPage';
import { LoginPage } from '../features/auth/LoginPage';
import { HomePage } from '../features/home/HomePage';
import { NotFoundPage } from '../features/home/NotFoundPage';

function lazyPage(loader: Parameters<typeof lazy>[0]) {
  const LazyComponent = lazy(loader);
  return (
    <RouteErrorBoundary>
      <Suspense
        fallback={
          <div className="max-w-4xl mx-auto px-4 mt-8">
            <Skeleton lines={5} />
          </div>
        }
      >
        <LazyComponent />
      </Suspense>
    </RouteErrorBoundary>
  );
}

function page(element: ReactNode) {
  return <RouteErrorBoundary>{element}</RouteErrorBoundary>;
}

export const router = createBrowserRouter([
  {
    path: '/setup',
    element: page(<SetupPage />),
  },
  {
    path: '/login',
    element: page(<LoginPage />),
  },
  {
    element: <AuthedLayout />,
    children: [
      {
        element: <Layout />,
        children: [
          { path: '/', element: page(<HomePage />) },
          {
            path: '/c/:campaignId',
            element: lazyPage(() => import('../features/dashboard/DashboardPage')),
          },
          {
            path: '/c/:campaignId/quests',
            element: lazyPage(() => import('../features/quests/QuestListPage')),
          },
          {
            path: '/c/:campaignId/quests/:questId',
            element: lazyPage(() => import('../features/quests/QuestPage')),
          },
          {
            path: '/c/:campaignId/npcs',
            element: lazyPage(() => import('../features/npcs/NpcListPage')),
          },
          {
            path: '/c/:campaignId/npcs/:npcId',
            element: lazyPage(() => import('../features/npcs/NpcPage')),
          },
          {
            path: '/c/:campaignId/locations',
            element: lazyPage(() => import('../features/locations/LocationListPage')),
          },
          {
            path: '/c/:campaignId/locations/:locationId',
            element: lazyPage(() => import('../features/locations/LocationPage')),
          },
          {
            path: '/c/:campaignId/party',
            element: lazyPage(() => import('../features/characters/PartyPage')),
          },
          {
            path: '/c/:campaignId/characters/:characterId',
            element: lazyPage(() => import('../features/characters/CharacterPage')),
          },
          {
            path: '/c/:campaignId/sessions',
            element: lazyPage(() => import('../features/sessions/SessionsPage')),
          },
          {
            path: '/c/:campaignId/encounters',
            element: lazyPage(() => import('../features/encounters/EncounterListPage')),
          },
          {
            path: '/c/:campaignId/encounters/:encounterId',
            element: lazyPage(() => import('../features/encounters/RunSessionPage')),
          },
          {
            path: '/c/:campaignId/notes',
            element: lazyPage(() => import('../features/notes/MyNotesPage')),
          },
          {
            path: '/c/:campaignId/inbox',
            element: lazyPage(() => import('../features/notes/InboxPage')),
          },
          {
            path: '/c/:campaignId/members',
            element: lazyPage(() => import('../features/admin/MembersPage')),
          },
          {
            path: '/c/:campaignId/proposals',
            element: lazyPage(() => import('../features/proposals/ProposalsPage')),
          },
          {
            path: '/c/:campaignId/compendium',
            element: lazyPage(() => import('../features/compendium/CompendiumPage')),
          },
          {
            path: '/c/:campaignId/compendium/:entryId',
            element: lazyPage(() => import('../features/compendium/ReaderPage')),
          },
          {
            path: '/c/:campaignId/settings',
            element: lazyPage(() => import('../features/settings/CampaignSettingsPage')),
          },
          {
            path: '/admin',
            element: lazyPage(() => import('../features/admin/AdminPage')),
          },
          {
            path: '/tokens',
            element: lazyPage(() => import('../features/admin/TokensPage')),
          },
          {
            path: '/preferences',
            element: lazyPage(() => import('../features/preferences/PreferencesPage')),
          },
          {
            path: '*',
            element: page(<NotFoundPage />),
          },
        ],
      },
    ],
  },
]);
