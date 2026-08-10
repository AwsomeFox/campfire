/**
 * Authenticated app chrome — desktop sidebar + mobile topbar/tabbar/More sheet.
 * Mobile tab bar contract (issues #637, #1472): six primary targets — Home, Quests, Party,
 * Encounters (or Live shortcut), Notes, and More.
 * Overflow nav stays in the More sheet.
 * Mirrors the Nocturne app shell in design/claude-design/Campfire.dc.html
 * (the block starting at the `inApp` sc-if, just above "Dashboard").
 * Campaign-scoped nav only renders inside /c/:campaignId routes.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth';
import { useCampaign, useCampaigns } from './CampaignContext';
import { CampaignAccessProvider } from './CampaignAccessContext';
import { MentionsProvider } from './MentionsContext';
import { api, ApiError, API } from '../lib/api';
import { parseCampaignIdParam } from '../lib/parseCampaignIdParam';
import { rememberCampaignRoute } from '../lib/campaignSwitcherRoute';
import { confirmDiscardUnsavedWork } from '../lib/unsavedWork';

import { useFormattingLocale, useTimeFormat, formatDateTime, timeAgo } from '../lib/format';
import type { CampaignStatusTransition } from '@campfire/schema';
import { initials } from '../lib/avatarText';
import { Btn, Card, Dialog } from '../components/ui';
import { PasswordInput } from '../components/PasswordInput';
import { useDialog } from '../components/useDialog';
import { useClearAnnouncements } from '../components/Announcer';
import { useClearAnnouncementsOnScope } from '../components/useClearAnnouncementsOnScope';
import {
  NotificationsBell,
  NotificationsPanel,
  NotificationsProvider,
} from '../features/notifications/NotificationsBell';
import { AiDmLiveActivityProvider, useAiDmLiveActivityState } from '../features/ai-dm/useAiDmLiveActivity';
import { GameIcon } from '../components/GameIcon';
import { BrandMark } from '../components/BrandMark';
import { UIIcon } from '../components/UIIcon';
import { TermHelp } from '../components/TermHelp';
import { GLOSSARY_TERMS } from '../features/glossary/glossaryTerms';
import { EntityDeepLinkFocus } from './EntityDeepLinkFocus';
import { RouteChangeFocus } from './RouteChangeFocus';
import { SkipToMainLink } from './SkipToMainLink';
import { MAIN_CONTENT_ID } from './routeFocus';
import { useMembershipLiveSync } from '../features/auth/useMembershipLiveSync';
import { LiveEncounterProvider } from './LiveEncounterContext';
import { useLiveEncounterState } from '../lib/useLiveEncounterState';
import {
  getConnectionSyncSnapshot,
  subscribeConnectionSync,
  type ConnectionSyncState,
} from '../lib/connectionSync';
import { KeyboardCommandProvider, useKeyboardCommands, useKeyboardCommandHint } from '../components/KeyboardCommandProvider';
import { SafetyHoldBar } from '../components/SafetyHoldBar';
import { onPendingProposalsBadgeBump, onPendingProposalsBadgeSet, onInboxCountBadgeSet } from '../lib/proposalsBadgeBus';
import { buildCampaignNavGroups, isActiveNavPath, navGroupsForMoreSheet, type NavGroup, type NavItem } from './campaignNav';
import { UI_ICON_SIZE } from '../lib/uiIcons';
import { CheckRequestPrompts } from '../features/encounters/CheckRequests';
import { deriveCampaignAccess } from './campaignAccess';

function MaybeCampaignCommands({ campaignId, children }: { campaignId?: number; children: ReactNode }) {
  if (campaignId === undefined) return <>{children}</>;
  return (
    <CampaignAccessProvider campaignId={campaignId}>
      <KeyboardCommandProvider campaignId={campaignId}>
        {children}
      </KeyboardCommandProvider>
    </CampaignAccessProvider>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const titleId = useRef(`password-modal-title-${Math.random().toString(36).slice(2)}`).current;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirm) {
      setError(t('nav.passwordsDoNotMatch'));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api.post(`${API}/me/password`, { currentPassword, newPassword });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('nav.changePasswordFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={t('nav.passwordModalTitle')}
      titleId={titleId}
      backdropStyle={{ zIndex: 52 }}
      onBackdropClick={() => !saving && onClose()}
      ariaBusy={saving}
      actions={
        !done ? (
          <>
            <Btn ghost type="button" onClick={onClose}>{t('nav.cancel')}</Btn>
            <button type="submit" form="change-password-form" className="btn btn-primary" disabled={saving}>{saving ? t('nav.saving') : t('nav.save')}</button>
          </>
        ) : undefined
      }
    >
      {done ? (
        <div className="space-y-3">
          <p className="text-sm text-emerald-400">{t('nav.passwordUpdated')}</p>
          <Btn className="w-full" onClick={onClose}>{t('nav.done')}</Btn>
        </div>
      ) : (
        <form id="change-password-form" className="space-y-3" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="currentPassword">{t('nav.currentPassword')}</label>
            <PasswordInput
              id="currentPassword"
              className="input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              revealNoun="current password"
            />
          </div>
          <div className="field">
            <label htmlFor="newPassword">{t('nav.newPassword')}</label>
            <PasswordInput
              id="newPassword"
              className="input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              revealNoun="new password"
            />
          </div>
          <div className="field">
            <label htmlFor="confirmPassword">{t('nav.confirmNewPassword')}</label>
            <PasswordInput
              id="confirmPassword"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              revealNoun="confirm password"
            />
          </div>
          {error && <p className="text-sm text-rose-400">{error}</p>}
        </form>
      )}
    </Dialog>
  );
}

/** Campaign-wide search box (issue #64). Submits to /c/:id/search?q=. */
function SidebarSearch({ campaignId }: { campaignId: number }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const { ariaKeyshortcuts, titleSuffix } = useKeyboardCommandHint('globalSearch');
  return (
    <form
      className="px-0.5 mb-1"
      onSubmit={(e) => {
        e.preventDefault();
        const term = q.trim();
        navigate(term ? `/c/${campaignId}/search?q=${encodeURIComponent(term)}` : `/c/${campaignId}/search`);
      }}
    >
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('nav.searchPlaceholder')}
        aria-label={t('nav.searchAria')}
        aria-keyshortcuts={ariaKeyshortcuts}
        title={`${t('nav.searchAria')}${titleSuffix}`}
        className="w-full text-sm"
        style={{
          background: 'var(--color-surface, rgba(255,255,255,0.03))',
          border: '1px solid var(--color-divider)',
          borderRadius: 'var(--radius-md)',
          padding: '6px 10px',
          color: 'var(--color-text)',
          minHeight: 34,
        }}
      />
    </form>
  );
}

/**
 * Touch-reachable search entry for the mobile top bar (issue #1481). The sidebar
 * search box is `hidden md:flex` and the command palette opens only via a
 * keyboard chord, so on a phone search was reachable only by typing the URL.
 * This magnifier lands on the full search page (which auto-focuses its input),
 * giving a touch user the same kind of entry every other destination has.
 */
