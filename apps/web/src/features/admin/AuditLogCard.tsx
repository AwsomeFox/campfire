import { useTranslation } from 'react-i18next';
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
import type { AuditEntry, AuditPruneJob, AuditRetentionStatus } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { Card, Skeleton } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { ActorRoleBadge } from './ActorRoleBadge';

export function AuditLogCard() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [retention, setRetention] = useState<AuditRetentionStatus | null>(null);
  const [daysDraft, setDaysDraft] = useState('365');
  const [autoPruneDraft, setAutoPruneDraft] = useState(false);
  const [archiveDraft, setArchiveDraft] = useState(true);
  const [backupHoursDraft, setBackupHoursDraft] = useState('0');
  const [globalHoldDraft, setGlobalHoldDraft] = useState(false);
  const [campaignHoldDraft, setCampaignHoldDraft] = useState('');
  const [lastPreview, setLastPreview] = useState<AuditPruneJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [auditEntries, retentionStatus] = await Promise.all([
        api.get<AuditEntry[]>(`${API}/admin/audit`),
        api.get<AuditRetentionStatus>(`${API}/admin/audit/retention`),
      ]);
      setEntries(auditEntries);
      setRetention(retentionStatus);
      setDaysDraft(String(retentionStatus.policy.days));
      setAutoPruneDraft(retentionStatus.policy.autoPruneEnabled);
      setArchiveDraft(retentionStatus.policy.requireArchiveBeforePrune);
      setBackupHoursDraft(String(retentionStatus.policy.requireRecentBackupHours));
      setGlobalHoldDraft(retentionStatus.legalHold.global);
      setCampaignHoldDraft(retentionStatus.legalHold.campaignIds.join(', '));
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function parseNumberDraft(label: string, value: string): number | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      setError(`${label} must be a valid number.`);
      return null;
    }
    return parsed;
  }

  function parseRetentionDaysDraft(): number | null {
    const days = parseNumberDraft('Retention days', daysDraft);
    if (days === null) return null;
    if (!Number.isInteger(days)) {
      setError('Retention days must be a whole number.');
      return null;
    }
    return days;
  }

  function parseBackupHoursDraft(): number | null {
    const hours = parseNumberDraft('Recent backup hours', backupHoursDraft);
    if (hours === null) return null;
    if (!Number.isInteger(hours) || hours < 0) {
      setError('Recent backup hours must be a non-negative whole number.');
      return null;
    }
    return hours;
  }

  async function savePolicy() {
    const days = parseRetentionDaysDraft();
    if (days === null) return;
    const backupHours = parseBackupHoursDraft();
    if (backupHours === null) return;

    setBusy('policy');
    setError(null);
    try {
      await api.patch(`${API}/admin/audit/retention`, {
        days,
        autoPruneEnabled: autoPruneDraft,
        requireArchiveBeforePrune: archiveDraft,
        requireRecentBackupHours: backupHours,
      });
      await load();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.saveFailed' }));
    } finally {
      setBusy(null);
    }
  }

  async function saveLegalHold() {
    setBusy('hold');
    setError(null);
    try {
      const campaignIds = campaignHoldDraft
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      await api.put(`${API}/admin/audit/legal-hold`, { global: globalHoldDraft, campaignIds });
      await load();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.saveFailed' }));
    } finally {
      setBusy(null);
    }
  }

  async function previewPrune() {
    const retentionDays = parseRetentionDaysDraft();
    if (retentionDays === null) return;

    setBusy('preview');
    setError(null);
    try {
      const job = await api.post<AuditPruneJob>(`${API}/admin/audit/retention/preview`, {
        retentionDays,
      });
      setLastPreview(job);
      await load();
      setDaysDraft(String(job.retentionDays));
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    } finally {
      setBusy(null);
    }
  }

  async function pruneNow() {
    const retentionDays = parseRetentionDaysDraft();
    if (retentionDays === null) return;
    if (!window.confirm('Archive and permanently delete eligible audit rows? Review the dry-run counts first.')) return;
    setBusy('prune');
    setError(null);
    try {
      const job = await api.post<AuditPruneJob>(`${API}/admin/audit/retention/prune`, { confirm: true, retentionDays });
      setLastPreview(job);
      await load();
      setDaysDraft(String(job.retentionDays));
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.saveFailed' }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">Admin audit log</h2>
        <button type="button" className="text-[11px] text-secondary hover:text-white" onClick={() => void load()}>
          refresh
        </button>
      </div>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {retention ? (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 space-y-3">
          <div>
            <p className="text-xs font-bold text-amber-200 m-0">Audit retention policy</p>
            <p className="text-[11px] text-slate-300 m-0">
              Default retention is disclosed as {retention.policy.defaultDays} days. Effective policy is{' '}
              {retention.policy.days <= 0 ? 'keep forever' : `${retention.policy.days} days`} (days source:{' '}
              {retention.policy.source.days}); auto-prune is {retention.policy.autoPruneEnabled ? 'enabled' : 'off'}.
              Startup never prunes audit rows.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
            <label className="space-y-1">
              <span className="text-secondary">Retention days</span>
              <input className="cf-input w-full" value={daysDraft} onChange={(e) => setDaysDraft(e.target.value)} />
            </label>
            <label className="inline-flex items-center gap-2 pt-6">
              <input type="checkbox" checked={autoPruneDraft} onChange={(e) => setAutoPruneDraft(e.target.checked)} />
              <span>Daily auto-prune</span>
            </label>
            <label className="inline-flex items-center gap-2 pt-6">
              <input type="checkbox" checked={archiveDraft} onChange={(e) => setArchiveDraft(e.target.checked)} />
              <span>Require archive</span>
            </label>
            <label className="space-y-1">
              <span className="text-secondary">Recent backup hours</span>
              <input className="cf-input w-full" value={backupHoursDraft} onChange={(e) => setBackupHoursDraft(e.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary text-xs" disabled={busy === 'policy'} onClick={() => void savePolicy()}>
              {busy === 'policy' ? 'Saving...' : 'Save policy'}
            </button>
            <button type="button" className="btn btn-secondary text-xs" disabled={busy === 'preview'} onClick={() => void previewPrune()}>
              {busy === 'preview' ? 'Previewing...' : 'Dry-run preview'}
            </button>
            <button type="button" className="btn btn-danger text-xs" disabled={busy === 'prune'} onClick={() => void pruneNow()}>
              {busy === 'prune' ? 'Pruning...' : 'Archive & prune'}
            </button>
          </div>
          <div className="grid sm:grid-cols-[auto_1fr_auto] gap-2 items-end text-xs border-t border-slate-800 pt-3">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={globalHoldDraft} onChange={(e) => setGlobalHoldDraft(e.target.checked)} />
              <span>Global legal hold</span>
            </label>
            <label className="space-y-1">
              <span className="text-secondary">Campaign holds (IDs, comma-separated)</span>
              <input className="cf-input w-full" value={campaignHoldDraft} onChange={(e) => setCampaignHoldDraft(e.target.value)} />
            </label>
            <button type="button" className="btn btn-secondary text-xs" disabled={busy === 'hold'} onClick={() => void saveLegalHold()}>
              {busy === 'hold' ? 'Saving...' : 'Save hold'}
            </button>
          </div>
          {(lastPreview ?? retention.lastJob) ? (
            <p className="text-[11px] text-slate-300 m-0">
              Last job: {(lastPreview ?? retention.lastJob)!.mode} {(lastPreview ?? retention.lastJob)!.status}; cutoff{' '}
              {(lastPreview ?? retention.lastJob)!.cutoffIso}; eligible {(lastPreview ?? retention.lastJob)!.eligibleCount}; held{' '}
              {(lastPreview ?? retention.lastJob)!.heldCount}; deleted {(lastPreview ?? retention.lastJob)!.deletedCount}; archive{' '}
              {(lastPreview ?? retention.lastJob)!.archivedPath ?? 'none'}.
            </p>
          ) : null}
          <p className="text-[11px] text-secondary m-0">Archive directory: {retention.policy.archiveDir}</p>
        </div>
      ) : (
        <Skeleton lines={2} />
      )}
      {!entries ? (
        <Skeleton lines={3} />
      ) : entries.length === 0 ? (
        <p className="text-xs text-secondary">
          No server-wide admin actions logged yet. Creating or disabling users, changing settings, and installing
          rule packs will show up here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase text-secondary text-left">
                <th className="py-2 pr-4 font-bold">When</th>
                <th className="pr-4 font-bold">Actor</th>
                <th className="pr-4 font-bold">Action</th>
                <th className="pr-4 font-bold">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="py-2 pr-4 whitespace-nowrap text-slate-400">{formatDateTime(e.createdAt)}</td>
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
                  <td className="pr-4 text-slate-400 break-all">{e.detail || <span className="text-secondary">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-secondary">
        Server-wide actions only — per-campaign history lives on each campaign. A <span style={{ color: 'rgb(252 211 77)' }}>Server admin</span> badge marks a privileged operator action; <span>DM</span> marks a campaign-DM acting here.
      </p>
    </Card>
  );
}
