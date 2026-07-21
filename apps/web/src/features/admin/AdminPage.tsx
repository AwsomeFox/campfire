/**
 * Server admin overview — /admin (no campaignId; server-wide).
 *
 * Split per issue #350: this page used to stack all eleven admin cards into
 * one long scroll. It's now just the overview (metrics, a storage summary, the
 * 10 most recent audit entries, and quick links) — the full cards live on
 * their owning /admin/* sub-page:
 *   /admin/users   — UsersCard, ResetRequestsCard, SettingsCard
 *   /admin/rules   — RulePacksCard
 *   /admin/ai      — AiConsoleCard
 *   /admin/auth    — OidcCard, TokensCard
 *   /admin/storage — StorageCard, BackupCard
 *   /admin/audit   — AuditLogCard (full log)
 * See router.tsx for the route registrations and Layout.tsx for the sidebar
 * "Server admin" section that links between them.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AuditEntry, StorageStats } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Skeleton, ErrorNote } from '../../components/ui';
import { MetricsCard } from './MetricsCard';
import { RequireServerAdmin } from './RequireServerAdmin';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

const QUICK_LINKS: Array<{ to: string; icon: string; label: string; hint: string }> = [
  { to: '/admin/users', icon: '👤', label: 'Users', hint: 'Accounts, password resets, sign-in settings' },
  { to: '/admin/rules', icon: '📚', label: 'Rule packs', hint: 'Install and manage rule packs' },
  { to: '/admin/ai', icon: '🤖', label: 'AI console', hint: 'AI provider configuration & usage' },
  { to: '/admin/auth', icon: '🔐', label: 'Auth', hint: 'OIDC/SSO & API tokens' },
  { to: '/admin/storage', icon: '💾', label: 'Storage', hint: 'Quotas, cleanup & backup export' },
  { to: '/admin/audit', icon: '📜', label: 'Audit log', hint: 'Full server-wide admin history' },
];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="cf-inset p-2.5">
      <p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className="text-sm font-bold text-white truncate" title={value}>
        {value}
      </p>
    </div>
  );
}

function StorageSummaryCard() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStats(await api.get<StorageStats>(`${API}/admin/storage`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load storage stats.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">Storage</h2>
        <Link to="/admin/storage" className="text-[11px] text-slate-500 hover:text-white">
          manage →
        </Link>
      </div>
      {error && <ErrorNote message={error} onRetry={load} />}
      {!stats ? (
        <Skeleton lines={2} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <Stat label="On disk" value={formatBytes(stats.diskBytes)} />
          <Stat label="Attachments" value={stats.fileCount.toLocaleString()} />
          <Stat label="Campaigns tracked" value={stats.campaigns.length.toLocaleString()} />
        </div>
      )}
    </Card>
  );
}

function RecentAuditCard() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const all = await api.get<AuditEntry[]>(`${API}/admin/audit`);
      setEntries(all.slice(0, 10));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the audit log.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">Recent admin activity</h2>
        <Link to="/admin/audit" className="text-[11px] text-slate-500 hover:text-white">
          full log →
        </Link>
      </div>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!entries ? (
        <Skeleton lines={3} />
      ) : entries.length === 0 ? (
        <p className="text-xs text-slate-500">No server-wide admin actions logged yet.</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {entries.map((e) => (
            <li key={e.id} className="py-1.5 flex items-center justify-between gap-3 text-xs">
              <span className="text-slate-300 truncate">
                <code className="text-[11px] text-amber-400">{e.action}</code>
                <span className="text-slate-500"> · {e.actor}</span>
              </span>
              <span className="text-slate-600 whitespace-nowrap">{new Date(e.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function QuickLinksCard() {
  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Admin sections</h2>
      <div className="grid sm:grid-cols-2 gap-2">
        {QUICK_LINKS.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className="cf-inset p-3 flex items-start gap-2.5 hover:border-amber-500/40"
          >
            <span className="text-lg leading-none">{l.icon}</span>
            <span>
              <span className="block text-sm font-semibold text-white">{l.label}</span>
              <span className="block text-[11px] text-slate-500">{l.hint}</span>
            </span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

function AdminOverview() {
  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
      <h1 className="text-xl font-extrabold text-white">⚙️ Server admin</h1>
      <MetricsCard />
      <div className="grid md:grid-cols-2 gap-5">
        <StorageSummaryCard />
        <RecentAuditCard />
      </div>
      <QuickLinksCard />
    </div>
  );
}

export default function AdminPage() {
  return (
    <RequireServerAdmin>
      <AdminOverview />
    </RequireServerAdmin>
  );
}
