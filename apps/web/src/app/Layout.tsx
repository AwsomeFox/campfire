/**
 * Authenticated app chrome — sticky topbar + mobile bottom tabbar.
 * Mirrors design/02-dashboard.html. Campaign-scoped nav only renders inside
 * /c/:campaignId routes.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from './auth';
import { useCampaign } from './CampaignContext';
import { api, ApiError, API } from '../lib/api';
import { Btn, TextInput } from '../components/ui';

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="cf-card p-5 w-full max-w-sm space-y-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-bold text-white">Change password</h2>
        {done ? (
          <div className="space-y-3">
            <p className="text-sm text-emerald-400">Password updated.</p>
            <Btn className="w-full" onClick={onClose}>Done</Btn>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={onSubmit}>
            <div className="space-y-1">
              <label className="text-xs text-slate-400 font-semibold">Current password</label>
              <TextInput
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-400 font-semibold">New password</label>
              <TextInput
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-400 font-semibold">Confirm new password</label>
              <TextInput
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            {error && <p className="text-sm text-rose-400">{error}</p>}
            <div className="flex gap-2 pt-1">
              <Btn ghost type="button" className="flex-1" onClick={onClose}>Cancel</Btn>
              <Btn type="submit" className="flex-1" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Btn>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

const campaignNavLinks = [
  { to: '', label: 'Dashboard', end: true },
  { to: 'npcs', label: 'NPCs' },
  { to: 'locations', label: 'Locations' },
  { to: 'party', label: 'Party' },
  { to: 'sessions', label: 'Sessions' },
  { to: 'notes', label: 'Notes' },
];

export function Layout() {
  const { me, isAdmin, roleIn, logout } = useAuth();
  const params = useParams<{ campaignId: string }>();
  const campaignId = params.campaignId ? Number(params.campaignId) : undefined;
  const campaign = useCampaign(campaignId);
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const role = campaignId !== undefined ? roleIn(campaignId) : null;
  const isDm = role === 'dm';

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
    await logout();
    navigate('/login');
  }

  const displayName = me?.user.displayName || me?.user.username || '';

  return (
    <div className="pb-20 md:pb-10 min-h-screen">
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/" className="flex items-center gap-2 font-extrabold text-white shrink-0">
            🔥<span className="hidden sm:inline">Campfire</span>
          </Link>
          {campaign && (
            <>
              <span className="text-slate-700 hidden sm:inline">/</span>
              <span className="text-sm font-semibold text-slate-200 truncate">{campaign.name}</span>
            </>
          )}
          {campaignId !== undefined && (
            <nav className="hidden md:flex items-center gap-5 ml-6 text-sm text-slate-400">
              {campaignNavLinks.map((link) => (
                <NavLink
                  key={link.label}
                  to={`/c/${campaignId}${link.to ? `/${link.to}` : ''}`}
                  end={link.end}
                  className={({ isActive }) =>
                    isActive ? 'text-white font-semibold' : 'hover:text-white'
                  }
                >
                  {link.label}
                </NavLink>
              ))}
            </nav>
          )}
          <div className="ml-auto flex items-center gap-2.5 shrink-0 relative" ref={menuRef}>
            {role && <span className="cf-chip cf-chip-dm">{role === 'dm' ? 'DM' : role === 'player' ? 'Player' : 'Viewer'}</span>}
            {isAdmin && <span className="cf-chip cf-chip-proposal">Admin</span>}
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="h-8 w-8 rounded-full bg-amber-500/15 border border-amber-500/60 text-amber-400 text-xs font-bold flex items-center justify-center"
            >
              {initials(displayName)}
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-11 w-56 cf-card p-2 space-y-1 text-sm z-40">
                <p className="px-2 py-1 text-xs text-slate-500 truncate">{displayName}</p>
                {campaignId !== undefined && (
                  <Link
                    to={`/c/${campaignId}/notes`}
                    className="block px-2 py-1.5 rounded-lg text-slate-200 hover:bg-slate-700/50"
                    onClick={() => setMenuOpen(false)}
                  >
                    My notes
                  </Link>
                )}
                {isAdmin && (
                  <Link
                    to="/admin"
                    className="block px-2 py-1.5 rounded-lg text-slate-200 hover:bg-slate-700/50"
                    onClick={() => setMenuOpen(false)}
                  >
                    Admin
                  </Link>
                )}
                {isDm && campaignId !== undefined && (
                  <Link
                    to={`/c/${campaignId}/members`}
                    className="block px-2 py-1.5 rounded-lg text-slate-200 hover:bg-slate-700/50"
                    onClick={() => setMenuOpen(false)}
                  >
                    Members
                  </Link>
                )}
                {isDm && campaignId !== undefined && (
                  <Link
                    to={`/c/${campaignId}/proposals`}
                    className="block px-2 py-1.5 rounded-lg text-slate-200 hover:bg-slate-700/50"
                    onClick={() => setMenuOpen(false)}
                  >
                    Proposals
                  </Link>
                )}
                <Link
                  to="/tokens"
                  className="block px-2 py-1.5 rounded-lg text-slate-200 hover:bg-slate-700/50"
                  onClick={() => setMenuOpen(false)}
                >
                  API tokens
                </Link>
                <button
                  className="w-full text-left px-2 py-1.5 rounded-lg text-slate-200 hover:bg-slate-700/50"
                  onClick={() => {
                    setMenuOpen(false);
                    setShowPasswordModal(true);
                  }}
                >
                  Change password
                </button>
                <button
                  className="w-full text-left px-2 py-1.5 rounded-lg text-rose-400 hover:bg-slate-700/50"
                  onClick={onLogout}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <Outlet />

      {campaignId !== undefined && (
        <nav className="cf-tabbar">
          <NavLink to={`/c/${campaignId}`} end className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico">🏠</span>Home
          </NavLink>
          <NavLink to={`/c/${campaignId}#quests`} className="">
            <span className="ico">📜</span>Quests
          </NavLink>
          <NavLink to={`/c/${campaignId}/party`} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico">🛡</span>Party
          </NavLink>
          <NavLink to={`/c/${campaignId}/notes`} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico">📝</span>Notes
          </NavLink>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex flex-col items-center gap-0.5 pt-2 text-[10px] font-semibold text-slate-500"
          >
            <span className="text-lg leading-none">⋯</span>More
          </button>
        </nav>
      )}

      {showPasswordModal && <ChangePasswordModal onClose={() => setShowPasswordModal(false)} />}
    </div>
  );
}
