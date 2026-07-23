/**
 * Admin storage management card (issue #24). Server-admin only — sits in the
 * /admin console. Reads GET /admin/storage (upload-size visibility), lets the
 * admin set/clear a per-campaign quota (PUT .../quota), and runs orphan cleanup
 * (POST .../cleanup, with a dry-run preview first). Byte figures come from
 * attachment metadata plus a walk of the uploads dir.
 */
import { useCallback, useEffect, useState } from 'react';
import type { StorageStats, StorageCleanupResult } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Btn, TextInput, Skeleton, ErrorNote } from '../../components/ui';

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

// Parse a human quota input ("50", "50MB", "1.5 GB") to bytes, or null to clear.
function parseQuota(input: string): number | null | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return null; // empty = clear
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i.exec(trimmed);
  if (!m) return undefined; // invalid
  const value = parseFloat(m[1]);
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[(m[2] ?? 'mb').toLowerCase()]!;
  return Math.round(value * mult);
}

export function StorageCard() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<StorageCleanupResult | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function retryFsCleanup() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${API}/admin/storage/fs-cleanup/retry`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't retry filesystem cleanup.");
    } finally {
      setBusy(false);
    }
  }

  async function runCleanup(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<StorageCleanupResult>(`${API}/admin/storage/cleanup${dryRun ? '?dryRun=true' : ''}`);
      setCleanup(res);
      if (!dryRun) await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't run cleanup.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !stats) {
    return (
      <Card>
        <ErrorNote message={error} onRetry={load} />
      </Card>
    );
  }

  if (!stats) {
    return (
      <Card>
        <Skeleton lines={4} />
      </Card>
    );
  }

  const orphanCount = stats.orphans.rowsWithoutFile + stats.orphans.filesWithoutRow;
  const fsPending = stats.fsCleanup.pendingCount + stats.fsCleanup.failedCount;

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">Storage</h2>
        <button type="button" className="text-[11px] text-slate-500 hover:text-white" onClick={() => void load()}>
          refresh
        </button>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      {/* Top-line usage */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Stat label="Committed" value={formatBytes(stats.committedBytes)} />
        <Stat label="Reserved" value={formatBytes(stats.reservedBytes)} />
        <Stat label="On disk" value={formatBytes(stats.diskBytes)} />
        <Stat label="Committed files" value={stats.fileCount.toLocaleString()} />
        <Stat label="Orphans" value={orphanCount.toLocaleString()} />
      </div>

      {/* Per-campaign usage + quotas */}
      <div>
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Per-campaign usage</p>
        {stats.campaigns.length === 0 ? (
          <p className="text-xs text-slate-500">No campaigns yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase text-slate-500 text-left">
                  <th className="py-2 pr-4 font-bold">Campaign</th>
                  <th className="pr-4 font-bold">Files</th>
                  <th className="pr-4 font-bold">Committed</th>
                  <th className="pr-4 font-bold">Reserved</th>
                  <th className="pr-4 font-bold">Quota</th>
                  <th></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {stats.campaigns.map((c) => (
                  <QuotaRow key={c.campaignId} campaign={c} onChange={load} onError={setError} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Filesystem deletion queue (issue #727) */}
      <div id="fs-cleanup" className="cf-inset p-3.5 space-y-2">
        <p className="text-[10px] font-bold text-rose-400 uppercase tracking-widest">Pending file erasure</p>
        <p className="text-[11px] text-slate-500">
          Paths whose database metadata was removed but bytes could not be verified erased (
          {stats.fsCleanup.pendingCount} retrying, {stats.fsCleanup.failedCount} need attention).
        </p>
        {stats.fsCleanup.items.length > 0 && (
          <ul className="text-[11px] text-slate-300 space-y-1 max-h-40 overflow-y-auto">
            {stats.fsCleanup.items.map((item) => (
              <li key={item.id}>
                <span className="font-mono text-slate-400">{item.relPath}</span>
                {item.status === 'held' && (
                  <span className="text-amber-400"> — held until metadata deletion commits</span>
                )}
                {item.status === 'failed' && (
                  <span className="text-rose-400"> — {item.lastError || 'failed'}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {stats.fsCleanup.queueCount > stats.fsCleanup.items.length && (
          <p className="text-[10px] text-slate-500 m-0">
            Showing {stats.fsCleanup.items.length} of {stats.fsCleanup.queueCount} queued paths (oldest first).
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => void retryFsCleanup()} disabled={busy || fsPending === 0}>
            {busy ? 'Working…' : 'Retry cleanup'}
          </Btn>
        </div>
      </div>

      {/* Orphan cleanup */}
      <div className="cf-inset p-3.5 space-y-2">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Orphan cleanup</p>
        <p className="text-[11px] text-slate-500">
          Removes attachment rows whose file is missing on disk ({stats.orphans.rowsWithoutFile}) and upload files with no
          backing row ({stats.orphans.filesWithoutRow}, {formatBytes(stats.orphans.orphanBytes)}). Preview first, then clean.
        </p>
        {cleanup && (
          <p className="text-[11px] text-slate-300">
            {cleanup.dryRun ? 'Preview: ' : 'Cleaned: '}
            {cleanup.dryRun
              ? `${cleanup.rowsWithoutFile} row(s), ${cleanup.filesWithoutRow} file(s) would be removed.`
              : `${cleanup.rowsDeleted} row(s), ${cleanup.filesDeleted} file(s) removed · ${formatBytes(cleanup.bytesReclaimed)} reclaimed.`}
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => runCleanup(true)} disabled={busy}>
            Preview
          </Btn>
          <Btn
            className="!min-h-0 !py-1.5 text-xs"
            onClick={() => runCleanup(false)}
            disabled={busy || orphanCount === 0}
          >
            {busy ? 'Working…' : 'Clean up'}
          </Btn>
        </div>
      </div>
    </Card>
  );
}

function QuotaRow({
  campaign,
  onChange,
  onError,
}: {
  campaign: StorageStats['campaigns'][number];
  onChange: () => void;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setInput(campaign.quotaBytes === null ? '' : String(Math.round(campaign.quotaBytes / 1024 ** 2)));
    setEditing(true);
  }

  async function save() {
    const parsed = parseQuota(input);
    if (parsed === undefined) {
      onError('Invalid quota — use e.g. 50, 50MB, or 1.5GB (blank to clear).');
      return;
    }
    setSaving(true);
    onError(null);
    try {
      await api.put(`${API}/admin/storage/campaigns/${campaign.campaignId}/quota`, { quotaBytes: parsed });
      setEditing(false);
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't set quota.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr>
      <td className="py-2 pr-4 font-semibold text-white">
        {campaign.name}
        {campaign.overQuota && <span className="cf-chip cf-chip-failed ml-2 !py-0 !text-[9px]">over</span>}
      </td>
      <td className="pr-4 text-slate-400">
        {campaign.fileCount.toLocaleString()}
        {campaign.reservedFileCount > 0 && (
          <span className="text-amber-400"> +{campaign.reservedFileCount.toLocaleString()}</span>
        )}
      </td>
      <td className="pr-4 text-slate-300">{formatBytes(campaign.committedBytes)}</td>
      <td className="pr-4 text-amber-400">{formatBytes(campaign.reservedBytes)}</td>
      <td className="pr-4 text-slate-400">
        {editing ? (
          <div className="flex items-center gap-1">
            <TextInput
              className="!min-h-0 !py-1 text-xs w-24"
              placeholder="e.g. 50MB"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </div>
        ) : campaign.quotaBytes === null ? (
          <span className="text-slate-600">none</span>
        ) : (
          formatBytes(campaign.quotaBytes)
        )}
      </td>
      <td className="text-right whitespace-nowrap">
        {editing ? (
          <>
            <button type="button" className="text-[11px] text-emerald-400 hover:text-emerald-300 mr-3" onClick={save} disabled={saving}>
              save
            </button>
            <button type="button" className="text-[11px] text-slate-500 hover:text-white" onClick={() => setEditing(false)}>
              cancel
            </button>
          </>
        ) : (
          <button type="button" className="text-[11px] text-slate-500 hover:text-white" onClick={startEdit}>
            set quota
          </button>
        )}
      </td>
    </tr>
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
