/**
 * Authenticated app chrome — desktop sidebar + mobile topbar/tabbar/More sheet.
 * Mirrors the Nocturne app shell in design/claude-design/Campfire.dc.html
 * (the block starting at the `inApp` sc-if, just above "Dashboard").
 * Campaign-scoped nav only renders inside /c/:campaignId routes.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth';
import { useCampaign, useCampaigns } from './CampaignContext';
import { MentionsProvider } from './MentionsContext';
import { api, ApiError, API } from '../lib/api';
import { useFormattingLocale } from '../lib/format';
import { initials } from '../lib/avatarText';
import { useAiDmSeat } from '../lib/query';
import { Btn, Card } from '../components/ui';
import { PasswordInput } from '../components/PasswordInput';
import { useDialog } from '../components/useDialog';
import {
  NotificationsBell,
  NotificationsPanel,
  NotificationsProvider,
} from '../features/notifications/NotificationsBell';
import { AiDmLiveActivityProvider, useAiDmLiveActivityState } from '../features/ai-dm/useAiDmLiveActivity';
import { GameIcon } from '../components/GameIcon';
import { EntityDeepLinkFocus } from './EntityDeepLinkFocus';
import { useAnnounce, useClearAnnouncements } from '../components/Announcer';

function FlameMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="shrink-0">
      <path
        d="M12 3c1.8 2.6 4.6 4.2 4.6 8a4.6 4.6 0 0 1-9.2 0c0-1.5.5-2.7 1.3-3.9.3 1 .9 1.7 1.7 2.2C10.2 7 10.7 4.9 12 3z"
        stroke="var(--color-accent)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  // Escape-to-close (suppressed mid-save), focus trap, and focus restore to trigger.
  const dialogRef = useDialog<HTMLDivElement>({ onClose, disabled: saving });
  const titleId = 'change-password-title';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirm) {
      setError('New passwords do not match.');
      return;
    }
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
    <div className="dialog-backdrop" style={{ zIndex: 52 }} onClick={() => !saving && onClose()}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id={titleId}>{t('nav.passwordModalTitle')}</div>
        {done ? (
          <div className="space-y-3">
            <p className="text-sm" style={{ color: '#34d399' }}>{t('nav.passwordUpdated')}</p>
            <Btn className="w-full" onClick={onClose}>{t('nav.done')}</Btn>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={onSubmit}>
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
            <div className="dialog-actions">
              <Btn ghost type="button" onClick={onClose}>{t('nav.cancel')}</Btn>
              <Btn type="submit" disabled={saving}>{saving ? t('nav.saving') : t('nav.save')}</Btn>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

type NavItem = {
  key: string;
  label: string;
  to?: string;
  soon?: boolean;
  badge?: number;
};

/** Campaign-wide search box (issue #64). Submits to /c/:id/search?q=. */
function SidebarSearch({ campaignId }: { campaignId: number }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const navigate = useNavigate();
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
 * Coarse "x ago" label for the offline banner. Intentionally low-precision
 * (minutes/hours/days): the exact second is noise next to "your data may be
 * stale", and a coarse label avoids the jitter of a ticking clock on a banner
 * that doesn't need to update in place.
 */
function relativeAgo(at: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
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
    const abs = new Date(lastSyncedAt).toLocaleString(formattingLocale);
    return { ago, abs };
  }, [lastSyncedAt, formattingLocale]);

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

function SidebarNavButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick?: () => void }) {
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
  if (item.soon || !item.to) {
    return (
      <div
        className="flex items-center gap-2 px-2.5 text-sm cursor-not-allowed select-none"
        style={{ ...sharedStyle, color: 'var(--color-neutral-600)' }}
      >
        {inner}
      </div>
    );
  }
  return (
    <Link
      to={item.to}
      onClick={onClick}
      className="flex items-center gap-2 px-2.5 text-sm"
      style={{
        ...sharedStyle,
        color: active ? 'var(--color-accent)' : 'var(--color-neutral-300)',
        background: active ? 'color-mix(in srgb, var(--color-accent) 9%, transparent)' : 'transparent',
      }}
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
  const formattingLocale = useFormattingLocale();
  const announce = useAnnounce();
  const clearAnnouncements = useClearAnnouncements();
  const params = useParams<{ campaignId: string }>();
  const campaignId = params.campaignId ? Number(params.campaignId) : undefined;
  const campaign = useCampaign(campaignId);
  const { campaigns, loading: campaignsLoading, error: campaignsError, refresh: refreshCampaigns } = useCampaigns();
  const navigate = useNavigate();
  const location = useLocation();
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
  const isDm = role === 'dm';

  // AI-DM seat mode drives the "Table" nav item (issue #339): the player-facing table
  // only exists when the AI holds the DM seat (Driver mode). The seat read stops on a
  // 4xx (feature off / not a member), so the item simply stays hidden then — no error.
  const aiSeatQuery = useAiDmSeat(campaignId);
  const aiDriverActive = aiSeatQuery.data?.mode === 'driver';
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
        const items = await api.get<unknown[]>(`${API}/campaigns/${campaignId}/inbox`);
        if (!cancelled) setInboxCount(items.length);
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
    // Issue #506: drop any stale live-region text (an in-flight roll/HP/turn
    // announcement) before this account's session ends — a shared device's next
    // user must not find leftover identity-scoped text sitting in the DOM.
    clearAnnouncements();
    // Commit `me = null` before navigate. logout() no longer awaits cache/network,
    // but without flushSync a same-turn navigate('/login') can re-render LoginPage
    // while `me` is still set — LoginPage then bounces away and drops
    // `{ signedOut: true }`. flushSync also means we do not await logout (Copilot):
    // announce + replace-navigate are not gated on cache/POST timing.
    flushSync(() => {
      void logout();
    });
    // A confirmation for keyboard/screen-reader users that sign-out succeeded —
    // this live region is mounted at the app root (outside the router), so it
    // survives the navigation below and is still there to be read on /login.
    announce(t('nav.signedOutAnnouncement'), { assertive: true });
    // `replace` so the protected route this tab was just on is gone from history
    // — Back must not be able to return to it (the AuthedLayout guard would bounce
    // it to /login anyway once `me` is null, but `replace` here avoids that extra
    // hop and the momentary flash of a guarded redirect). Overwrites any
    // AuthedLayout `{ from }` redirect that flushSync may have triggered.
    navigate('/login', { replace: true, state: { signedOut: true } });
  }

  const displayName = me?.user.displayName || me?.user.username || '';

  // Nav items that actually resolve to a route. Design's Encounters/World/
  // Compendium/Settings(player-facing) items render greyed with a "soon" tag.
  const mainNav: NavItem[] = campaignId !== undefined
    ? [
        { key: 'dashboard', label: t('nav.dashboard'), to: `/c/${campaignId}` },
        { key: 'quests', label: t('nav.quests'), to: `/c/${campaignId}/quests` },
        { key: 'world', label: t('nav.world'), to: `/c/${campaignId}/locations` },
        { key: 'npcs', label: t('nav.npcs'), to: `/c/${campaignId}/npcs` },
        { key: 'factions', label: t('nav.factions'), to: `/c/${campaignId}/factions` },
        { key: 'party', label: t('nav.party'), to: `/c/${campaignId}/party` },
        { key: 'inventory', label: t('nav.inventory'), to: `/c/${campaignId}/inventory` },
        { key: 'sessions', label: t('nav.sessions'), to: `/c/${campaignId}/sessions` },
        { key: 'timeline', label: t('nav.timeline'), to: `/c/${campaignId}/timeline` },
        { key: 'session-zero', label: t('nav.sessionZero'), to: `/c/${campaignId}/session-zero` },
        { key: 'encounters', label: t('nav.encounters'), to: `/c/${campaignId}/encounters` },
        // Only surfaced while the AI holds the DM seat (Driver mode) — issue #339.
        ...(aiDriverActive ? [{ key: 'table', label: t('nav.table'), to: `/c/${campaignId}/table` }] : []),
        { key: 'compendium', label: t('nav.compendium'), to: `/c/${campaignId}/compendium` },
        { key: 'notes', label: t('nav.myNotes'), to: `/c/${campaignId}/notes` },
        // Non-DM members get a self-view of the proposals they've submitted (issue #124);
        // the DM's full review queue lives under dmNav below.
        ...(!isDm ? [{ key: 'proposals', label: t('nav.myProposals'), to: `/c/${campaignId}/proposals` }] : []),
      ]
    : [];

  const dmNav: NavItem[] = campaignId !== undefined && isDm
    ? [
        { key: 'storylines', label: t('nav.storylines'), to: `/c/${campaignId}/storylines` },
        { key: 'settings', label: t('nav.settings'), to: `/c/${campaignId}/settings` },
        { key: 'inbox', label: t('nav.scribeInbox'), to: `/c/${campaignId}/inbox`, badge: inboxCount },
        { key: 'proposals', label: t('nav.proposals'), to: `/c/${campaignId}/proposals`, badge: pendingProposals },
        { key: 'trash', label: t('nav.trash'), to: `/c/${campaignId}/trash`, badge: trashCount },
        { key: 'members', label: t('nav.members'), to: `/c/${campaignId}/members` },
      ]
    : [];

  // Server admin console is on any /admin* route (issue #350) — mirrors the
  // campaign dmNav pattern above so the sidebar shows a "Server admin" section
  // with sub-page links instead of the flat single entry used everywhere else.
  const onAdminRoute = location.pathname.startsWith('/admin');
  const adminNav: NavItem[] = isAdmin
    ? [
        { key: 'admin-overview', label: t('nav.adminOverview'), to: '/admin' },
        { key: 'admin-users', label: t('nav.adminUsers'), to: '/admin/users' },
        { key: 'admin-rules', label: t('nav.adminRules'), to: '/admin/rules' },
        { key: 'admin-ai', label: t('nav.adminAi'), to: '/admin/ai' },
        { key: 'admin-auth', label: t('nav.adminAuth'), to: '/admin/auth' },
        { key: 'admin-storage', label: t('nav.adminStorage'), to: '/admin/storage' },
        { key: 'admin-audit', label: t('nav.adminAudit'), to: '/admin/audit' },
      ]
    : [];

  const isActivePath = (to?: string) => {
    if (!to) return false;
    const path = to.split('#')[0];
    if (path === `/c/${campaignId}` || path === '/admin') {
      return location.pathname === path;
    }
    return location.pathname.startsWith(path);
  };

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
    <div className="min-h-screen flex" style={{ background: 'var(--color-bg)' }}>
      {/* Desktop sidebar */}
      {(campaignId !== undefined || onAdminRoute) && (
        <aside
          className="hidden md:flex w-[230px] shrink-0 sticky top-0 flex-col gap-1.5 h-screen overflow-y-auto overflow-x-hidden p-3.5 border-r"
          style={{ borderColor: 'var(--color-divider)' }}
        >
          <div className="flex items-center gap-1 mb-2">
            <Link
              to="/"
              className="flex flex-1 min-w-0 items-center gap-2.5 px-2 py-1.5 rounded-md"
              style={{ borderRadius: 'var(--radius-md)' }}
            >
              <FlameMark size={22} />
              <span className="min-w-0 leading-tight">
                <span
                  className="block truncate text-[15px]"
                  style={{ fontFamily: 'var(--font-heading)', fontWeight: 500, color: 'var(--color-text)' }}
                >
                  {campaign?.name ?? 'Campfire'}
                </span>
                <span className="block text-[11px] text-muted">Switch campaign</span>
              </span>
            </Link>
            {desktopLayout && <NotificationsBell />}
          </div>

          {campaignId !== undefined && <SidebarSearch campaignId={campaignId} />}

          <nav className="flex flex-col gap-0.5">
            {mainNav.map((item) => (
              <SidebarNavButton key={item.key} item={item} active={isActivePath(item.to)} />
            ))}
          </nav>

          {isDm && (
            <>
              <div className="text-muted text-[10.5px] uppercase tracking-wide pt-3 pb-1 px-2.5">
                {t('nav.dungeonMaster')}
              </div>
              <nav className="flex flex-col gap-0.5">
                {dmNav.map((item) => (
                  <SidebarNavButton key={item.key} item={item} active={isActivePath(item.to)} />
                ))}
              </nav>
            </>
          )}

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

          <nav className="flex flex-col gap-0.5 mt-1">
            {isAdmin && !onAdminRoute && (
              <SidebarNavButton
                item={{ key: 'admin', label: t('nav.serverAdmin'), to: '/admin' }}
                active={location.pathname === '/admin'}
              />
            )}
            <SidebarNavButton
              item={{ key: 'tokens', label: t('nav.apiTokens'), to: '/tokens' }}
              active={location.pathname === '/tokens'}
            />
          </nav>

          <div className="flex-1" />
          <div className="hr my-1" />
          <div className="flex items-center justify-between px-2 text-[11px] text-muted">
            <span className="truncate">{displayName}</span>
            {roleLabel && <span className="tag tag-accent" style={{ fontSize: 9.5 }}>{roleLabel}</span>}
          </div>
          <div className="flex items-center gap-1.5 px-1">
            <Link to="/preferences" className="btn btn-ghost flex-1 justify-start" style={{ fontSize: 12 }}>
              {t('nav.preferences')}
            </Link>
          </div>
          <div className="flex items-center gap-1.5 px-1">
            <button
              className="btn btn-ghost flex-1 justify-start"
              style={{ fontSize: 12 }}
              onClick={() => setShowPasswordModal(true)}
            >
              {t('nav.changePassword')}
            </button>
          </div>
          <button className="btn btn-ghost justify-start" style={{ fontSize: 12 }} onClick={onLogout}>
            {t('nav.signOut')}
          </button>
        </aside>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile topbar */}
        <header
          className="md:hidden sticky top-0 z-30 flex items-center gap-2.5 px-3.5 py-2.5 border-b backdrop-blur"
          style={{
            borderColor: 'var(--color-divider)',
            background: 'color-mix(in srgb, var(--color-bg) 88%, transparent)',
          }}
        >
          <Link to="/" className="flex items-center gap-2">
            <FlameMark />
          </Link>
          <div className="leading-tight min-w-0">
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 500, fontSize: 14 }}>
              {campaign?.name ?? 'Campfire'}
            </div>
          </div>
          <div className="flex-1" />
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
            className="hidden md:flex sticky top-0 z-30 items-center gap-2.5 px-5 py-3 border-b"
            style={{ borderColor: 'var(--color-divider)' }}
          >
            <Link to="/" className="flex items-center gap-2.5">
              <FlameMark />
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

        {/* Archived (paused/completed) campaigns are read-only server-side — surface it on every campaign page. */}
        {campaign && campaign.status !== 'active' && (
          <div
            className="px-4 py-2 text-center"
            style={{
              fontSize: 12.5,
              color: 'var(--color-accent-200)',
              background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
              borderBottom: '1px solid var(--color-divider)',
            }}
          >
            This campaign is {campaign.status} — archived and read-only.
            {isDm ? ' Set its status back to active in Settings to make changes.' : ''}
          </div>
        )}

        <main className="flex-1 w-full pb-20 md:pb-10">
          <MentionsProvider campaignId={campaignId}>
            <EntityDeepLinkFocus />
            <Outlet />
          </MentionsProvider>
        </main>
      </div>

      {/* Mobile bottom tab bar */}
      {campaignId !== undefined && (
        <nav className="cf-tabbar">
          <NavLink to={`/c/${campaignId}`} end className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico"><GameIcon slug="campfire" size={20} /></span>Home
          </NavLink>
          <NavLink to={`/c/${campaignId}/quests`} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico"><GameIcon slug="scroll-unfurled" size={20} /></span>Quests
          </NavLink>
          <NavLink to={`/c/${campaignId}/party`} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico"><GameIcon slug="shield" size={20} /></span>Party
          </NavLink>
          <NavLink to={`/c/${campaignId}/notes`} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico"><GameIcon slug="quill-ink" size={20} /></span>Notes
          </NavLink>
          <button onClick={() => setMoreOpen(true)} aria-haspopup="dialog" aria-expanded={moreOpen}>
            <span className="ico">⋯</span>More
          </button>
        </nav>
      )}

      {/* More sheet (mobile) */}
      {moreOpen && (
        <MoreSheet
          displayName={displayName}
          roleLabel={roleLabel}
          mainNav={mainNav}
          dmNav={dmNav}
          isAdmin={isAdmin}
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
    </AiDmLiveActivityProvider>
  );
}

