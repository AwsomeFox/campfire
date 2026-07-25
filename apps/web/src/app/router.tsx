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
import { SkeletonRoute } from '../components/ui';
import { SetupPage } from '../features/auth/SetupPage';
import { LoginPage } from '../features/auth/LoginPage';
import { OidcRecoveryPage } from '../features/auth/OidcRecoveryPage';
import { SignupPage } from '../features/auth/SignupPage';
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage';
import { JoinPage } from '../features/auth/JoinPage';
import { HomePage } from '../features/home/HomePage';
import { NotFoundPage } from '../features/home/NotFoundPage';
import { PUBLIC_BASE } from '../lib/public-base';

function lazyPage(loader: Parameters<typeof lazy>[0]) {
  const LazyComponent = lazy(loader);
  return (
    <RouteErrorBoundary>
      <Suspense
        fallback={<SkeletonRoute lines={5} />}
      >
        <LazyComponent />
      </Suspense>
    </RouteErrorBoundary>
  );
}

function page(element: ReactNode) {
  return <RouteErrorBoundary>{element}</RouteErrorBoundary>;
}

export const router = createBrowserRouter(
  [
  {
    path: '/setup',
    element: page(<SetupPage />),
  },
  {
    path: '/login',
    element: page(<LoginPage />),
  },
  {
    path: '/login/sso-error',
    element: page(<OidcRecoveryPage />),
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
            path: '/c/:campaignId/factions',
            element: lazyPage(() => import('../features/factions/FactionListPage')),
          },
          {
            path: '/c/:campaignId/factions/:factionId',
            element: lazyPage(() => import('../features/factions/FactionPage')),
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
            path: '/c/:campaignId/session-zero',
            element: lazyPage(() => import('../features/session-zero/SessionZeroPage')),
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
            // Player-facing AI-DM Table (issue #339) — the shared transcript + composer
            // where a Driver-mode session with the AI DM is actually played.
            path: '/c/:campaignId/table',
            element: lazyPage(() => import('../features/ai-dm/AiTablePage')),
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
            // Per-campaign Trash (issue #269) — soft-deleted entities, restorable.
            path: '/c/:campaignId/trash',
            element: lazyPage(() => import('../features/trash/TrashPage')),
          },
          {
            path: '/admin',
            element: lazyPage(() => import('../features/admin/AdminPage')),
          },
          {
            // /admin/* sub-pages (issue #350) — each re-parents a slice of the
            // cards that used to all stack on the single /admin overview page.
            path: '/admin/users',
            element: lazyPage(() => import('../features/admin/AdminUsersPage')),
          },
          {
            path: '/admin/rules',
            element: lazyPage(() => import('../features/admin/AdminRulesPage')),
          },
          {
            path: '/admin/ai',
            element: lazyPage(() => import('../features/admin/AdminAiPage')),
          },
          {
            path: '/admin/auth',
            element: lazyPage(() => import('../features/admin/AdminAuthPage')),
          },
          {
            path: '/admin/storage',
            element: lazyPage(() => import('../features/admin/AdminStoragePage')),
          },
          {
            path: '/admin/audit',
            element: lazyPage(() => import('../features/admin/AdminAuditPage')),
          },
          {
            path: '/tokens',
            element: lazyPage(() => import('../features/admin/TokensPage')),
          },
          {
            path: '/notifications',
            element: lazyPage(() => import('../features/notifications/NotificationsPage')),
          },
          {
            path: '/c/:campaignId/notifications',
            element: lazyPage(() => import('../features/notifications/NotificationsPage')),
          },
          {
            path: '/preferences',
            element: lazyPage(() => import('../features/preferences/PreferencesPage')),
          },
          {
            // Open-content attributions (issue #302) — game-icons.net CC-BY credits.
            path: '/credits',
            element: lazyPage(() => import('../features/credits/CreditsPage')),
          },
          {
            path: '*',
            element: page(<NotFoundPage />),
          },
        ],
      },
    ],
  },
],
  // Reverse-proxy subpath support (issue #798): the router treats the configured
  // PUBLIC_BASE as its basename so deep links/refreshes/`<Link to>`s all resolve
  // under e.g. /campfire/... The proxy strips the prefix before forwarding, so
  // the server is never aware of it. PUBLIC_BASE defaults to '/' (no basename),
  // preserving the pre-#798 root deployment.
  { basename: PUBLIC_BASE === '/' ? undefined : PUBLIC_BASE },
);
