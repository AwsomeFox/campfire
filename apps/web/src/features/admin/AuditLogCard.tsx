/**
 * Full server admin audit log — extracted from AdminPage.tsx as part of the
 * /admin/* page split (issue #350). Lives on /admin/audit. (The /admin overview
 * page shows its own top-10 recent-activity summary that links here.)
 *
 * Server-wide admin trail: account create/disable/delete, settings changes,
 * rule-pack installs, admin token mints (every audit row not tied to a
 * campaign). Read-only, newest-first, capped at 100 by the API.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AuditEntry } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Skeleton } from '../../components/ui';
import { ActorRoleBadge } from './ActorRoleBadge';

export function AuditLogCard() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setEntries(await api.get<AuditEntry[]>(`${API}/admin/audit`));
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
        <h2 className="font-bold text-white text-sm">Admin audit log</h2>
        <button type="button" className="text-[11px] text-slate-500 hover:text-white" onClick={() => void load()}>
          refresh
        </button>
      </div>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!entries ? (
        <Skeleton lines={3} />
      ) : entries.length === 0 ? (
        <p className="text-xs text-slate-500">
          No server-wide admin actions logged yet. Creating or disabling users, changing settings, and installing
          rule packs will show up here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase text-slate-500 text-left">
                <th className="py-2 pr-4 font-bold">When</th>
                <th className="pr-4 font-bold">Actor</th>
                <th className="pr-4 font-bold">Action</th>
                <th className="pr-4 font-bold">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="py-2 pr-4 whitespace-nowrap text-slate-400">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="pr-4 text-slate-300">
                    <span className="inline-flex items-center gap-1.5">
                      {e.actor}
                      {/* #526: badge the actor's attributed role so a reviewer can scan
                          for privileged server-admin actions vs ordinary campaign-DM ones. */}
                      <ActorRoleBadge role={e.actorRole} />
                    </span>
                  </td>
                  <td className="pr-4">
                    <code className="text-[11px] text-amber-400">{e.action}</code>
                  </td>
                  <td className="pr-4 text-slate-400 break-all">{e.detail || <span className="text-slate-600">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        Server-wide actions only — per-campaign history lives on each campaign. A <span style={{ color: 'rgb(252 211 77)' }}>Server admin</span> badge marks a privileged operator action; <span>DM</span> marks a campaign-DM acting here.
      </p>
    </Card>
  );
}
