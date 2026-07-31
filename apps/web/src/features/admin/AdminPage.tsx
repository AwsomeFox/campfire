import { useTranslation } from 'react-i18next';
/**
 * Server admin overview — /admin (no campaignId; server-wide).
 *
 * Split per issue #350: this page used to stack all eleven admin cards into
 * one long scroll. It's now just the overview (metrics, a storage summary, the
 * 10 most recent audit entries, and quick links) — the full cards live on
 * their owning /admin/* sub-page:
 *   /admin/users   — UsersCard, ResetRequestsCard, SettingsCard
 *   /admin/campaigns — AdminCatalogPage (issue #587): the metadata catalog and bulk
 *                    lifecycle controls, spanning campaigns the operator is not a
 *                    member of. Its own page rather than a card here because it is
 *                    server-paged and needs the width.
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
import { api, API, translateApiError } from '../../lib/api';
import { formatNumber, formatDateTime } from '../../lib/format';
import { Card, Skeleton, ErrorNote } from '../../components/ui';
import { MetricsCard } from './MetricsCard';
import { RequireServerAdmin } from './RequireServerAdmin';
import { GameIcon } from '../../components/GameIcon';
import { ActorRoleBadge } from './ActorRoleBadge';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

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
  { to: '/admin/users', icon: 'person', label: 'Users', hint: 'Accounts, password resets, sign-in settings' },
  { to: '/admin/campaigns', icon: 'scroll-quill', label: 'Campaigns', hint: 'Metadata catalog & bulk lifecycle controls' },
  { to: '/admin/rules', icon: 'spell-book', label: 'Rule packs', hint: 'Install and manage rule packs' },
  { to: '/admin/ai', icon: 'robot-golem', label: 'AI console', hint: 'AI provider configuration & usage' },
  { to: '/admin/auth', icon: 'padlock', label: 'Auth', hint: 'OIDC/SSO & API tokens' },
  { to: '/admin/storage', icon: 'database', label: 'Storage', hint: 'Quotas, cleanup & backup export' },
  { to: '/admin/audit', icon: 'scroll-unfurled', label: 'Audit log', hint: 'Full server-wide admin history' },
];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="cf-inset p-2.5">
      <p className="text-[10px] uppercase tracking-widest text-secondary">{label}</p>
      <p className="text-sm font-bold text-white truncate" title={value}>
        {value}
      </p>
    </div>
  );
}

function StorageSummaryCard() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStats(await api.get<StorageStats>(`${API}/admin/storage`));
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">Storage</h2>
        <Link to="/admin/storage" className="text-[11px] text-secondary hover:text-white">
          manage →
        </Link>
      </div>
      {error && <ErrorNote message={error} onRetry={load} />}
      {!stats ? (
        <Skeleton lines={2} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <Stat label="On disk" value={formatBytes(stats.diskBytes)} />
          <Stat label="Attachments" value={formatNumber(stats.fileCount)} />
          <Stat label="Campaigns tracked" value={formatNumber(stats.campaigns.length)} />
        </div>
      )}
    </Card>
  );
}

function RecentAuditCard() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const all = await api.get<AuditEntry[]>(`${API}/admin/audit`);
      setEntries(all.slice(0, 10));
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">Recent admin activity</h2>
        <Link to="/admin/audit" className="text-[11px] text-secondary hover:text-white">
          full log →
        </Link>
      </div>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!entries ? (
        <Skeleton lines={3} />
      ) : entries.length === 0 ? (
        <p className="text-xs text-secondary">No server-wide admin actions logged yet.</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {entries.map((e) => (
            <li key={e.id} className="py-1.5 flex items-center justify-between gap-3 text-xs">
              <span className="text-slate-300 truncate flex items-center gap-1.5">
                <code className="text-[11px] text-amber-400">{e.action}</code>
                <span className="text-secondary"> · {e.actor}</span>
                {/* #526: badge the actor's role so a privileged server-admin action
                    stands out from a campaign-DM's in the overview feed. */}
                <ActorRoleBadge role={e.actorRole} />
              </span>
              <span className="text-secondary whitespace-nowrap">{formatDateTime(e.createdAt)}</span>
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
            className="cf-inset cf-card-hover p-3 flex items-start gap-2.5"
          >
            <span className="leading-none text-[var(--color-accent)]"><GameIcon slug={l.icon} size={UI_ICON_SIZE.md} /></span>
            <span>
              <span className="block text-sm font-semibold text-white">{l.label}</span>
              <span className="block text-[11px] text-secondary">{l.hint}</span>
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
      <h1 className="flex items-center gap-2 text-xl font-extrabold text-white"><GameIcon slug="cog" size={UI_ICON_SIZE.md} /> Server admin</h1>
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
  useTranslation();
  return (
    <RequireServerAdmin>
      <AdminOverview />
    </RequireServerAdmin>
  );
}
