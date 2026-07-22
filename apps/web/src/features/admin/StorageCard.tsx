/**
 * Admin storage management card (issue #24). Server-admin only — sits in the
 * /admin console. Reads GET /admin/storage (upload-size visibility), lets the
 * admin set/clear a per-campaign quota (PUT .../quota), and runs orphan cleanup
 * (POST .../cleanup, with a dry-run preview first). Byte figures come from
 * attachment metadata plus a walk of the uploads dir.
 *
 * Issue #703 — cleanup is destructive, so the preview is BINDING: the Clean up
 * button stays disabled until a successful dry-run, and at execute time we
 * re-run a dry-run and compare its signature to the bound preview. If the
 * orphan set changed between preview and execute (someone uploaded/deleted in
 * another tab, or a volume blipped), we refuse and tell the admin to re-preview
 * — a stale preview must never drive the eventual delete set. The server's
 * cleanup endpoint issues no preview token, so the binding is client-side: a
 * hash of the dry-run's found counts plus the stats snapshot that accompanied
 * the preview (file count + on-disk bytes) to also catch wider drift.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StorageStats, StorageCleanupResult } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, Btn, TextInput, Skeleton, ErrorNote } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';

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

/**
 * The bound preview fingerprint (issue #703). The server's cleanup endpoint
 * issues no preview token and deletes whatever it finds as an orphan at execute
 * time, so we bind client-side: this signature captures the orphan counts the
 * dry-run reported PLUS the storage snapshot that accompanied the preview (total
 * attachment rows + on-disk bytes). Any of those changing between preview and
 * execute means the deletion set may have moved, so we refuse and re-preview.
 */
interface PreviewBinding {
  /** Stable fingerprint of the previewed deletion set + storage snapshot. */
  signature: string;
  /** Counts shown to the admin when they accepted the preview. */
  rowsWithoutFile: number;
  filesWithoutRow: number;
  /** Reclaimable bytes reported alongside the preview (from stats.orphans). */
  orphanBytes: number;
}

/** Build the fingerprint that binds a preview to a later execution. */
export function previewSignature(
  dry: Pick<StorageCleanupResult, 'rowsWithoutFile' | 'filesWithoutRow'>,
  stats: Pick<StorageStats, 'fileCount' | 'diskBytes'>,
): string {
  return `r=${dry.rowsWithoutFile}:f=${dry.filesWithoutRow}:fc=${stats.fileCount}:db=${stats.diskBytes}`;
}

/**
 * Result of a real (non-dry) cleanup, decorated with partial-failure detection
 * (issue #703). The server tolerates per-file unlink failures silently (a file
 * we couldn't remove stays an orphan for next run), so a "successful" 201 can
 * still have deleted fewer items than it found. We surface that explicitly
 * rather than reporting clean success.
 */
interface CleanupOutcome {
  result: StorageCleanupResult;
  /** Items the run found but could not remove (>= 0). */
  rowFailures: number;
  fileFailures: number;
}

/** Turn a real cleanup result into a decorated outcome with failure deltas. */
export function outcomeOf(result: StorageCleanupResult): CleanupOutcome {
  return {
    result,
    rowFailures: Math.max(0, result.rowsWithoutFile - result.rowsDeleted),
    fileFailures: Math.max(0, result.filesWithoutRow - result.filesDeleted),
  };
}

