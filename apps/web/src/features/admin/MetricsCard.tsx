import { useTranslation } from 'react-i18next';
/**
 * Admin observability dashboard card (issue #22). Server-admin only — mounted at
 * the top of the /admin console. Reads GET /admin/metrics (cheap COUNT(*) +
 * PRAGMA snapshot) and shows entity counts, DB size, uptime, version, and a
 * short recent-activity strip. Poll-refreshes on a light interval so an admin
 * watching the page sees a live-ish view without hammering the server.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AdminMetrics } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { Btn, Card, Skeleton, ErrorNote } from '../../components/ui';
import { formatNumber, formatDateTime } from '../../lib/format';

const REFRESH_MS = 30_000;

const COUNT_LABELS: Array<{ key: keyof AdminMetrics['counts']; label: string }> = [
  { key: 'users', label: 'Users' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'characters', label: 'Characters' },
  { key: 'npcs', label: 'NPCs' },
  { key: 'locations', label: 'Locations' },
  { key: 'quests', label: 'Quests' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'notes', label: 'Notes' },
  { key: 'encounters', label: 'Encounters' },
  { key: 'attachments', label: 'Attachments' },
  { key: 'apiTokens', label: 'API tokens' },
  { key: 'rulePacks', label: 'Rule packs' },
  { key: 'ruleEntries', label: 'Rule entries' },
];

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

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function MetricsCard() {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMetrics(await api.get<AdminMetrics>(`${API}/admin/metrics`));
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    }
  }, [t]);

  const runCheck = useCallback(async (kind: 'quick-check' | 'integrity-check') => {
    setScanning(true);
    try { await api.post(`${API}/admin/metrics/diagnostics/${kind}`); await load(); }
    catch (err) { setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' })); }
    finally { setScanning(false); }
  }, [load, t]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  if (error && !metrics) {
    return (
      <Card>
        <ErrorNote message={error} onRetry={load} />
      </Card>
    );
  }

  if (!metrics) {
    return (
      <Card>
        <Skeleton lines={4} />
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">Server overview</h2>
        <div className="flex items-center gap-2 text-[11px] text-secondary">
          <span className="cf-chip cf-chip-private" data-testid="client-version" title="Running client version">
            Client: v{__APP_VERSION__}
          </span>
          <span className="cf-chip cf-chip-private" data-testid="server-version" title="Running server version">
            Server: v{metrics.version}
          </span>
          {metrics.commit && (
            <span className="cf-chip" title="Build commit">{metrics.commit.slice(0, 7)}</span>
          )}
          <span>up {formatUptime(metrics.uptimeSeconds)}</span>
        </div>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      {/* Top-line operational stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="SQLite allocated pages" value={formatBytes(metrics.database.sizeBytes)} />
        <Stat label="DB file" value={metrics.database.dbFileBytes === null ? 'Unknown' : formatBytes(metrics.database.dbFileBytes)} />
        <Stat label="WAL" value={metrics.database.walBytes === null ? 'None' : formatBytes(metrics.database.walBytes)} />
        <Stat label="Free disk" value={metrics.storage.freeBytes === null ? 'Unknown' : formatBytes(metrics.storage.freeBytes)} />
        <Stat label="DB pages" value={formatNumber(metrics.database.pageCount)} />
        <Stat label="Active sessions" value={formatNumber(metrics.activeSessions)} />
        <Stat label="Started" value={formatDateTime(metrics.startedAt)} />
      </div>

      {metrics.storage.status !== 'ok' && (
        <p className="text-xs text-amber-300">Storage diagnostics: {metrics.storage.status}. Quick check: {metrics.storage.quickCheck.status}.</p>
      )}
      <div className="flex items-center gap-2">
        <Btn className="text-xs" disabled={scanning} onClick={() => void runCheck('quick-check')}>Run quick check</Btn>
        <Btn className="text-xs" disabled={scanning} onClick={() => void runCheck('integrity-check')}>Run full integrity check</Btn>
        <span className="text-[11px] text-secondary">Last quick check: {metrics.storage.quickCheck.checkedAt ? formatDateTime(metrics.storage.quickCheck.checkedAt) : 'never'}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Stat label="Uploads" value={metrics.storage.uploadsBytes === null ? 'Unknown' : formatBytes(metrics.storage.uploadsBytes)} />
        <Stat label="Backups" value={metrics.storage.backupsBytes === null ? 'Unknown' : formatBytes(metrics.storage.backupsBytes)} />
        <Stat label="Campfire temp" value={metrics.storage.tempBytes === null ? 'Unknown' : formatBytes(metrics.storage.tempBytes)} />
      </div>

      {/* Entity counts */}
      <div>
        <p className="text-[10px] font-bold text-secondary uppercase tracking-widest mb-2">Records</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {COUNT_LABELS.map(({ key, label }) => (
            <Stat key={key} label={label} value={formatNumber(metrics.counts[key])} />
          ))}
        </div>
      </div>

      {/* Recent activity */}
      <div>
        <p className="text-[10px] font-bold text-secondary uppercase tracking-widest mb-2">Recent activity</p>
        {metrics.recentActivity.length === 0 ? (
          <p className="text-xs text-secondary">No recorded activity yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {metrics.recentActivity.map((a) => (
              <li key={a.id} className="py-1.5 flex items-center justify-between gap-3 text-xs">
                <span className="text-slate-300 truncate">
                  <span className="font-semibold text-white">{a.action}</span>
                  <span className="text-secondary"> · {a.actor}</span>
                  {a.entityType && <span className="text-secondary"> · {a.entityType}{a.entityId ? ` #${a.entityId}` : ''}</span>}
                </span>
                <span className="text-secondary whitespace-nowrap">{formatDateTime(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

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