function MoreSheet({
  displayName,
  roleLabel,
  mainNav,
  dmNav,
  isAdmin,
  onClose,
  onChangePassword,
  onLogout,
}: {
  displayName: string;
  roleLabel: string | null;
  mainNav: NavItem[];
  dmNav: NavItem[];
  isAdmin: boolean;
  onClose: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
}) {
  // Escape-to-close, focus trap, and focus restore to the trigger (issue #92),
  // combined with #104's positioning: capped height + internal scroll so a tall
  // list never clips above the viewport, plus a visible close button.
  const sheetRef = useDialog<HTMLDivElement>({ onClose });
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'color-mix(in srgb, var(--color-neutral-900) 55%, transparent)' }}
      onClick={onClose}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="More navigation"
        className="card elev-lg w-full flex flex-col"
        style={{
          maxWidth: 440,
          maxHeight: 'calc(100dvh - 16px)',
          borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
          padding: '18px 18px calc(18px + env(safe-area-inset-bottom))',
          gap: 4,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="mx-auto mb-2.5 shrink-0"
          style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--color-neutral-700)' }}
        />
        <div className="flex items-start gap-2 shrink-0" style={{ padding: '0 6px 6px' }}>
          <div className="text-muted flex-1 min-w-0" style={{ fontSize: 11 }}>
            Signed in as {displayName}
            {roleLabel ? ` · viewing as ${roleLabel}` : ''}
          </div>
          <button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            className="shrink-0 -mt-1 -mr-1 flex items-center justify-center rounded-md"
            style={{ width: 32, height: 32, color: 'var(--color-text)', fontSize: 18, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
        <div className="flex flex-col overflow-y-auto" style={{ gap: 4, margin: '0 -4px', padding: '0 4px' }}>
          {mainNav.map((item) => (
            <MoreSheetItem key={item.key} item={item} onNavigate={onClose} />
          ))}
          {dmNav.map((item) => (
            <MoreSheetItem key={item.key} item={item} onNavigate={onClose} />
          ))}
          {isAdmin && (
            <MoreSheetItem item={{ key: 'admin', label: 'Server admin', to: '/admin' }} onNavigate={onClose} />
          )}
          <MoreSheetItem item={{ key: 'tokens', label: 'API tokens', to: '/tokens' }} onNavigate={onClose} />
          <MoreSheetItem item={{ key: 'switch', label: 'Switch campaign', to: '/' }} onNavigate={onClose} />
          <MoreSheetItem item={{ key: 'preferences', label: 'Preferences', to: '/preferences' }} onNavigate={onClose} />
          <button
            className="flex items-center gap-2.5 min-h-[46px] px-2.5 text-left rounded-md w-full"
            style={{ fontSize: 14.5, color: 'var(--color-text)' }}
            onClick={onChangePassword}
          >
            Change password
          </button>
          <button
            className="flex items-center gap-2.5 min-h-[46px] px-2.5 text-left rounded-md w-full text-rose-400"
            style={{ fontSize: 14.5 }}
            onClick={onLogout}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function MoreSheetItem({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  if (item.soon || !item.to) {
    return (
      <div
        className="flex items-center gap-2.5 min-h-[46px] px-2.5 text-left"
        style={{ fontSize: 14.5, color: 'var(--color-neutral-600)' }}
      >
        {item.label}
        <span className="tag tag-neutral ml-auto" style={{ fontSize: 9 }}>soon</span>
      </div>
    );
  }
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      className="flex items-center gap-2.5 min-h-[46px] px-2.5 text-left rounded-md"
      style={{ fontSize: 14.5, color: 'var(--color-text)' }}
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
    <div
      ref={menuRef}
      role="menu"
      aria-label="Account menu"
      className="absolute right-0 top-11 w-56 card elev-md p-2 space-y-1 text-sm z-40"
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
    </div>
  );
}
