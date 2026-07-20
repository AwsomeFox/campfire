/**
 * Admin observability dashboard card (issue #22). Server-admin only — mounted at
 * the top of the /admin console. Reads GET /admin/metrics (cheap COUNT(*) +
 * PRAGMA snapshot) and shows entity counts, DB size, uptime, version, and a
 * short recent-activity strip. Poll-refreshes on a light interval so an admin
 * watching the page sees a live-ish view without hammering the server.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AdminMetrics } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Skeleton, ErrorNote } from '../../components/ui';

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
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMetrics(await api.get<AdminMetrics>(`${API}/admin/metrics`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load server metrics.");
    }
  }, []);

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
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <span className="cf-chip cf-chip-private">v{metrics.version}</span>
          <span>up {formatUptime(metrics.uptimeSeconds)}</span>
        </div>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      {/* Top-line operational stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Database size" value={formatBytes(metrics.database.sizeBytes)} />
        <Stat label="DB pages" value={metrics.database.pageCount.toLocaleString()} />
        <Stat label="Active sessions" value={metrics.activeSessions.toLocaleString()} />
        <Stat label="Started" value={new Date(metrics.startedAt).toLocaleString()} />
      </div>

      {/* Entity counts */}
      <div>
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Records</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {COUNT_LABELS.map(({ key, label }) => (
            <Stat key={key} label={label} value={metrics.counts[key].toLocaleString()} />
          ))}
        </div>
      </div>

      {/* Recent activity */}
      <div>
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Recent activity</p>
        {metrics.recentActivity.length === 0 ? (
          <p className="text-xs text-slate-500">No recorded activity yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {metrics.recentActivity.map((a) => (
              <li key={a.id} className="py-1.5 flex items-center justify-between gap-3 text-xs">
                <span className="text-slate-300 truncate">
                  <span className="font-semibold text-white">{a.action}</span>
                  <span className="text-slate-500"> · {a.actor}</span>
                  {a.entityType && <span className="text-slate-600"> · {a.entityType}{a.entityId ? ` #${a.entityId}` : ''}</span>}
                </span>
                <span className="text-slate-600 whitespace-nowrap">{new Date(a.createdAt).toLocaleString()}</span>
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
      <p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className="text-sm font-bold text-white truncate" title={value}>
        {value}
      </p>
    </div>
  );
}
