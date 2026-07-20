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
import { SignupPage } from '../features/auth/SignupPage';
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage';
import { JoinPage } from '../features/auth/JoinPage';
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
    path: '/signup',
    element: page(<SignupPage />),
  },
  {
    path: '/reset-password',
    element: page(<ResetPasswordPage />),
  },
  {
    // Invite landing page — public on purpose: the invited person has no account yet.
    path: '/join/:code',
    element: page(<JoinPage />),
  },
  {
    // Public read-only recap share link — no auth, outside AuthedLayout on purpose.
    path: '/share/:token',
    element: lazyPage(() => import('../features/sessions/SharedRecapPage')),
  },
  {
    element: <AuthedLayout />,
    children: [
      {
        // Cast-to-TV player display (issue #60). Authed (members only) but mounted
        // OUTSIDE the app chrome so it fills the screen with no sidebar/tabbar.
        // The page renders only player-safe, secret-free data (see playerSafe.ts).
        path: '/c/:campaignId/screen',
        element: lazyPage(() => import('../features/screen/PlayerDisplayPage')),
      },
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
            path: '/c/:campaignId/storylines',
            element: lazyPage(() => import('../features/storylines/StorylinesPage')),
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
            path: '/c/:campaignId/inventory',
            element: lazyPage(() => import('../features/inventory/InventoryPage')),
          },
          {
            path: '/c/:campaignId/sessions',
            element: lazyPage(() => import('../features/sessions/SessionsPage')),
          },
          {
            path: '/c/:campaignId/timeline',
            element: lazyPage(() => import('../features/timeline/TimelinePage')),
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
            path: '/c/:campaignId/search',
            element: lazyPage(() => import('../features/search/SearchPage')),
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