function MobileSearchButton({ campaignId }: { campaignId: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(`/c/${campaignId}/search`)}
      aria-label={t('nav.searchAria')}
      title={t('nav.searchAria')}
      className="inline-flex items-center justify-center rounded-md shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-accent)]"
      style={{
        minHeight: 34,
        minWidth: 34,
        color: 'var(--color-text)',
        background: 'transparent',
        border: '1px solid var(--color-divider)',
      }}
    >
      <GameIcon slug="magnifying-glass" size={UI_ICON_SIZE.sm} title={t('nav.searchAria')} />
    </button>
  );
}

function SidebarKeyboardShortcutsButton() {
  const { t } = useTranslation();
  const commands = useKeyboardCommands();
  const { ariaKeyshortcuts, titleSuffix } = useKeyboardCommandHint('shortcutHelp');
  if (!commands) return null;
  return (
    <SidebarNavButton
      item={{ key: 'keyboard-shortcuts', label: t('keyboard.openHelp'), to: undefined }}
      active={false}
      onClick={() => commands.openHelp()}
      ariaKeyshortcuts={ariaKeyshortcuts}
      title={`${t('keyboard.openHelp')}${titleSuffix}`}
    />
  );
}

function relativeAgo(at: number, now: number = Date.now()): string {
  return timeAgo(at, now);
}

/**
 * "Offline — showing last-known" banner (issue #579). Rendered across every authed
 * page while `staleIdentity` is true — i.e. `/me` could not reach the server and
 * AuthProvider restored the last-known identity from localStorage rather than
 * bouncing to /login or wiping the cache. Keeps the user oriented on stale data
 * instead of presenting a wiped screen or a false sign-in.
 *
 * The sync timestamp comes from when the identity was last confirmed LIVE, so it
 * faithfully tells the user how stale the data may be (NOT when the banner was
 * first shown). Re-renders each minute so the "x ago" label stays roughly current
 * without a per-second timer.
 */
function OfflineBanner({ lastSyncedAt }: { lastSyncedAt: number | null }) {
  const { t } = useTranslation();
  const formattingLocale = useFormattingLocale();
  const timeFormat = useTimeFormat();
  // Tick once a minute so the relative label stays current. `staleIdentity` only
  // flips on a real /me outcome, so this effect is mounted at most while offline.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const when = useMemo(() => {
    if (lastSyncedAt == null) return null;
    const ago = relativeAgo(lastSyncedAt);
    const abs = formatDateTime(lastSyncedAt, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    return { ago, abs };
  }, [lastSyncedAt, formattingLocale, timeFormat]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="px-4 py-2 text-center"
      style={{
        fontSize: 12.5,
        color: 'var(--color-neutral-200, #e5e7eb)',
        background: 'color-mix(in srgb, var(--color-neutral-500, #888) 14%, transparent)',
        borderBottom: '1px solid var(--color-divider)',
      }}
      title={when ? when.abs : undefined}
    >
      {t('nav.offlineBanner')}
      {when ? <span className="text-muted">{t('nav.offlineSyncedAt', { when: when.ago })}</span> : null}
    </div>
  );
}

/**
 * Read-sync banner (issue #581). Shown when API reads time out or fail transiently
 * while the authed shell still renders last-known campaign data. Distinct from the
 * offline-identity banner (#579), which covers a failed `/me`.
 */
function ConnectionSyncBanner({
  syncState,
  lastSyncAt,
}: {
  syncState: ConnectionSyncState;
  lastSyncAt: number | null;
}) {
  const { t } = useTranslation();
  const formattingLocale = useFormattingLocale();
  const timeFormat = useTimeFormat();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const when = useMemo(() => {
    if (lastSyncAt == null) return null;
    const ago = relativeAgo(lastSyncAt);
    const abs = formatDateTime(lastSyncAt, { dateStyle: 'medium', timeStyle: 'short' });
    return { ago, abs };
  }, [lastSyncAt, formattingLocale, timeFormat]);

  const message =
    syncState === 'offline'
      ? t('nav.readSyncOffline')
      : syncState === 'stale'
        ? t('nav.readSyncStale')
        : null;
  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="px-4 py-2 text-center"
      style={{
        fontSize: 12.5,
        color: 'var(--color-neutral-200, #e5e7eb)',
        background: 'color-mix(in srgb, var(--color-neutral-500, #888) 10%, transparent)',
        borderBottom: '1px solid var(--color-divider)',
      }}
      title={when ? when.abs : undefined}
      data-testid="connection-sync-banner"
    >
      {message}
      {when ? <span className="text-muted">{t('nav.offlineSyncedAt', { when: when.ago })}</span> : null}
    </div>
  );
}

/**
 * Issue #846: shows who archived the campaign and when, in the read-only banner.
 * Fetches the single newest transition (the server returns them newest-first).
 * Player-visible line only — the DM-only `reason` is omitted here on purpose
 * (members see actor + status + time; the reason stays in Settings).
 */
function ArchivedProvenance({ campaignId, status }: { campaignId: number; status: string }) {
  const { t } = useTranslation();
  const [latest, setLatest] = useState<CampaignStatusTransition | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .get<CampaignStatusTransition[]>(`${API}/campaigns/${campaignId}/status-transitions`)
      .then((list) => {
        if (!cancelled) setLatest(list.length > 0 ? list[0] : null);
      })
      .catch(() => {
        if (!cancelled) setLatest(null);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, status]);
  if (!latest) return null;
  return (
    <span style={{ opacity: 0.85 }}>
      {t('nav.archivedBy', {
        actor: latest.actorName || t('nav.archivedBySomeone'),
        date: formatDateTime(latest.createdAt, { dateStyle: 'medium' }),
      })}
    </span>
  );
}