/** Build a downloadable audit blob for a cleanup outcome (issue #703). */
function downloadOutcome(outcome: CleanupOutcome): void {
  const payload = {
    kind: 'campfire.storage.cleanup',
    at: new Date().toISOString(),
    dryRun: outcome.result.dryRun,
    rowsWithoutFile: outcome.result.rowsWithoutFile,
    filesWithoutRow: outcome.result.filesWithoutRow,
    rowsDeleted: outcome.result.rowsDeleted,
    filesDeleted: outcome.result.filesDeleted,
    bytesReclaimed: outcome.result.bytesReclaimed,
    rowFailures: outcome.rowFailures,
    fileFailures: outcome.fileFailures,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `storage-cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function StorageCard() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [binding, setBinding] = useState<PreviewBinding | null>(null);
  const [outcome, setOutcome] = useState<CleanupOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  /** Open confirm dialog + the freshly-revalidated dry-run it shows (issue #703). */
  const [confirming, setConfirming] = useState(false);
  const [confirmDry, setConfirmDry] = useState<StorageCleanupResult | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // Any storage mutation invalidates the bound preview (issue #703): a stale
  // preview must not drive a later delete. This ref lets load() clear the
  // binding without racing against an in-flight preview.
  const previewGeneration = useRef(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStats(await api.get<StorageStats>(`${API}/admin/storage`));
      // Stats are the source of truth for "did storage change since preview?"
      // — a fresh load means the bound preview is stale, so drop it.
      previewGeneration.current += 1;
      setBinding(null);
      setOutcome(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load storage stats.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Run a dry-run preview and BIND it (issue #703). The binding captures the
   * orphan counts the admin accepted plus the storage snapshot at preview time;
   * the eventual execution must match it or be refused.
   */
  async function runPreview() {
    setBusy(true);
    setError(null);
    setOutcome(null);
    const generation = ++previewGeneration.current;
    try {
      const res = await api.post<StorageCleanupResult>(`${API}/admin/storage/cleanup?dryRun=true`);
      if (generation !== previewGeneration.current) return; // superseded by a newer load
      const snap = await api.get<StorageStats>(`${API}/admin/storage`);
      if (generation !== previewGeneration.current) return;
      setStats(snap);
      setBinding({
        signature: previewSignature(res, snap),
        rowsWithoutFile: res.rowsWithoutFile,
        filesWithoutRow: res.filesWithoutRow,
        orphanBytes: snap.orphans.orphanBytes,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't run preview.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Open the confirm step (issue #703). Re-runs a dry-run AND refreshes the
   * storage snapshot so the dialog shows the ACTUAL counts that will be affected
   * at execution time, not the preview-time counts — then the eventual execute
   * compares this fresh signature to the bound preview's. If the orphan set (or
   * the wider storage state) moved between preview and confirm, the dialog shows
   * a "changed set" notice and the confirm button is disabled until the admin
   * re-previews.
   */
  async function openConfirm() {
    if (!binding) return;
    setConfirming(true);
    setConfirmError(null);
    setConfirmDry(null);
    setBusy(true);
    try {
      const fresh = await api.post<StorageCleanupResult>(`${API}/admin/storage/cleanup?dryRun=true`);
      const snap = await api.get<StorageStats>(`${API}/admin/storage`);
      setConfirmDry(fresh);
      setStats(snap);
    } catch (err) {
      setConfirmError(err instanceof ApiError ? err.message : "Couldn't re-check the orphan set.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Execute the destructive cleanup — only after the confirm dialog's fresh
   * dry-run matches the bound preview's signature (issue #703).
   */
  async function executeCleanup() {
    const bound = binding;
    const fresh = confirmDry;
    if (!bound || !fresh) return;
    const statsSnapshot = stats;
    if (!statsSnapshot) return;

    if (previewSignature(fresh, statsSnapshot) !== bound.signature) {
      setConfirmError(
        'The orphan set changed since the preview (uploads or deletions happened in between). ' +
          'Close this and run Preview again to bind the current set.',
      );
      return;
    }

    setBusy(true);
    setConfirmError(null);
    try {
      const res = await api.post<StorageCleanupResult>(`${API}/admin/storage/cleanup`);
      const oc = outcomeOf(res);
      setOutcome(oc);
      // A successful execution consumes the preview — drop it so a subsequent
      // run can't reuse a stale binding. load() also refreshes stats.
      setBinding(null);
      setConfirming(false);
      setConfirmDry(null);
      await load();
    } catch (err) {
      setConfirmError(err instanceof ApiError ? err.message : "Couldn't run cleanup.");
    } finally {
      setBusy(false);
    }
  }

  function cancelConfirm() {
    if (busy) return;
    setConfirming(false);
    setConfirmDry(null);
    setConfirmError(null);
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Upload total" value={formatBytes(stats.totalBytes)} />
        <Stat label="On disk" value={formatBytes(stats.diskBytes)} />
        <Stat label="Files" value={stats.fileCount.toLocaleString()} />
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
                  <th className="pr-4 font-bold">Used</th>
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

      {/* Orphan cleanup — preview-first and binding (issue #703) */}
      <div className="cf-inset p-3.5 space-y-2">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Orphan cleanup</p>
        <p className="text-[11px] text-slate-500">
          Removes attachment rows whose file is missing on disk ({stats.orphans.rowsWithoutFile}) and upload files with no
          backing row ({stats.orphans.filesWithoutRow}, {formatBytes(stats.orphans.orphanBytes)}). Preview first, then clean.
        </p>

        {/* Bound-preview summary — what the admin accepted. */}
        {binding && (
          <p className="text-[11px] text-slate-300" data-testid="storage-preview-bound">
            Bound preview: {binding.rowsWithoutFile} row(s), {binding.filesWithoutRow} file(s),{' '}
            {formatBytes(binding.orphanBytes)} would be removed. Re-validates at clean time.
          </p>
        )}
        {!binding && (
          <p className="text-[11px] text-slate-500" data-testid="storage-preview-none">
            No preview yet — Clean up stays disabled until you run a successful preview.
          </p>
        )}

        {/* Last execution outcome — success or partial failure (issue #703). */}
        {outcome && (
          <CleanupOutcomeBanner outcome={outcome} onDownload={() => downloadOutcome(outcome)} />
        )}

        <div className="flex gap-2 justify-end">
          <Btn
            ghost
            className="!min-h-0 !py-1.5 text-xs"
            onClick={() => void runPreview()}
            disabled={busy || confirming}
          >
            {busy && !confirming ? 'Working…' : binding ? 'Re-preview' : 'Preview'}
          </Btn>
          <Btn
            className="!min-h-0 !py-1.5 text-xs"
            onClick={() => void openConfirm()}
            disabled={busy || !binding}
            aria-disabled={busy || !binding}
            title={!binding ? 'Run a preview first' : undefined}
          >
            Clean up
          </Btn>
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Clean up storage orphans?"
          confirmLabel="Delete orphans"
          cancelLabel="Cancel"
          busy={busy}
          confirmDisabled={!confirmDry || !binding || confirmError !== null}
          onCancel={cancelConfirm}
          onConfirm={() => void executeCleanup()}
          body={<ConfirmBody binding={binding} fresh={confirmDry} error={confirmError} />}
        />
      )}
    </Card>
  );
}

/** The confirm dialog body: the actual counts at execution time + drift notice. */
function ConfirmBody({
  binding,
  fresh,
  error,
}: {
  binding: PreviewBinding | null;
  fresh: StorageCleanupResult | null;
  error: string | null;
}) {
  if (error) {
    return <p className="text-xs text-rose-400">{error}</p>;
  }
  if (!fresh) {
    return <p className="text-xs text-slate-400">Re-checking the orphan set…</p>;
  }
  const drifted =
    binding !== null &&
    (fresh.rowsWithoutFile !== binding.rowsWithoutFile || fresh.filesWithoutRow !== binding.filesWithoutRow);
  const orphanBytes = drifted ? 0 : binding?.orphanBytes ?? 0;
  return (
    <div className="space-y-2 text-xs text-slate-300">
      <p>This will permanently delete:</p>
      <ul className="list-disc pl-5 space-y-0.5">
        <li>
          <strong className="text-white">{fresh.rowsWithoutFile}</strong> attachment row(s) whose file is missing on disk
        </li>
        <li>
          <strong className="text-white">{fresh.filesWithoutRow}</strong> upload file(s) with no backing row (
          {formatBytes(orphanBytes)})
        </li>
      </ul>
      {drifted ? (
        <p className="text-amber-400" data-testid="storage-confirm-drift">
          The set changed since the preview — re-run Preview to bind the current counts before cleaning.
        </p>
      ) : (
        <p className="text-slate-500">Counts match the bound preview.</p>
      )}
    </div>
  );
}

/** Inline banner for the last cleanup outcome, surfacing partial failures (issue #703). */
function CleanupOutcomeBanner({ outcome, onDownload }: { outcome: CleanupOutcome; onDownload: () => void }) {
  const { result, rowFailures, fileFailures } = outcome;
  const partial = rowFailures > 0 || fileFailures > 0;
  return (
    <div
      className={`text-[11px] border rounded px-2.5 py-2 space-y-1 ${
        partial ? 'border-amber-600/60 bg-amber-900/20 text-amber-300' : 'border-emerald-700/50 bg-emerald-900/20 text-emerald-300'
      }`}
      data-testid="storage-cleanup-outcome"
      role="status"
    >
      <p>
        {partial ? 'Partial cleanup: ' : 'Cleaned: '}
        {result.rowsDeleted} row(s), {result.filesDeleted} file(s) removed · {formatBytes(result.bytesReclaimed)} reclaimed.
      </p>
      {partial && (
        <p>
          Could not remove {rowFailures > 0 ? `${rowFailures} row(s)` : ''}
          {rowFailures > 0 && fileFailures > 0 ? ' and ' : ''}
          {fileFailures > 0 ? `${fileFailures} file(s)` : ''}. They remain as orphans — check server logs and retry.
        </p>
      )}
      <button
        type="button"
        className="text-[11px] underline text-slate-400 hover:text-white"
        onClick={onDownload}
        data-testid="storage-cleanup-download"
      >
        Download result
      </button>
    </div>
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
      <td className="pr-4 text-slate-400">{campaign.fileCount}</td>
      <td className="pr-4 text-slate-300">{formatBytes(campaign.totalBytes)}</td>
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
