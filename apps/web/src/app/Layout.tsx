/**
 * Authenticated app chrome — desktop sidebar + mobile topbar/tabbar/More sheet.
 * Mirrors the Nocturne app shell in design/claude-design/Campfire.dc.html
 * (the block starting at the `inApp` sc-if, just above "Dashboard").
 * Campaign-scoped nav only renders inside /c/:campaignId routes.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from './auth';
import { useCampaign, useCampaigns } from './CampaignContext';
import { api, ApiError, API } from '../lib/api';
import { Btn, Card, TextInput } from '../components/ui';
import { NotificationsBell } from '../features/notifications/NotificationsBell';

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

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
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

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
      setError(err instanceof ApiError ? err.message : 'Failed to change password.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" style={{ zIndex: 52 }} onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">Change password</div>
        {done ? (
          <div className="space-y-3">
            <p className="text-sm" style={{ color: '#34d399' }}>Password updated.</p>
            <Btn className="w-full" onClick={onClose}>Done</Btn>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="currentPassword">Current password</label>
              <TextInput
                id="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div className="field">
              <label htmlFor="newPassword">New password</label>
              <TextInput
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="field">
              <label htmlFor="confirmPassword">Confirm new password</label>
              <TextInput
                id="confirmPassword"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            {error && <p className="text-sm text-rose-400">{error}</p>}
            <div className="dialog-actions">
              <Btn ghost type="button" onClick={onClose}>Cancel</Btn>
              <Btn type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
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
  const { me, isAdmin, roleIn, refresh: refreshAuth, logout } = useAuth();
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
  const menuRef = useRef<HTMLDivElement>(null);
  // Track WHICH campaign we've stale-checked, not a bare boolean — so navigating
  // to a different campaign re-checks (and clears a prior lock screen) instead of
  // trusting a once-per-session flag.
  const staleCheckedIdRef = useRef<number | undefined>(undefined);

  const role = campaignId !== undefined ? roleIn(campaignId) : null;
  const isDm = role === 'dm';
  const roleLabel = role === 'dm' ? 'DM' : role === 'player' ? 'Player' : role === 'viewer' ? 'Viewer' : null;

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

  async function onLogout() {
    setMenuOpen(false);
    setMoreOpen(false);
    await logout();
    navigate('/login');
  }

  const displayName = me?.user.displayName || me?.user.username || '';

  // Nav items that actually resolve to a route. Design's Encounters/World/
  // Compendium/Settings(player-facing) items render greyed with a "soon" tag.
  const mainNav: NavItem[] = campaignId !== undefined
    ? [
        { key: 'dashboard', label: 'Dashboard', to: `/c/${campaignId}` },
        { key: 'quests', label: 'Quests', to: `/c/${campaignId}/quests` },
        { key: 'world', label: 'World', to: `/c/${campaignId}/locations` },
        { key: 'npcs', label: 'NPCs', to: `/c/${campaignId}/npcs` },
        { key: 'party', label: 'Party', to: `/c/${campaignId}/party` },
        { key: 'sessions', label: 'Sessions', to: `/c/${campaignId}/sessions` },
        { key: 'encounters', label: 'Encounters', to: `/c/${campaignId}/encounters` },
        { key: 'compendium', label: 'Compendium', to: `/c/${campaignId}/compendium` },
        { key: 'notes', label: 'My Notes', to: `/c/${campaignId}/notes` },
      ]
    : [];

  const dmNav: NavItem[] = campaignId !== undefined && isDm
    ? [
        { key: 'settings', label: 'Settings', to: `/c/${campaignId}/settings` },
        { key: 'inbox', label: 'Scribe inbox', to: `/c/${campaignId}/inbox`, badge: inboxCount },
        { key: 'proposals', label: 'Proposals', to: `/c/${campaignId}/proposals` },
        { key: 'members', label: 'Members', to: `/c/${campaignId}/members` },
      ]
    : [];

  const isActivePath = (to?: string) => {
    if (!to) return false;
    const path = to.split('#')[0];
    if (path === `/c/${campaignId}`) {
      return location.pathname === path;
    }
    return location.pathname.startsWith(path);
  };

  if (lostAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--color-bg)' }}>
        <div style={{ maxWidth: 380, width: '100%' }}>
          <Card className="text-center space-y-2">
            <p className="text-2xl">🔒</p>
            <p className="font-bold text-white">You no longer have access to this campaign</p>
            <Link to="/" className="btn btn-primary" style={{ display: 'inline-flex', marginTop: 4 }}>
              Back to your campaigns
            </Link>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--color-bg)' }}>
      {/* Desktop sidebar */}
      {campaignId !== undefined && (
        <aside
          className="hidden md:flex w-[230px] shrink-0 sticky top-0 flex-col gap-1.5 h-screen p-3.5 border-r"
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
            <NotificationsBell />
          </div>

          <nav className="flex flex-col gap-0.5">
            {mainNav.map((item) => (
              <SidebarNavButton key={item.key} item={item} active={isActivePath(item.to)} />
            ))}
          </nav>

          {isDm && (
            <>
              <div className="text-muted text-[10.5px] uppercase tracking-wide pt-3 pb-1 px-2.5">
                Dungeon master
              </div>
              <nav className="flex flex-col gap-0.5">
                {dmNav.map((item) => (
                  <SidebarNavButton key={item.key} item={item} active={isActivePath(item.to)} />
                ))}
              </nav>
            </>
          )}

          <nav className="flex flex-col gap-0.5 mt-1">
            {isAdmin && (
              <SidebarNavButton
                item={{ key: 'admin', label: 'Admin', to: '/admin' }}
                active={location.pathname === '/admin'}
              />
            )}
            <SidebarNavButton
              item={{ key: 'tokens', label: 'API tokens', to: '/tokens' }}
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
              Preferences
            </Link>
          </div>
          <div className="flex items-center gap-1.5 px-1">
            <button
              className="btn btn-ghost flex-1 justify-start"
              style={{ fontSize: 12 }}
              onClick={() => setShowPasswordModal(true)}
            >
              Change password
            </button>
          </div>
          <button className="btn btn-ghost justify-start" style={{ fontSize: 12 }} onClick={onLogout}>
            Sign out
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
          <NotificationsBell />
          {campaignId !== undefined && roleLabel && (
            <button
              className="tag tag-outline cursor-pointer"
              style={{ minHeight: 30, background: 'transparent', border: '1px solid var(--color-divider)', color: 'var(--color-text)' }}
              onClick={() => setMoreOpen(true)}
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
              >
                {initials(displayName)}
              </button>
              {menuOpen && <UserMenu isAdmin={isAdmin} displayName={displayName} onLogout={onLogout} onClose={() => setMenuOpen(false)} onChangePassword={() => setShowPasswordModal(true)} />}
            </div>
          )}
        </header>

        {/* Desktop-only header for non-campaign routes (home, admin, tokens) */}
        {campaignId === undefined && (
          <header
            className="hidden md:flex sticky top-0 z-30 items-center gap-2.5 px-5 py-3 border-b"
            style={{ borderColor: 'var(--color-divider)' }}
          >
            <Link to="/" className="flex items-center gap-2.5">
              <FlameMark />
              <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 500, fontSize: 15 }}>Campfire</span>
            </Link>
            <span className="tag tag-outline" style={{ fontSize: 10 }}>self-hosted</span>
            <div className="flex-1" />
            <NotificationsBell />
            {isAdmin && (
              <Link to="/admin" className="btn btn-ghost" style={{ fontSize: 12.5 }}>
                Admin
              </Link>
            )}
            <Link to="/tokens" className="btn btn-ghost" style={{ fontSize: 12.5 }}>
              API tokens
            </Link>
            <span className="text-muted" style={{ fontSize: 12 }}>{displayName}</span>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={onLogout}>
              Sign out
            </button>
          </header>
        )}

        <main className="flex-1 w-full pb-20 md:pb-10">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom tab bar */}
      {campaignId !== undefined && (
        <nav className="cf-tabbar">
          <NavLink to={`/c/${campaignId}`} end className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico">🏠</span>Home
          </NavLink>
          <NavLink to={`/c/${campaignId}/quests`} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico">📜</span>Quests
          </NavLink>
          <NavLink to={`/c/${campaignId}/party`} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico">🛡</span>Party
          </NavLink>
          <NavLink to={`/c/${campaignId}/notes`} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico">📝</span>Notes
          </NavLink>
          <button onClick={() => setMoreOpen(true)}>
            <span className="ico">⋯</span>More
          </button>
        </nav>
      )}

      {/* More sheet (mobile) */}
      {moreOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          style={{ background: 'color-mix(in srgb, var(--color-neutral-900) 55%, transparent)' }}
          onClick={() => setMoreOpen(false)}
        >
          <div
            className="card elev-lg w-full"
            style={{
              maxWidth: 440,
              borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
              padding: '18px 18px calc(18px + env(safe-area-inset-bottom))',
              gap: 4,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="mx-auto mb-2.5"
              style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--color-neutral-700)' }}
            />
            <div className="text-muted" style={{ fontSize: 11, padding: '0 6px 6px' }}>
              Signed in as {displayName}
              {roleLabel ? ` · viewing as ${roleLabel}` : ''}
            </div>
            {mainNav.map((item) => (
              <MoreSheetItem key={item.key} item={item} onNavigate={() => setMoreOpen(false)} />
            ))}
            {dmNav.map((item) => (
              <MoreSheetItem key={item.key} item={item} onNavigate={() => setMoreOpen(false)} />
            ))}
            {isAdmin && (
              <MoreSheetItem item={{ key: 'admin', label: 'Admin', to: '/admin' }} onNavigate={() => setMoreOpen(false)} />
            )}
            <MoreSheetItem item={{ key: 'tokens', label: 'API tokens', to: '/tokens' }} onNavigate={() => setMoreOpen(false)} />
            <MoreSheetItem item={{ key: 'switch', label: 'Switch campaign', to: '/' }} onNavigate={() => setMoreOpen(false)} />
            <MoreSheetItem item={{ key: 'preferences', label: 'Preferences', to: '/preferences' }} onNavigate={() => setMoreOpen(false)} />
            <button
              className="flex items-center gap-2.5 min-h-[46px] px-2.5 text-left rounded-md w-full"
              style={{ fontSize: 14.5, color: 'var(--color-text)' }}
              onClick={() => {
                setMoreOpen(false);
                setShowPasswordModal(true);
              }}
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
      )}

      {showPasswordModal && <ChangePasswordModal onClose={() => setShowPasswordModal(false)} />}
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
  displayName,
  onLogout,
  onClose,
  onChangePassword,
}: {
  isAdmin: boolean;
  displayName: string;
  onLogout: () => void;
  onClose: () => void;
  onChangePassword: () => void;
}) {
  return (
    <div
      className="absolute right-0 top-11 w-56 card elev-md p-2 space-y-1 text-sm z-40"
      style={{ gap: 2 }}
    >
      <p className="px-2 py-1 text-xs text-muted truncate">{displayName}</p>
      {isAdmin && (
        <Link to="/admin" className="block px-2 py-1.5 rounded-md" style={{ color: 'var(--color-text)' }} onClick={onClose}>
          Admin
        </Link>
      )}
      <Link to="/tokens" className="block px-2 py-1.5 rounded-md" style={{ color: 'var(--color-text)' }} onClick={onClose}>
        API tokens
      </Link>
      <Link to="/preferences" className="block px-2 py-1.5 rounded-md" style={{ color: 'var(--color-text)' }} onClick={onClose}>
        Preferences
      </Link>
      <button
        className="w-full text-left px-2 py-1.5 rounded-md"
        style={{ color: 'var(--color-text)' }}
        onClick={() => {
          onClose();
          onChangePassword();
        }}
      >
        Change password
      </button>
      <button className="w-full text-left px-2 py-1.5 rounded-md text-rose-400" onClick={onLogout}>
        Logout
      </button>
    </div>
  );
}