function SidebarNavButton({
  item,
  active,
  onClick,
  ariaKeyshortcuts,
  title,
}: {
  item: NavItem;
  active: boolean;
  onClick?: () => void;
  ariaKeyshortcuts?: string;
  title?: string;
}) {
  const { t } = useTranslation();
  const termHelp = item.termId ? <TermHelp termId={item.termId} align="end" /> : null;
  // The one-line gloss, shown on hover of the nav item itself. The full disclosure
  // (audience, canon impact, glossary deep link) stays behind the `?`.
  const termHelpHint = item.termId ? t(GLOSSARY_TERMS[item.termId].shortKey) : undefined;
  const inner = (
    <>
      <span
        className="w-[5px] h-[5px] rounded-full shrink-0"
        style={{ background: active ? 'var(--color-accent)' : 'transparent' }}
      />
      <span className="flex-1 truncate">{item.label}</span>
      {!!item.badge && (
        <span className="tag tag-accent" style={{ fontSize: 9 }}>
          {item.badge}
        </span>
      )}
      {item.soon && (
        <span className="tag tag-neutral" style={{ fontSize: 9 }}>
          soon
        </span>
      )}
    </>
  );
  const sharedStyle = {
    minHeight: 36,
    borderRadius: 'var(--radius-md)',
  } as const;
  const activeStyle = {
    color: active ? 'var(--color-accent)' : 'var(--color-neutral-300)',
    background: active ? 'color-mix(in srgb, var(--color-accent) 9%, transparent)' : 'transparent',
  } as const;
  if (item.soon) {
    return (
      <div
        className="flex items-center gap-2 px-2.5 text-sm cursor-not-allowed select-none"
        style={{ ...sharedStyle, color: 'var(--color-text-secondary)' }}
      >
        {inner}
        {termHelp}
      </div>
    );
  }
  if (!item.to) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-2 px-2.5 text-sm text-left w-full"
        style={{ ...sharedStyle, ...activeStyle }}
        aria-keyshortcuts={ariaKeyshortcuts}
        title={title}
      >
        {inner}
      </button>
    );
  }
  if (termHelp) {
    return (
      // The `?` is revealed by hovering or focusing the row rather than sitting on it
      // permanently: a rail where three of eleven items carry a stray glyph reads as an
      // inconsistency, not an affordance. Hovering the item now explains it via `title`;
      // the marker itself stays in the DOM and merely fades in, so it remains a real
      // keyboard-operable disclosure (issue #518) rather than a hover-only tooltip.
      <div className="cf-nav-help-row flex items-center gap-1">
        <Link
          to={item.to}
          onClick={onClick}
          className="flex items-center gap-2 px-2.5 text-sm min-w-0 flex-1"
          style={{ ...sharedStyle, ...activeStyle }}
          title={termHelpHint}
        >
          {inner}
        </Link>
        <span className="cf-nav-help-marker">{termHelp}</span>
      </div>
    );
  }
  return (
    <Link
      to={item.to}
      onClick={onClick}
      className="flex items-center gap-2 px-2.5 text-sm"
      style={{ ...sharedStyle, ...activeStyle }}
    >
      {inner}
    </Link>
  );
}

export function Layout() {
  return (
    <NotificationsProvider>
      <LayoutContent />
    </NotificationsProvider>
  );
}

