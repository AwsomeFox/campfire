import { useTranslation } from 'react-i18next';
/**
 * Whole-server backup & restore workflow (issue #444). Server-admin only —
 * create/download archives, inspect scheduled cadence, dry-run inspect with
 * manifest/checksums, and destructive restore with explicit confirmation plus
 * post-restore health verification. Operator identity is shown for audit context.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '../../app/auth';
import { clearApiCache } from '../../lib/swCache';
import { translateApiError } from '../../lib/api';
import { Card, Btn, ErrorNote } from '../../components/ui';
import { formatNumber, formatDateTime } from '../../lib/format';
import { PasswordInput } from '../../components/PasswordInput';
import { ConfirmDestructiveDialog } from '../../components/ConfirmDestructiveDialog';
import {
  RESTORE_CONFIRM_TOKEN,
  KEY_ENVELOPE_MIN_PASSPHRASE_LEN,
  BackupDownloadLimitError,
  downloadServerBackup,
  fetchBackupStatus,
  inspectBackupArchive,
  restoreServerBackup,
  verifyServerHealth,
  type BackupInspectResult,
  type BackupDownloadProgress,
  type BackupStatus,
  type RestoreResult,
  type ServerHealthResult,
} from './serverBackupApi';

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

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  return formatDateTime(iso);
}

function formatPolicyNumber(value: number | null, suffix = ''): string {
  return value === null ? 'disabled' : `${formatNumber(value)}${suffix}`;
}

function operatorLabel(displayName: string, username: string): string {
  const trimmed = displayName.trim();
  return trimmed.length > 0 ? `${trimmed} (@${username})` : `@${username}`;
}

function InspectResults({ result }: { result: BackupInspectResult }) {
  const uploadsId = useId();
  const checksumsId = useId();

  return (
    <div className="cf-inset p-3.5 space-y-3" role="region" aria-label="Backup inspection results">
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-secondary">Format version</dt>
          <dd className="font-semibold text-white">
            {result.formatVersion}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-secondary">App version</dt>
          <dd className="font-semibold text-white">{result.appVersion ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-secondary">Schema version</dt>
          <dd className="font-semibold text-white">
            {result.schemaVersion === null ? '—' : formatNumber(result.schemaVersion)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-secondary">Created</dt>
          <dd className="font-semibold text-white">{formatTimestamp(result.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-secondary">Database entry</dt>
          <dd className="font-semibold text-white truncate" title={result.dbEntry}>
            {result.dbEntry}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-secondary">Database size</dt>
          <dd className="font-semibold text-white">
            {formatBytes(result.dbBytes)}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[10px] uppercase tracking-widest text-secondary">AI credential key</dt>
          <dd className="font-semibold text-white">
            {result.aiKeySource}
            {result.aiKeyIncluded ? ' · encrypted envelope included' : ''}
            {result.aiCredentialCount !== null
              ? ` · ${formatNumber(result.aiCredentialCount)} stored credential(s)`
              : ''}
          </dd>
        </div>
      </dl>

      <div className="text-xs space-y-1">
        <p className="text-[10px] font-bold text-secondary uppercase tracking-widest">Reconciliation</p>
        <p className="text-emerald-400">Archive is fully reconciled — DB snapshot matches captured files.</p>
        <p className="text-secondary font-mono text-[11px]">generation {result.reconciliation.generation}</p>
      </div>

      <div>
        <p id={uploadsId} className="text-[10px] font-bold text-secondary uppercase tracking-widest mb-1">
          Upload contents ({formatNumber(result.uploads.length)} · manifest count {formatNumber(result.uploadCount)})
        </p>
        {result.uploads.length === 0 ? (
          <p className="text-xs text-secondary">No upload files in this archive.</p>
        ) : (
          <ul
            className="max-h-40 overflow-y-auto text-[11px] text-slate-300 font-mono divide-y divide-slate-800 border border-slate-800 rounded"
            aria-labelledby={uploadsId}
          >
            {result.uploads.map((uploadPath) => (
              <li key={uploadPath} className="px-2 py-1 truncate" title={uploadPath}>
                {uploadPath}
              </li>
            ))}
          </ul>
        )}
      </div>

      {result.attachmentChecksums.length > 0 && (
        <div>
          <p id={checksumsId} className="text-[10px] font-bold text-secondary uppercase tracking-widest mb-1">
            Attachment checksums ({formatNumber(result.attachmentChecksums.length)})
          </p>
          <ul
            className="max-h-40 overflow-y-auto text-[11px] text-slate-300 font-mono divide-y divide-slate-800 border border-slate-800 rounded"
            aria-labelledby={checksumsId}
          >
            {result.attachmentChecksums.map((entry) => (
              <li key={entry.path} className="px-2 py-1" title={entry.sha256}>
                <span className="truncate block">{entry.path}</span>
                <span className="text-secondary">
                  {formatBytes(entry.size)} · sha256 {entry.sha256.slice(0, 16)}…
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ServerBackupWorkflowCard() {
  const { t } = useTranslation();
  const { me, refresh } = useAuth();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [downloadPassphrase, setDownloadPassphrase] = useState('');
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);
  const [downloadPhase, setDownloadPhase] = useState<'preparing' | 'streaming' | 'finalizing' | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<BackupDownloadProgress | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);

  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspectResult, setInspectResult] = useState<BackupInspectResult | null>(null);
  const inspectAbortRef = useRef<AbortController | null>(null);

  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [healthResult, setHealthResult] = useState<ServerHealthResult | null>(null);
  const restoreAbortRef = useRef<AbortController | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      setStatus(await fetchBackupStatus());
    } catch (err) {
      setStatus(null);
      setStatusError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    }
  }, [t]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  function cancelDownload() {
    const controller = downloadAbortRef.current;
    if (!controller) return;
    if (!window.confirm('Cancel this backup download? Any partially written file will be cleaned up when the browser supports it.')) {
      return;
    }
    controller.abort();
    if (downloadAbortRef.current === controller) downloadAbortRef.current = null;
    setDownloadNote('Cancelling download…');
  }

  async function runDownload() {
    const passphrase = downloadPassphrase.trim();
    if (passphrase && passphrase.length < KEY_ENVELOPE_MIN_PASSPHRASE_LEN) {
      setDownloadError(`Passphrase must be at least ${KEY_ENVELOPE_MIN_PASSPHRASE_LEN} characters.`);
      return;
    }
    setDownloadBusy(true);
    setDownloadError(null);
    setDownloadNote(null);
    setDownloadPhase('preparing');
    setDownloadProgress(null);
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    try {
      const result = await downloadServerBackup({
        keyPassphrase: passphrase || undefined,
        signal: controller.signal,
        onProgress: (progress) => {
          setDownloadProgress(progress);
        },
        onPhase: setDownloadPhase,
      });
      setDownloadNote(
        result.destination === 'file-system-access'
          ? `Saved ${result.filename} (${formatBytes(result.bytes)}) directly to the selected file.`
          : `Downloaded ${result.filename} (${formatBytes(result.bytes)}). This browser buffered the archive in memory because direct file streaming is unavailable.`,
      );
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        setDownloadNote('Download cancelled.');
      } else {
        setDownloadError(
          err instanceof BackupDownloadLimitError
            ? err.message
            : translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }),
        );
      }
    } finally {
      downloadAbortRef.current = null;
      setDownloadBusy(false);
      setDownloadPhase(null);
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = '';
    setPendingFile(file);
    setFileName(file?.name ?? null);
    setInspectResult(null);
    setInspectError(null);
    setRestoreResult(null);
    setHealthResult(null);
    setRestoreError(null);
  }

  function cancelInspect() {
    inspectAbortRef.current?.abort();
    inspectAbortRef.current = null;
    setInspectBusy(false);
  }

  async function runInspect() {
    if (!pendingFile) {
      setInspectError('Choose a Campfire server backup (.zip) first.');
      return;
    }
    setInspectBusy(true);
    setInspectError(null);
    setInspectResult(null);
    const controller = new AbortController();
    inspectAbortRef.current = controller;
    try {
      setInspectResult(await inspectBackupArchive(pendingFile, controller.signal));
    } catch (err) {
      if (!controller.signal.aborted) {
        setInspectError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
      }
    } finally {
      inspectAbortRef.current = null;
      setInspectBusy(false);
    }
  }

  function cancelRestore() {
    restoreAbortRef.current?.abort();
    restoreAbortRef.current = null;
    setRestoreBusy(false);
  }

  async function runRestore() {
    if (!pendingFile) return;
    const passphrase = restorePassphrase.trim();
    if (inspectResult?.aiKeyIncluded && !passphrase) {
      setRestoreError('This archive includes an encrypted AI keyfile — enter the passphrase used when the backup was created.');
      return;
    }
    if (passphrase && passphrase.length < KEY_ENVELOPE_MIN_PASSPHRASE_LEN) {
      setRestoreError(`Passphrase must be at least ${KEY_ENVELOPE_MIN_PASSPHRASE_LEN} characters.`);
      return;
    }
    setRestoreBusy(true);
    setRestoreError(null);
    setRestoreResult(null);
    setHealthResult(null);
    const controller = new AbortController();
    restoreAbortRef.current = controller;
    let result: RestoreResult;
    try {
      result = await restoreServerBackup({
        file: pendingFile,
        keyPassphrase: passphrase || undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        setRestoreError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
      }
      restoreAbortRef.current = null;
      setRestoreBusy(false);
      return;
    }
    restoreAbortRef.current = null;
    setRestoreBusy(false);
    setRestoreResult(result);
    setRestoreDialogOpen(false);
    try {
      await clearApiCache();
      await refresh();
      setHealthResult(await verifyServerHealth());
      await loadStatus();
    } catch {
      // Post-restore refresh failed after a successful restore — don't report as restore failure.
    }
  }

  const operator = me ? operatorLabel(me.user.displayName, me.user.username) : 'unknown operator';
  const restoreNeedsPassphrase = inspectResult?.aiKeyIncluded === true;
  const restorePassphraseOk =
    !restoreNeedsPassphrase ||
    restorePassphrase.trim().length >= KEY_ENVELOPE_MIN_PASSPHRASE_LEN;
  const canRestore = Boolean(
    pendingFile && inspectResult && !inspectBusy && !restoreBusy && restorePassphraseOk,
  );

  return (
    <Card className="server-backup-workflow-card space-y-5">
      <div className="space-y-1 border-b border-slate-700 pb-2">
        <h2 className="font-bold text-white text-sm">Whole-server backup &amp; restore</h2>
        <p className="text-xs text-slate-400">
          Disaster recovery for the entire Campfire install — database and uploads. Actions are audited as server-admin
          operations.
        </p>
        <p className="text-[11px] text-secondary">
          Acting as <span className="text-slate-300">{operator}</span>
        </p>
      </div>

      <section className="space-y-3" aria-labelledby="server-backup-create-heading">
        <h3 id="server-backup-create-heading" className="text-xs font-bold text-white uppercase tracking-widest">
          Create backup
        </h3>
        <p className="text-xs text-slate-400">
          Download a WAL-safe archive of the live database and every upload. Optional passphrase wraps the AI credential
          keyfile in an encrypted envelope for portable restores — passphrases are never logged.
        </p>
        <p className="text-[11px] text-secondary">
          Where supported, the archive streams directly to the file you choose. Other browsers buffer a bounded archive in
          browser memory (up to 512 MiB); use a File System Access browser or <code>curl</code> for larger exports.
        </p>
        <label className="block text-xs font-semibold text-slate-300" htmlFor="server-backup-download-passphrase">
          Key envelope passphrase (optional)
        </label>
        <PasswordInput
          id="server-backup-download-passphrase"
          className="cf-input text-sm"
          value={downloadPassphrase}
          onChange={(e) => setDownloadPassphrase(e.target.value)}
          autoComplete="new-password"
          disabled={downloadBusy}
          revealNoun="passphrase"
          placeholder={`≥ ${KEY_ENVELOPE_MIN_PASSPHRASE_LEN} characters when set`}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Btn density="xs"
            type="button"
            className="text-xs sm:w-auto"
            onClick={() => void runDownload()}
            busy={downloadBusy}
            disabled={downloadBusy}
          >
            {downloadBusy ? 'Creating backup…' : 'Create & download backup'}
          </Btn>
          {downloadBusy && (
            <Btn density="xs" ghost type="button" className="text-xs sm:w-auto" onClick={cancelDownload}>
              Cancel
            </Btn>
          )}
        </div>
        {downloadBusy && (
          <div className="space-y-1" role="status" aria-live="polite">
            <p className="text-xs text-slate-300">
              {downloadPhase === 'preparing' && 'Preparing backup and choosing a destination…'}
              {downloadPhase === 'streaming' &&
                (downloadProgress === null || downloadProgress.receivedBytes === 0
                  ? 'Streaming backup…'
                  : downloadProgress.totalBytes === null
                  ? `Streaming backup — ${formatBytes(downloadProgress.receivedBytes)} received.`
                  : `Streaming backup — ${formatBytes(downloadProgress.receivedBytes)} of ${formatBytes(downloadProgress.totalBytes)}.`)}
              {downloadPhase === 'finalizing' && 'Finalizing saved archive…'}
            </p>
            {downloadPhase === 'streaming' && (
              <progress
                className="w-full"
                aria-label="Backup download progress"
                {...(downloadProgress?.totalBytes !== null && downloadProgress?.totalBytes !== undefined
                  ? { value: downloadProgress?.receivedBytes ?? 0, max: downloadProgress.totalBytes }
                  : {})}
              />
            )}
          </div>
        )}
        {downloadError && <ErrorNote message={downloadError} onRetry={() => void runDownload()} />}
        {downloadNote && <p className="text-xs text-emerald-400">{downloadNote}</p>}
      </section>

      <section className="space-y-3" aria-labelledby="server-backup-schedule-heading">
        <div className="flex items-center justify-between gap-2">
          <h3 id="server-backup-schedule-heading" className="text-xs font-bold text-white uppercase tracking-widest">
            Scheduled backups
          </h3>
          <button type="button" className="text-[11px] text-secondary hover:text-white" onClick={() => void loadStatus()}>
            refresh
          </button>
        </div>
        {statusError && <ErrorNote message={statusError} onRetry={() => void loadStatus()} />}
        {status && (
          <div className="cf-inset p-3 space-y-2 text-xs">
            <p className="text-slate-300">
              {status.scheduleEnabled
                ? `Enabled — every ${status.intervalHours}h to ${status.backupDir}`
                : 'Disabled — set BACKUP_SCHEDULE_ENABLED=1 on the server to enable on-disk scheduled archives.'}
            </p>
            {status.cadence && (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                <div>
                  <dt className="text-[10px] uppercase tracking-widest text-secondary">Last success</dt>
                  <dd className="font-semibold text-white">{formatTimestamp(status.cadence.lastSuccessAt)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-widest text-secondary">Next run</dt>
                  <dd className="font-semibold text-white">{formatTimestamp(status.cadence.nextRunAt)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-widest text-secondary">Last archive size</dt>
                  <dd className="font-semibold text-white">
                    {status.cadence.lastSize === null ? '—' : formatBytes(status.cadence.lastSize)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-widest text-secondary">Last checksum</dt>
                  <dd className="font-semibold text-white font-mono truncate" title={status.cadence.lastChecksum ?? undefined}>
                    {status.cadence.lastChecksum ? `${status.cadence.lastChecksum.slice(0, 16)}…` : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-widest text-secondary">Last verified archive</dt>
                  <dd className="font-semibold text-white truncate" title={status.cadence.lastArchiveName ?? undefined}>
                    {status.cadence.lastArchiveName ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-widest text-secondary">Failures / skips</dt>
                  <dd className="font-semibold text-white">
                    {formatNumber(status.cadence.consecutiveFailures ?? 0)} consecutive
                    {status.cadence.metrics
                      ? ` · ${formatNumber(status.cadence.metrics.failureCount)} total`
                      : ''}
                  </dd>
                </div>
              </dl>
            )}
            {status.disk && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-secondary">Disk free / reserve</p>
                  <p className={status.disk.lowSpace ? 'font-semibold text-amber-400' : 'font-semibold text-white'}>
                    {formatBytes(status.disk.freeBytes)} free · reserve {formatBytes(status.disk.reserveBytes)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-secondary">Next archive estimate</p>
                  <p className="font-semibold text-white">{formatBytes(status.disk.estimatedNextBytes)}</p>
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-secondary">Retention policy</p>
                <p className="font-semibold text-white">
                  keep {formatPolicyNumber(status.retention.policy.keepCount)} ·{' '}
                  {formatPolicyNumber(status.retention.policy.keepDays, 'd')} · max{' '}
                  {status.retention.policy.maxTotalBytes === null
                    ? 'disabled'
                    : formatBytes(status.retention.policy.maxTotalBytes)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest text-secondary">Retention metrics</p>
                <p className="font-semibold text-white">
                  {formatNumber(status.retention.archiveCount)} archive(s), {formatBytes(status.retention.totalBytes)} · pruned{' '}
                  {formatNumber(status.retention.pruneCount)} ({formatBytes(status.retention.prunedBytes)})
                </p>
              </div>
            </div>
            {status.retention.protectedLastGoodName && (
              <p className="text-[11px] text-secondary">
                Last-known-good protection: <span className="text-slate-300">{status.retention.protectedLastGoodName}</span>
              </p>
            )}
            {status.alerts.length > 0 && (
              <div className="space-y-1" role="alert">
                {status.alerts.map((alert, index) => (
                  <p key={`${index}:${alert}`} className="text-amber-400">
                    {alert}
                  </p>
                ))}
              </div>
            )}
            {status.onDisk.length > 0 && (
              <div>
                <p className="text-[10px] font-bold text-secondary uppercase tracking-widest mb-1">
                  On-disk archives (copy off-box for retention)
                </p>
                <ul className="divide-y divide-slate-800 border border-slate-800 rounded text-[11px] font-mono">
                  {status.onDisk.map((entry) => (
                    <li key={entry.name} className="px-2 py-1 flex justify-between gap-2">
                      <span className="truncate text-slate-300" title={entry.name}>
                        {entry.name}
                      </span>
                      <span className="text-secondary whitespace-nowrap">
                        {formatBytes(entry.bytes)} · {formatTimestamp(entry.mtime)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="server-backup-restore-heading">
        <h3 id="server-backup-restore-heading" className="text-xs font-bold text-white uppercase tracking-widest">
          Inspect &amp; restore
        </h3>
        <p className="text-xs text-slate-400">
          Upload an archive to inspect its manifest (dry-run, non-destructive). Restore replaces the live database and
          uploads — inspect first, then confirm explicitly.
        </p>

        <input
          ref={fileInputRef}
          id={fileInputId}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          className="sr-only"
          onChange={onPickFile}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Btn density="xs"
            ghost
            type="button"
            className="text-xs sm:w-auto"
            onClick={() => fileInputRef.current?.click()}
            aria-controls={fileInputId}
          >
            Choose archive…
          </Btn>
          <Btn density="xs"
            type="button"
            className="text-xs sm:w-auto"
            onClick={() => void runInspect()}
            disabled={inspectBusy || !pendingFile}
            busy={inspectBusy}
          >
            {inspectBusy ? 'Inspecting…' : 'Inspect (dry-run)'}
          </Btn>
          {inspectBusy && (
            <Btn density="xs" ghost type="button" className="text-xs sm:w-auto" onClick={cancelInspect}>
              Cancel
            </Btn>
          )}
          <Btn density="xs"
            danger
            type="button"
            className="text-xs sm:w-auto"
            disabled={!canRestore}
            onClick={() => {
              setRestoreError(null);
              setRestoreDialogOpen(true);
            }}
          >
            Restore archive…
          </Btn>
        </div>

        {fileName && (
          <p className="text-[11px] text-slate-400">
            Selected: <span className="text-slate-300">{fileName}</span>
          </p>
        )}

        {restoreNeedsPassphrase && (
          <div className="space-y-1">
            <label className="block text-xs font-semibold text-slate-300" htmlFor="server-backup-restore-passphrase">
              Restore passphrase (required for this archive)
            </label>
            <PasswordInput
              id="server-backup-restore-passphrase"
              className="cf-input text-sm"
              value={restorePassphrase}
              onChange={(e) => setRestorePassphrase(e.target.value)}
              autoComplete="new-password"
              disabled={restoreBusy}
              revealNoun="passphrase"
            />
          </div>
        )}

        {inspectError && <ErrorNote message={inspectError} onRetry={pendingFile ? () => void runInspect() : undefined} />}
        {inspectResult && <InspectResults result={inspectResult} />}
        {restoreError && !restoreDialogOpen && <ErrorNote message={restoreError} />}

        {restoreResult && (
          <div className="cf-inset p-3 space-y-2 text-xs" role="status">
            <p className="text-emerald-400 font-semibold">
              Restore completed at {formatTimestamp(restoreResult.restoredAt)} — database{' '}
              {formatBytes(restoreResult.dbBytes)}, {formatNumber(restoreResult.uploadCount)} upload(s).
            </p>
            {healthResult && (
              <p className={healthResult.ready ? 'text-slate-300' : 'text-amber-400'}>
                Post-restore health: liveness {healthResult.live ? 'ok' : 'failed'}, readiness{' '}
                {healthResult.ready ? 'ok' : 'failed'}
                {healthResult.version ? ` (v${healthResult.version})` : ''}.
              </p>
            )}
            <p className="text-secondary">
              This action is recorded in the server audit log as <code className="text-amber-400">server.restore</code>{' '}
              for {operator}.
            </p>
          </div>
        )}
      </section>

      {restoreDialogOpen && (
        <ConfirmDestructiveDialog
          title="Restore whole-server backup"
          consequence={
            <p>
              This will <strong>permanently replace</strong> the live database and every uploaded file with the contents
              of <strong>{fileName ?? 'the selected archive'}</strong>. All current server data will be lost unless you
              have a separate backup. Inspect results above describe what will be applied.
            </p>
          }
          confirmValue={RESTORE_CONFIRM_TOKEN}
          confirmLabel="Restore server"
          pendingLabel="Restoring…"
          busy={restoreBusy}
          error={restoreError}
          onConfirm={() => void runRestore()}
          onCancel={() => {
            if (!restoreBusy) {
              setRestoreDialogOpen(false);
              setRestoreError(null);
            } else {
              cancelRestore();
            }
          }}
        />
      )}
    </Card>
  );
}