function LayoutContent() {
  const { t } = useTranslation();
  const { me, isAdmin, roleIn, staleIdentity, lastSyncedAt, refresh: refreshAuth, logout } = useAuth();
  const [connectionSync, setConnectionSync] = useState(getConnectionSyncSnapshot);
  useEffect(() => {
    return subscribeConnectionSync(() => setConnectionSync(getConnectionSyncSnapshot()));
  }, []);
  const formattingLocale = useFormattingLocale();
  const clearAnnouncements = useClearAnnouncements();
  const params = useParams<{ campaignId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // Non-numeric `:campaignId` must not become NaN — that would trip scope clears
  // and confuse campaign lookups. Treat invalid params as "outside campaign".
  // Base-10 positive integers only — reject "1.5", "0x10", whitespace, etc.
  // Unmatched `/c/:id/...` splats (404) do not populate `params.campaignId`; read
  // the id from the pathname so chrome + document titles stay campaign-scoped.
  const campaignIdFromParams = parseCampaignIdParam(params.campaignId);
  const campaignIdFromPath = useMemo(() => {
    const match = location.pathname.match(/^\/c\/(\d+)(?:\/|$)/);
    return match ? parseCampaignIdParam(match[1]) : undefined;
  }, [location.pathname]);
  const campaignId = campaignIdFromParams ?? campaignIdFromPath;
  const campaign = useCampaign(campaignId);
  const { campaigns, loading: campaignsLoading, error: campaignsError, refresh: refreshCampaigns } = useCampaigns();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [lostAccess, setLostAccess] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const [pendingProposals, setPendingProposals] = useState(0);
  const [trashCount, setTrashCount] = useState(0);
  const [desktopLayout, setDesktopLayout] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  // Issue #434: clear encounter/dice live-region text when the signed-in user or
  // active campaign changes, and again when this chrome unmounts (→ /login).
  useClearAnnouncementsOnScope(me?.user.id ?? null, campaignId);
  // Track WHICH campaign we've stale-checked, not a bare boolean — so navigating
  // to a different campaign re-checks (and clears a prior lock screen) instead of
  // trusting a once-per-session flag.
  const staleCheckedIdRef = useRef<number | undefined>(undefined);

  // CSS still owns the responsive chrome, but only the active breakpoint gets
  // a bell renderer. Notification state/polling/panel remain in the provider
  // above this component, so crossing the breakpoint cannot duplicate traffic
  // or discard an open panel (issue #802).
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const onChange = (event: MediaQueryListEvent) => setDesktopLayout(event.matches);
    setDesktopLayout(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // Single app-wide AI-DM stream subscription (#344, building on #338's shared
  // useAiDmStream + toolActivity map). Mounted here — the campaign chrome every
  // campaign-scoped page renders inside — so the combat tracker, dashboard, and
  // any future Table page (#339) all read off ONE connection via the context
  // below instead of each opening their own. Opens only when the seat is in
  // Driver mode (checked inside the hook via useAiDmSeat); everything else
  // (mode off/co_dm, or no campaign in view) leaves it closed and inert.
  const liveActivity = useAiDmLiveActivityState(campaignId);

  const role = campaignId !== undefined ? roleIn(campaignId) : null;
  const { isDm, canDmWrite } = deriveCampaignAccess(role, campaign);

  const { liveEncounter, refresh: refreshLiveEncounter } = useLiveEncounterState(
    Number.isFinite(campaignId) ? campaignId : undefined,
  );

  // Issue #437: live promote/demote — refresh /me when this user's campaign role
  // changes over SSE (and fan out to other tabs). Keeps the current route.
  // Issue #637: reuse the same stream for live-encounter chrome refresh.
  // Issue #1640 (widened by #1707): live loss of access — this campaign's stream just
  // terminated with a proven, non-retryable connect failure: 403 the moment this user is
  // removed, or 404 the moment the campaign itself is trashed (a still-intact membership row
  // resolves a role, so `assertLifecycleAccess` 404s rather than 403s a member — see
  // `useMembershipLiveSync.ts`'s `onRevoked` doc for why both land on this same callback).
  // Unlike a role change, there is no membership left to re-render chrome from — show the
  // SAME "lost access" screen the stale-access effect below already renders for "navigated
  // into a campaign you don't have access to", rather than leaving this tab live on a page
  // whose every subsequent request would now fail the same way. refreshAuth/refreshCampaigns
  // also run so the dashboard and nav are correct the moment "Back to your campaigns" is used.
  useMembershipLiveSync(Number.isFinite(campaignId) ? campaignId : undefined, {
    onEncounterChange: () => void refreshLiveEncounter(),
    onReconnect: () => void refreshLiveEncounter(),
    onStreamRecovery: () => void refreshLiveEncounter(),
    onRevoked: () => {
      setLostAccess(true);
      void refreshAuth();
      void refreshCampaigns();
    },
  });

  // Issue #760: remember the last safe in-campaign route per user/campaign so
  // the chooser can restore task context after a switch (namespaced by userId
  // for shared devices). Push history (no replace) so browser Back still works.
  useEffect(() => {
    if (!me || campaignId === undefined) return;
    rememberCampaignRoute(me.user.id, `${location.pathname}${location.search}`);
  }, [me, campaignId, location.pathname, location.search]);

  /** Switch-campaign leave: confirm dirty forms, then go to hub with source path. */
  function onSwitchCampaignClick(event: { preventDefault(): void }): void {
    if (!confirmDiscardUnsavedWork()) {
      event.preventDefault();
    }
  }

  const switchCampaignState = campaignId !== undefined
    ? { switchFrom: location.pathname }
    : undefined;

  const roleLabel =
    role === 'dm'
      ? t('nav.roleDm')
      : role === 'player'
        ? t('nav.rolePlayer')
        : role === 'viewer'
          ? t('nav.roleViewer')
          : null;

  // Scribe inbox badge count — dm-only endpoint, best-effort (a failed/empty fetch
  // just means no badge, not a page error). Re-checks on campaign switch and when
  // navigating in/out of the inbox itself (so resolving an item clears the badge).
  useEffect(() => {
    if (campaignId === undefined || !isDm) {
      setInboxCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Use total from the bounded page (issue #608) — never fetch every body for a badge.
        const page = await api.get<{ total: number }>(`${API}/campaigns/${campaignId}/inbox?limit=1`);
        if (!cancelled) setInboxCount(page.total);
      } catch {
        if (!cancelled) setInboxCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId, isDm, location.pathname]);

  // Pending-proposals badge on the DM's Proposals nav item (issue #263) — mirrors the
  // scribe-inbox badge: dm-only, best-effort (a failed/empty fetch just means no badge).
  // Re-checks on campaign switch and route change so approving/rejecting clears it.
  useEffect(() => {
    if (campaignId === undefined || !isDm) {
      setPendingProposals(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const items = await api.get<unknown[]>(`${API}/campaigns/${campaignId}/proposals?status=pending`);
        if (!cancelled) setPendingProposals(items.length);
      } catch {
        if (!cancelled) setPendingProposals(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId, isDm, location.pathname]);

  // Campaign Trash badge (issue #638) — dm-only recovery surface. Same best-effort
  // pattern as inbox/proposals: empty or failed fetch means no badge. Re-checks on
  // campaign switch and route change so restoring an item clears the count.
  useEffect(() => {
    if (campaignId === undefined || !isDm) {
      setTrashCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const items = await api.get<unknown[]>(`${API}/campaigns/${campaignId}/trash`);
        if (!cancelled) setTrashCount(items.length);
      } catch {
        if (!cancelled) setTrashCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId, isDm, location.pathname]);

  // Bump the proposals badge the MOMENT the AI files one (#344 point 3), rather than
  // waiting for the next route change to re-poll above. `proposalFiledCount` is
  // monotonic (see useAiDmLiveActivity), so diffing it against the previous render
  // tells us exactly how many landed since — survives StrictMode's double-invoke and
  // any reconnect replay without double-counting. The route-change effect above still
  // owns reconciling against server truth (e.g. another DM already approved one).
  const prevProposalFiledCountRef = useRef(0);
  useEffect(() => {
    const delta = liveActivity.proposalFiledCount - prevProposalFiledCountRef.current;
    prevProposalFiledCountRef.current = liveActivity.proposalFiledCount;
    if (delta > 0 && isDm) setPendingProposals((n) => n + delta);
  }, [liveActivity.proposalFiledCount, isDm]);

  // Same immediate-bump idea (issue #1646), for a producer with no SSE channel: the
  // inbox sweep control files proposals via a plain REST POST and stays on /inbox, so
  // without this the badge would only catch up on the next route change.
  // Two channels: an immediate delta for mocked/legacy responses, and an absolute
  // count re-fetched after real sweeps so concurrent races don't over/under-count.
  useEffect(() => {
    if (!isDm) return;
    return onPendingProposalsBadgeBump((delta, bumpCampaignId) => {
      if (bumpCampaignId !== campaignId) return;
      setPendingProposals((n) => n + delta);
    });
  }, [isDm, campaignId]);

  useEffect(() => {
    if (!isDm) return;
    return onPendingProposalsBadgeSet((total, sourceCampaignId) => {
      if (sourceCampaignId !== campaignId) return;
      setPendingProposals(total);
    });
  }, [isDm, campaignId]);

  // Same staleness problem as the proposals badge above, for the inbox count itself
  // (issue #1679 review): a sweep resolves items while the DM stays on /inbox, which
  // changes none of this badge's own re-fetch dependencies (campaignId/isDm/pathname).
  useEffect(() => {
    if (!isDm) return;
    return onInboxCountBadgeSet((total, sourceCampaignId) => {
      if (sourceCampaignId !== campaignId) return;
      setInboxCount(total);
    });
  }, [isDm, campaignId]);

  // me.memberships is fetched once at login, so it's stale the moment a DM changes
  // someone's access mid-session. Once the campaign list has loaded, if this campaign
  // isn't in it (removed, or never was — server admins included, since admin ≠
  // auto-DM) treat it as lost access:
  // refresh both auth + campaigns once (covers the "promoted" case too, since a
  // promoted player's next campaign entry will now show DM nav) and bounce home.
  useEffect(() => {
    // Leaving campaign scope (or switching campaigns) clears any prior lock screen
    // so "Back to your campaigns" and normal navigation actually escape it.
    if (campaignId === undefined) {
      if (lostAccess) setLostAccess(false);
      staleCheckedIdRef.current = undefined;
      return;
    }
    // Don't fire on a load failure (API outage) — an empty/errored list isn't proof
    // of lost access, just that we couldn't check. Re-check per distinct campaignId.
    if (campaignsLoading || campaignsError || staleCheckedIdRef.current === campaignId) return;
    staleCheckedIdRef.current = campaignId;
    const stillHasAccess = campaigns.some((c) => c.id === campaignId);
    setLostAccess(!stillHasAccess);
    if (!stillHasAccess) {
      void refreshAuth();
      void refreshCampaigns();
    }
  }, [campaignId, campaignsLoading, campaignsError, campaigns, lostAccess, refreshAuth, refreshCampaigns]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Escape dismisses the mobile More sheet (backdrop tap + close button cover the
  // other exits). Only bound while open so it doesn't swallow Escape elsewhere.
  useEffect(() => {
    if (!moreOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMoreOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  function onLogout() {
    setMenuOpen(false);
    setMoreOpen(false);
    // Issues #434 / #506: drop stale live-region text before this account's
    // session ends. AuthedLayout/Layout unmount (#434) also clears, so the
    // "Signed out" confirmation is announced from LoginPage after that wipe —
    // announcing here would be cancelled by the unmount clear.
    clearAnnouncements();
    // Commit `me = null` before navigate. logout() no longer awaits cache/network,
    // but without flushSync a same-turn navigate('/login') can re-render LoginPage
    // while `me` is still set — LoginPage then bounces away and drops
    // `{ signedOut: true }`. flushSync also means we do not await logout (Copilot):
    // replace-navigate is not gated on cache/POST timing.
    flushSync(() => {
      void logout();
    });
    // `replace` so the protected route this tab was just on is gone from history
    // — Back must not be able to return to it (the AuthedLayout guard would bounce
    // it to /login anyway once `me` is null, but `replace` here avoids that extra
    // hop and the momentary flash of a guarded redirect). Overwrites any
    // AuthedLayout `{ from }` redirect that flushSync may have triggered.
    navigate('/login', { replace: true, state: { signedOut: true } });
  }

  const displayName = me?.user.displayName || me?.user.username || '';

  // Task-grouped campaign nav (issue #643): Play, Prepare, World, Records, Manage.
  const campaignNavGroups: NavGroup[] = useMemo(
    () =>
      campaignId !== undefined
        ? buildCampaignNavGroups(t, campaignId, {
            isDm,
            canCast: canDmWrite,
            inboxCount,
            pendingProposals,
            trashCount,
          })
        : [],
    [campaignId, t, role, isDm, canDmWrite, inboxCount, pendingProposals, trashCount],
  );

  const moreSheetNavGroups = useMemo(
    () => navGroupsForMoreSheet(campaignNavGroups),
    [campaignNavGroups],
  );

  // Server admin console is on any /admin* route (issue #350) — mirrors the
  // campaign dmNav pattern above so the sidebar shows a "Server admin" section
  // with sub-page links instead of the flat single entry used everywhere else.
  const onAdminRoute = location.pathname.startsWith('/admin');

  /**
   * The table safety hold (issue #599) is scoped to the AI Table — the one surface where a
   * table is being run through this app — rather than to every campaign route.
   *
   * #599 mounted it everywhere on the reasoning that a safety tool you have to navigate to
   * is one you do not have when you need it. What that bought in practice was a permanent
   * red bar above the quest list, the compendium and the character sheet: prep and reading
   * surfaces where nobody is at a table to stop. The keyboard shortcut travels with the
   * component, so it is live on exactly this surface too.
   *
   * The encounter cockpit is deliberately NOT included, and does not mount its own copy
   * either. It is the densest screen in the app and every row it spends is a row off the
   * board; the hold is one route away on the Table page.
   *
   * `/c/:id/screen` is likewise absent, and always was in effect — the player display is
   * routed OUTSIDE this layout (see router.tsx), so the `screen` arm this pattern used to
   * carry could never match. That surface gets `SafetyHoldDisplayOverlay` instead: a cast
   * screen is a television with no keyboard, so it acknowledges a hold rather than raising
   * one.
   */
  const onPlaySurface = /^\/c\/\d+\/table(?:\/|$)/.test(location.pathname);
  const adminNav: NavItem[] = isAdmin
    ? [
        { key: 'admin-overview', label: t('nav.adminOverview'), to: '/admin' },
        { key: 'admin-users', label: t('nav.adminUsers'), to: '/admin/users' },
        { key: 'admin-campaigns', label: t('nav.adminCampaigns'), to: '/admin/campaigns' },
        { key: 'admin-rules', label: t('nav.adminRules'), to: '/admin/rules' },
        { key: 'admin-ai', label: t('nav.adminAi'), to: '/admin/ai' },
        { key: 'admin-auth', label: t('nav.adminAuth'), to: '/admin/auth' },
        { key: 'admin-storage', label: t('nav.adminStorage'), to: '/admin/storage' },
        { key: 'admin-audit', label: t('nav.adminAudit'), to: '/admin/audit' },
      ]
    : [];

  const isActivePath = (to?: string) => isActiveNavPath(location.pathname, to, campaignId);

  if (lostAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--color-bg)' }}>
        <div style={{ maxWidth: 380, width: '100%' }}>
          <Card className="text-center space-y-2">
            <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug="padlock" size={28} reserveSpace /></p>
            <p className="font-bold text-white">{t('nav.lostAccessTitle')}</p>
            <Link to="/" className="btn btn-primary" style={{ display: 'inline-flex', marginTop: 4 }}>
              {t('nav.backToCampaigns')}
            </Link>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <AiDmLiveActivityProvider value={liveActivity}>
    <LiveEncounterProvider value={liveEncounter}>
    <MaybeCampaignCommands campaignId={campaignId}>
    <div className="min-h-screen flex" style={{ background: 'var(--color-bg)' }}>
      <div className="cf-ember-layer" aria-hidden />
      <div className="cf-authed-shell min-h-screen flex flex-1 w-full min-w-0">
      <SkipToMainLink mainRef={mainRef} />
      {/* Desktop sidebar */}
      {(campaignId !== undefined || onAdminRoute) && (
        <aside
          className="cf-print-chrome hidden md:flex w-[230px] shrink-0 sticky top-0 flex-col gap-1.5 h-screen overflow-y-auto overflow-x-hidden p-3.5 border-r"
          style={{ borderColor: 'var(--color-divider)' }}
        >
          <div className="flex items-center gap-1 mb-2">
            <Link
              to="/"
              state={switchCampaignState}
              onClick={onSwitchCampaignClick}
              className="flex flex-1 min-w-0 items-center gap-2.5 px-2 py-1.5 rounded-md"
              style={{ borderRadius: 'var(--radius-md)' }}
              aria-label={t('nav.switchCampaign')}
            >
              <BrandMark size={22} variant="mark" className="shrink-0" />
              <span className="min-w-0 leading-tight">
                {/* The rail stays at the design's ~230px, so a long campaign name still
                    ellipsises here (the design's own rail shows a short name and puts the
                    full one in the page title). Widening the rail to fit was the wrong
                    trade — it narrowed every page's content column by 34px to fix one
                    label. The `title` gives the full name on hover/focus instead. Two
                    lines are not an option either: the VTT reuses this block inside a
                    fixed-height strip that clips a second line mid-glyph. */}
                <span
                  className="block truncate text-[15px]"
                  title={campaign?.name ?? undefined}
                  style={{ fontFamily: 'var(--font-heading)', fontWeight: 500, color: 'var(--color-text)' }}
                >
                  {campaign?.name ?? 'Campfire'}
                </span>
                <span className="block text-[11px] text-muted">{t('nav.switchCampaign')}</span>
              </span>
            </Link>
            {desktopLayout && <NotificationsBell />}
          </div>

          {campaignId !== undefined && <SidebarSearch campaignId={campaignId} />}

          {campaignNavGroups.map((group, index) => (
            <div key={group.key}>
              <div
                className="text-muted text-[10.5px] uppercase tracking-wide pb-1 px-2.5"
                style={{ paddingTop: index === 0 ? 0 : 12 }}
              >
                {group.label}
              </div>
              <nav className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <SidebarNavButton key={item.key} item={item} active={isActivePath(item.to)} />
                ))}
              </nav>
            </div>
          ))}

          {onAdminRoute && isAdmin && (
            <>
              <div className="text-muted text-[10.5px] uppercase tracking-wide pt-3 pb-1 px-2.5">
                {t('nav.serverAdmin')}
              </div>
              <nav className="flex flex-col gap-0.5">
                {adminNav.map((item) => (
                  <SidebarNavButton key={item.key} item={item} active={isActivePath(item.to)} />
                ))}
              </nav>
            </>
          )}

          <div className="flex-1" />
          <div className="hr my-1" />
          <div className="text-muted text-[10.5px] uppercase tracking-wide pt-3 pb-1 px-2.5">
            {t('nav.groupAccount')}
          </div>
          <div className="flex items-center justify-between px-2 text-[11px] text-muted">
            <span className="truncate">{displayName}</span>
            {roleLabel && <span className="tag tag-accent" style={{ fontSize: 9.5 }}>{roleLabel}</span>}
          </div>
          <nav className="flex flex-col gap-0.5">
            {isAdmin && !onAdminRoute && (
              <SidebarNavButton
                item={{ key: 'admin', label: t('nav.serverAdmin'), to: '/admin' }}
                active={location.pathname.startsWith('/admin')}
              />
            )}
            <SidebarNavButton
              item={{ key: 'tokens', label: t('nav.apiTokens'), to: '/tokens' }}
              active={location.pathname === '/tokens'}
            />
            <SidebarNavButton
              item={{ key: 'preferences', label: t('nav.preferences'), to: '/preferences' }}
              active={location.pathname === '/preferences'}
            />
            <SidebarKeyboardShortcutsButton />
            <SidebarNavButton
              item={{ key: 'glossary', label: t('glossary.navLabel'), to: '/glossary' }}
              active={location.pathname === '/glossary'}
            />
            <SidebarNavButton
              item={{ key: 'change-password', label: t('nav.changePassword'), to: undefined }}
              active={false}
              onClick={() => setShowPasswordModal(true)}
            />
            <SidebarNavButton
              item={{ key: 'sign-out', label: t('nav.signOut'), to: undefined }}
              active={false}
              onClick={onLogout}
            />
          </nav>
        </aside>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile topbar */}
        <header
          className="cf-print-chrome md:hidden sticky top-0 z-30 flex items-center gap-2.5 px-3.5 py-2.5 border-b backdrop-blur"
          style={{
            borderColor: 'var(--color-divider)',
            background: 'color-mix(in srgb, var(--color-bg) 88%, transparent)',
          }}
        >
          <Link
            to="/"
            state={switchCampaignState}
            onClick={onSwitchCampaignClick}
            className="flex items-center gap-2"
            aria-label={campaignId !== undefined ? t('nav.switchCampaign') : t('nav.home')}
          >
            <BrandMark variant="mark" className="shrink-0" />
          </Link>
          <div className="leading-tight min-w-0">
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 500, fontSize: 14 }}>
              {campaign?.name ?? 'Campfire'}
            </div>
          </div>
          <div className="flex-1" />
          {campaignId !== undefined && <MobileSearchButton campaignId={campaignId} />}
          {!desktopLayout && <NotificationsBell />}
          {campaignId !== undefined && roleLabel && (
            <button
              className="tag tag-outline cursor-pointer"
              style={{ minHeight: 30, background: 'transparent', border: '1px solid var(--color-divider)', color: 'var(--color-text)' }}
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
            >
              {roleLabel} ▾
            </button>
          )}
          {campaignId === undefined && (
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="h-8 w-8 rounded-full text-xs font-bold flex items-center justify-center"
                style={{
                  background: 'var(--color-accent-900)',
                  border: '1px solid var(--color-accent-800)',
                  color: 'var(--color-accent-200)',
                }}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t('nav.accountMenu')}
              >
                {initials(displayName, formattingLocale)}
              </button>
              {menuOpen && (
                <UserMenu
                  isAdmin={isAdmin}
                  adminNav={adminNav}
                  onAdminRoute={onAdminRoute}
                  displayName={displayName}
                  onLogout={onLogout}
                  onClose={() => setMenuOpen(false)}
                  onChangePassword={() => setShowPasswordModal(true)}
                />
              )}
            </div>
          )}
        </header>

        {/* Desktop-only header for non-campaign, non-admin routes (home, tokens,
            preferences, credits) — /admin* gets the sidebar above instead, same
            as campaign routes, so this header would just duplicate the brand
            and admin links. */}
        {campaignId === undefined && !onAdminRoute && (
          <header
            className="cf-print-chrome hidden md:flex sticky top-0 z-30 items-center gap-2.5 px-5 py-3 border-b"
            style={{ borderColor: 'var(--color-divider)' }}
          >
            <Link to="/" className="flex items-center gap-2.5">
              <BrandMark variant="mark" className="shrink-0" />
              <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 500, fontSize: 15 }}>Campfire</span>
            </Link>
            <span className="tag tag-outline" style={{ fontSize: 10 }}>{t('nav.selfHosted')}</span>
            <div className="flex-1" />
            {desktopLayout && <NotificationsBell />}
            {isAdmin && (
              <Link to="/admin" className="btn btn-ghost" style={{ fontSize: 12.5 }}>
                {t('nav.admin')}
              </Link>
            )}
            <Link to="/tokens" className="btn btn-ghost" style={{ fontSize: 12.5 }}>
              {t('nav.apiTokens')}
            </Link>
            <Link to="/glossary" className="btn btn-ghost" style={{ fontSize: 12.5 }}>
              {t('glossary.navLabel')}
            </Link>
            <span className="text-muted" style={{ fontSize: 12 }}>{displayName}</span>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={onLogout}>
              {t('nav.signOut')}
            </button>
          </header>
        )}

        {/* Offline / stale-data banner (#579): a real /me failure (not 401) means
            we're serving the last-known identity + cached campaign data. Surface
            it so the user knows the data may be stale rather than wiping the cache
            or bouncing to /login. */}
        {staleIdentity && <OfflineBanner lastSyncedAt={lastSyncedAt} />}
        {!staleIdentity && (connectionSync.state === 'stale' || connectionSync.state === 'offline') && (
          <ConnectionSyncBanner syncState={connectionSync.state} lastSyncAt={connectionSync.lastSyncAt} />
        )}

        {/* Archived (paused/completed) campaigns are read-only server-side — surface it on every campaign page (#704). */}
        {campaign && campaign.status !== 'active' && (
          <div
            className="px-4 py-2 text-center"
            style={{
              fontSize: 12.5,
              color: 'var(--color-accent-200)',
              background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
              borderBottom: '1px solid var(--color-divider)',
            }}
            role="status"
          >
            {t('nav.archivedBanner', { status: campaign.status })}
            {campaignId !== undefined && <ArchivedProvenance campaignId={campaignId} status={campaign.status} />}
            {isDm && (
              <>
                {' '}
                <Link
                  to={`/c/${campaignId}/settings`}
                  className="font-semibold underline underline-offset-2"
                  style={{ color: 'var(--color-accent)' }}
                >
                  Reactivate in Settings
                </Link>
                {t('nav.archivedDmHint')}
              </>
            )}
          </div>
        )}

        {/* #599 — the participant safety hold. Mounted here, above <main>, so it is on screen
            on every PLAY surface (see `onPlaySurface`) rather than only on the one whose author
            remembered to add it. It renders nothing outside a campaign, and nothing until the
            hold read resolves. */}
        {campaignId !== undefined && onPlaySurface && <SafetyHoldBar campaignId={campaignId} />}

        <main
          ref={mainRef}
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className="flex-1 w-full pb-20 md:pb-10"
        >
          <RouteChangeFocus mainRef={mainRef} campaignName={campaign?.name ?? null} />
          <MentionsProvider campaignId={campaignId}>
            <EntityDeepLinkFocus />
            {campaignId !== undefined && <CheckRequestPrompts campaignId={campaignId} />}
            <Outlet />
          </MentionsProvider>
        </main>
      </div>

      {/* Mobile bottom tab bar */}
      {campaignId !== undefined && (
        <nav className="cf-tabbar">
          <NavLink to={`/c/${campaignId}`} end className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico"><GameIcon slug="campfire" size={UI_ICON_SIZE.md} /></span>Home
          </NavLink>
          <NavLink to={`/c/${campaignId}/quests`} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico"><GameIcon slug="scroll-unfurled" size={UI_ICON_SIZE.md} /></span>Quests
          </NavLink>
          <NavLink to={`/c/${campaignId}/party`} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico"><GameIcon slug="shield" size={UI_ICON_SIZE.md} /></span>Party
          </NavLink>
          {liveEncounter ? (
            <NavLink
              to={`/c/${campaignId}/encounters/${liveEncounter.id}`}
              className={({ isActive }) => (isActive ? 'active' : '')}
              data-testid="tabbar-live"
              aria-label={t('nav.liveEncounterTab', { round: liveEncounter.round })}
            >
              <span className="ico cf-tabbar-live-indicator">
                <GameIcon slug="crossed-swords" size={UI_ICON_SIZE.md} />
              </span>
              {t('nav.live')}
            </NavLink>
          ) : (
            <NavLink
              to={`/c/${campaignId}/encounters`}
              className={({ isActive }) => (isActive ? 'active' : '')}
              data-testid="tabbar-encounters"
            >
              <span className="ico">
                <GameIcon slug="crossed-swords" size={UI_ICON_SIZE.md} />
              </span>
              {t('nav.encounters')}
            </NavLink>
          )}
          <NavLink to={`/c/${campaignId}/notes`} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico"><GameIcon slug="quill-ink" size={UI_ICON_SIZE.md} /></span>{t('nav.notes')}
          </NavLink>
          <button onClick={() => setMoreOpen(true)} aria-haspopup="dialog" aria-expanded={moreOpen}>
            <span className="ico"><UIIcon name="more" size="md" /></span>{t('nav.more')}
          </button>
        </nav>
      )}

      {/* More sheet (mobile) */}
      {moreOpen && (
        <MoreSheet
          displayName={displayName}
          roleLabel={roleLabel}
          navGroups={moreSheetNavGroups}
          isActivePath={isActivePath}
          adminActive={onAdminRoute}
          isAdmin={isAdmin}
          switchCampaignState={switchCampaignState}
          onSwitchCampaignClick={onSwitchCampaignClick}
          onClose={() => setMoreOpen(false)}
          onChangePassword={() => {
            setMoreOpen(false);
            setShowPasswordModal(true);
          }}
          onLogout={onLogout}
        />
      )}

      {showPasswordModal && <ChangePasswordModal onClose={() => setShowPasswordModal(false)} />}
      <NotificationsPanel />
      </div>
    </div>
    </MaybeCampaignCommands>
    </LiveEncounterProvider>
    </AiDmLiveActivityProvider>
  );
}

function MoreSheet({
  displayName,
  roleLabel,
  navGroups,
  isActivePath,
  adminActive,
  isAdmin,
  switchCampaignState,
  onSwitchCampaignClick,
  onClose,
  onChangePassword,
  onLogout,
}: {
  displayName: string;
  roleLabel: string | null;
  navGroups: NavGroup[];
  isActivePath: (to?: string) => boolean;
  adminActive: boolean;
  isAdmin: boolean;
  switchCampaignState: { switchFrom: string } | undefined;
  onSwitchCampaignClick: (event: { preventDefault(): void }) => void;
  onClose: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  // Escape-to-close, focus trap, and focus restore to the trigger (issue #92),
  // combined with #104's positioning: capped height + internal scroll so a tall
  // list never clips above the viewport, plus a visible close button.
  const sheetRef = useDialog<HTMLDivElement>({ onClose });
  return (
    <div
      className="fixed inset-0 flex items-end justify-center"
      style={{
        // Same dialog tier as ConfirmDialog / notifications (issue #794).
        zIndex: 'var(--cf-layer-dialog)',
        background: 'color-mix(in srgb, var(--color-neutral-900) 55%, transparent)',
      }}
      onClick={onClose}
    >
      <Card
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.moreNavigation')}
        density="compact" elev="lg" className="w-full flex flex-col"
        style={{
          maxWidth: 440,
          maxHeight: 'calc(100dvh - 16px)',
          borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
          padding: '18px 18px calc(18px + env(safe-area-inset-bottom))',
          gap: 4,
        }}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div
          className="mx-auto mb-2.5 shrink-0"
          style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--color-neutral-700)' }}
        />
        <div className="flex items-start gap-2 shrink-0" style={{ padding: '0 6px 6px' }}>
          <div className="text-muted flex-1 min-w-0" style={{ fontSize: 11 }}>
            {t('nav.signedInAs', { name: displayName })}
            {roleLabel ? t('nav.viewingAs', { role: roleLabel }) : ''}
          </div>
          <button
            type="button"
            aria-label={t('nav.closeMenu')}
            onClick={onClose}
            className="shrink-0 -mt-1 -mr-1 flex items-center justify-center rounded-md"
            style={{ width: 32, height: 32, color: 'var(--color-text)' }}
          >
            <UIIcon name="close" size="md" />
          </button>
        </div>
        <div className="flex flex-col overflow-y-auto" style={{ gap: 4, margin: '0 -4px', padding: '0 4px' }}>
          {navGroups.map((group) => (
            <div key={group.key}>
              <div className="text-muted uppercase tracking-wide px-2.5 pt-2 pb-1" style={{ fontSize: 10.5 }}>
                {group.label}
              </div>
              {group.items.map((item) => (
                <MoreSheetItem
                  key={item.key}
                  item={item}
                  active={isActivePath(item.to)}
                  onNavigate={onClose}
                />
              ))}
            </div>
          ))}
          <div className="text-muted uppercase tracking-wide px-2.5 pt-2 pb-1" style={{ fontSize: 10.5 }}>
            {t('nav.groupAccount')}
          </div>
          {isAdmin && (
            <MoreSheetItem
              item={{ key: 'admin', label: t('nav.serverAdmin'), to: '/admin' }}
              active={adminActive}
              onNavigate={onClose}
            />
          )}
          <MoreSheetItem
            item={{ key: 'tokens', label: t('nav.apiTokens'), to: '/tokens' }}
            active={isActivePath('/tokens')}
            onNavigate={onClose}
          />
          <MoreSheetItem
            item={{ key: 'switch', label: t('nav.switchCampaign'), to: '/' }}
            active={false}
            state={switchCampaignState}
            onNavigate={onClose}
            onClick={onSwitchCampaignClick}
          />
          <MoreSheetItem
            item={{ key: 'preferences', label: t('nav.preferences'), to: '/preferences' }}
            active={isActivePath('/preferences')}
            onNavigate={onClose}
          />
          <MoreSheetItem
            item={{ key: 'glossary', label: t('glossary.navLabel'), to: '/glossary' }}
            active={isActivePath('/glossary')}
            onNavigate={onClose}
          />
          <button
            className="flex items-center gap-2.5 min-h-[46px] px-2.5 text-left rounded-md w-full"
            style={{ fontSize: 14.5, color: 'var(--color-text)' }}
            onClick={onChangePassword}
          >
            {t('nav.changePassword')}
          </button>
          <button
            className="flex items-center gap-2.5 min-h-[46px] px-2.5 text-left rounded-md w-full text-rose-400"
            style={{ fontSize: 14.5 }}
            onClick={onLogout}
          >
            {t('nav.signOut')}
          </button>
        </div>
      </Card>
    </div>
  );
}

function MoreSheetItem({
  item,
  active,
  onNavigate,
  state,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
  state?: { switchFrom: string };
  onClick?: (event: { preventDefault(): void }) => void;
}) {
  const activeStyle = {
    color: active ? 'var(--color-accent)' : 'var(--color-text)',
    background: active ? 'color-mix(in srgb, var(--color-accent) 9%, transparent)' : 'transparent',
  } as const;
  if (item.soon || !item.to) {
    return (
      <div
        className="flex items-center gap-2.5 min-h-[46px] px-2.5 text-left"
        style={{ fontSize: 14.5, color: 'var(--color-text-secondary)' }}
      >
        {item.label}
        <span className="tag tag-neutral ml-auto" style={{ fontSize: 9 }}>soon</span>
      </div>
    );
  }
  if (item.termId) {
    return (
      <div className="flex items-center gap-1">
        <Link
          to={item.to}
          state={state}
          onClick={(event) => {
            onClick?.(event);
            if (!event.defaultPrevented) onNavigate();
          }}
          className="flex items-center gap-2.5 min-h-[46px] px-2.5 text-left rounded-md min-w-0 flex-1"
          style={{ fontSize: 14.5, ...activeStyle }}
          aria-current={active ? 'page' : undefined}
        >
          <span className="flex-1 truncate">{item.label}</span>
          {!!item.badge && (
            <span className="tag tag-accent" style={{ fontSize: 9.5 }}>
              {item.badge}
            </span>
          )}
        </Link>
        {/* onNavigate closes the sheet: without it "Open glossary" navigates
            while the aria-modal More sheet stays mounted over the destination. */}
        <TermHelp termId={item.termId} align="end" onNavigate={onNavigate} />
      </div>
    );
  }
  return (
    <Link
      to={item.to}
      state={state}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onNavigate();
      }}
      className="flex items-center gap-2.5 min-h-[46px] px-2.5 text-left rounded-md"
      style={{ fontSize: 14.5, ...activeStyle }}
      aria-current={active ? 'page' : undefined}
    >
      <span className="flex-1 truncate">{item.label}</span>
      {!!item.badge && (
        <span className="tag tag-accent" style={{ fontSize: 9.5 }}>
          {item.badge}
        </span>
      )}
    </Link>
  );
}

function UserMenu({
  isAdmin,
  adminNav,
  onAdminRoute,
  displayName,
  onLogout,
  onClose,
  onChangePassword,
}: {
  isAdmin: boolean;
  adminNav: NavItem[];
  onAdminRoute: boolean;
  displayName: string;
  onLogout: () => void;
  onClose: () => void;
  onChangePassword: () => void;
}) {
  // Escape closes and restores focus to the trigger. Not a modal (Tab may fall
  // through), so no focus trap — outside-click close is handled in Layout.
  const menuRef = useDialog<HTMLDivElement>({ onClose, trapFocus: false });
  return (
    <Card
      ref={menuRef}
      role="menu"
      aria-label="Account menu"
      density="compact" elev="md" className="absolute right-0 top-11 w-56 p-2 space-y-1 text-sm z-40"
      style={{ gap: 2 }}
    >
      <p className="px-2 py-1 text-xs text-muted truncate">{displayName}</p>
      {isAdmin && onAdminRoute ? (
        // Mobile topbar equivalent of the desktop sidebar's "Server admin"
        // section (issue #350) — this dropdown is the only nav surface on
        // mobile for /admin* routes, since the bottom tabbar/More sheet only
        // render inside a campaign.
        adminNav.map((item) => (
          <Link
            key={item.key}
            to={item.to!}
            role="menuitem"
            className="block px-2 py-1.5 rounded-md"
            style={{ color: 'var(--color-text)' }}
            onClick={onClose}
          >
            {item.label}
          </Link>
        ))
      ) : (
        isAdmin && (
          <Link to="/admin" role="menuitem" className="block px-2 py-1.5 rounded-md" style={{ color: 'var(--color-text)' }} onClick={onClose}>
            Admin
          </Link>
        )
      )}
      <Link to="/tokens" role="menuitem" className="block px-2 py-1.5 rounded-md" style={{ color: 'var(--color-text)' }} onClick={onClose}>
        API tokens
      </Link>
      <Link to="/preferences" role="menuitem" className="block px-2 py-1.5 rounded-md" style={{ color: 'var(--color-text)' }} onClick={onClose}>
        Preferences
      </Link>
      <Link to="/glossary" role="menuitem" className="block px-2 py-1.5 rounded-md" style={{ color: 'var(--color-text)' }} onClick={onClose}>
        Glossary
      </Link>
      <Link to="/credits" role="menuitem" className="block px-2 py-1.5 rounded-md" style={{ color: 'var(--color-text)' }} onClick={onClose}>
        Credits
      </Link>
      <button
        role="menuitem"
        className="w-full text-left px-2 py-1.5 rounded-md"
        style={{ color: 'var(--color-text)' }}
        onClick={() => {
          onClose();
          onChangePassword();
        }}
      >
        Change password
      </button>
      <button role="menuitem" className="w-full text-left px-2 py-1.5 rounded-md text-rose-400" onClick={onLogout}>
        Logout
      </button>
    </Card>
  );
}
