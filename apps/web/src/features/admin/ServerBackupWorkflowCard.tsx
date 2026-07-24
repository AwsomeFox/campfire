/**
 * Whole-server backup & restore workflow (issue #444). Server-admin only —
 * create/download archives, inspect scheduled cadence, dry-run inspect with
 * manifest/checksums, and destructive restore with explicit confirmation plus
 * post-restore health verification. Operator identity is shown for audit context.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '../../app/auth';
import { clearApiCache } from '../../lib/swCache';
import { ApiError } from '../../lib/api';
import { Card, Btn, ErrorNote } from '../../components/ui';
import { PasswordInput } from '../../components/PasswordInput';
import { ConfirmDestructiveDialog } from '../../components/ConfirmDestructiveDialog';
import {
  RESTORE_CONFIRM_TOKEN,
  KEY_ENVELOPE_MIN_PASSPHRASE_LEN,
  downloadServerBackup,
  fetchBackupStatus,
  inspectBackupArchive,
  restoreServerBackup,
  verifyServerHealth,
  type BackupInspectResult,
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
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
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
          <dt className="text-[10px] uppercase tracking-widest text-slate-500">Format version</dt>
          <dd className="font-semibold text-white">
            {result.formatVersion}
            {result.sourceFormatVersion !== result.formatVersion && (
              <span className="text-slate-400 font-normal"> (source: {result.sourceFormatVersion})</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-slate-500">App version</dt>
          <dd className="font-semibold text-white">{result.appVersion ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-slate-500">Schema version</dt>
          <dd className="font-semibold text-white">
            {result.schemaVersion === null ? '—' : result.schemaVersion.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-slate-500">Created</dt>
          <dd className="font-semibold text-white">{formatTimestamp(result.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-slate-500">Database entry</dt>
          <dd className="font-semibold text-white truncate" title={result.dbEntry ?? undefined}>
            {result.dbEntry ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-widest text-slate-500">Database size</dt>
          <dd className="font-semibold text-white">
            {result.dbBytes === null ? '—' : formatBytes(result.dbBytes)}
          </dd>
        </div>
        {result.aiKeySource && (
          <div className="sm:col-span-2">
            <dt className="text-[10px] uppercase tracking-widest text-slate-500">AI credential key</dt>
            <dd className="font-semibold text-white">
              {result.aiKeySource}
              {result.aiKeyIncluded ? ' · encrypted envelope included' : ''}
              {result.aiCredentialCount !== null
                ? ` · ${result.aiCredentialCount.toLocaleString()} stored credential(s)`
                : ''}
            </dd>
          </div>
        )}
      </dl>

      {result.reconciliation && (
        <div className="text-xs space-y-1">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Reconciliation</p>
          <p className={result.reconciliation.clean ? 'text-emerald-400' : 'text-amber-400'}>
            {result.reconciliation.clean
              ? 'Archive is fully reconciled — DB snapshot matches captured files.'
              : `Archive has reconciliation issues — missing ${result.reconciliation.missing}, changed ${result.reconciliation.changed}, orphans ${result.reconciliation.orphanCount}. Review before restoring.`}
          </p>
          <p className="text-slate-500 font-mono text-[11px]">generation {result.reconciliation.generation}</p>
        </div>
      )}

      <div>
        <p id={uploadsId} className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">
          Upload contents ({result.uploads.length.toLocaleString()}
          {result.uploadCount !== null ? ` · manifest count ${result.uploadCount.toLocaleString()}` : ''})
        </p>
        {result.uploads.length === 0 ? (
          <p className="text-xs text-slate-500">No upload files in this archive.</p>
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
          <p id={checksumsId} className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">
            Attachment checksums ({result.attachmentChecksums.length.toLocaleString()})
          </p>
          <ul
            className="max-h-40 overflow-y-auto text-[11px] text-slate-300 font-mono divide-y divide-slate-800 border border-slate-800 rounded"
            aria-labelledby={checksumsId}
          >
            {result.attachmentChecksums.map((entry) => (
              <li key={entry.path} className="px-2 py-1" title={entry.sha256}>
                <span className="truncate block">{entry.path}</span>
                <span className="text-slate-500">
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
  const { me, refresh } = useAuth();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [downloadPassphrase, setDownloadPassphrase] = useState('');
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);
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
      setStatusError(err instanceof ApiError ? err.message : "Couldn't load backup status.");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  function cancelDownload() {
    downloadAbortRef.current?.abort();
    downloadAbortRef.current = null;
    setDownloadBusy(false);
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
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    try {
      const result = await downloadServerBackup({
        keyPassphrase: passphrase || undefined,
        signal: controller.signal,
      });
      setDownloadNote(`Downloaded ${result.filename} (${formatBytes(result.bytes)}).`);
    } catch (err) {
      if (controller.signal.aborted) {
        setDownloadNote('Download cancelled.');
      } else {
        setDownloadError(err instanceof ApiError ? err.message : "Couldn't create the backup.");
      }
    } finally {
      downloadAbortRef.current = null;
      setDownloadBusy(false);
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
        setInspectError(err instanceof ApiError ? err.message : "Couldn't inspect that archive.");
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
        setRestoreError(err instanceof ApiError ? err.message : "Couldn't restore that archive.");
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
        <p className="text-[11px] text-slate-500">
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
          <Btn
            type="button"
            className="!min-h-0 !py-2 text-xs sm:w-auto"
            onClick={() => void runDownload()}
            busy={downloadBusy}
            disabled={downloadBusy}
          >
            {downloadBusy ? 'Creating backup…' : 'Create & download backup'}
          </Btn>
          {downloadBusy && (
            <Btn ghost type="button" className="!min-h-0 !py-2 text-xs sm:w-auto" onClick={cancelDownload}>
              Cancel
            </Btn>
          )}
        </div>
        {downloadError && <ErrorNote message={downloadError} onRetry={() => void runDownload()} />}
        {downloadNote && <p className="text-xs text-emerald-400">{downloadNote}</p>}
      </section>

      <section className="space-y-3" aria-labelledby="server-backup-schedule-heading">
        <div className="flex items-center justify-between gap-2">
          <h3 id="server-backup-schedule-heading" className="text-xs font-bold text-white uppercase tracking-widest">
            Scheduled backups
          </h3>
          <button type="button" className="text-[11px] text-slate-500 hover:text-white" onClick={() => void loadStatus()}>
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
                  <dt className="text-[10px] uppercase tracking-widest text-slate-500">Last success</dt>
                  <dd className="font-semibold text-white">{formatTimestamp(status.cadence.lastSuccessAt)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-widest text-slate-500">Next run</dt>
                  <dd className="font-semibold text-white">{formatTimestamp(status.cadence.nextRunAt)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-widest text-slate-500">Last archive size</dt>
                  <dd className="font-semibold text-white">
                    {status.cadence.lastSize === null ? '—' : formatBytes(status.cadence.lastSize)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-widest text-slate-500">Last checksum</dt>
                  <dd className="font-semibold text-white font-mono truncate" title={status.cadence.lastChecksum ?? undefined}>
                    {status.cadence.lastChecksum ? `${status.cadence.lastChecksum.slice(0, 16)}…` : '—'}
                  </dd>
                </div>
              </dl>
            )}
            {status.cadence?.lastError && (
              <p className="text-rose-400">Last scheduled run failed: {status.cadence.lastError}</p>
            )}
            {status.onDisk.length > 0 && (
              <div>
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">
                  On-disk archives (copy off-box for retention)
                </p>
                <ul className="divide-y divide-slate-800 border border-slate-800 rounded text-[11px] font-mono">
                  {status.onDisk.map((entry) => (
                    <li key={entry.name} className="px-2 py-1 flex justify-between gap-2">
                      <span className="truncate text-slate-300" title={entry.name}>
                        {entry.name}
                      </span>
                      <span className="text-slate-500 whitespace-nowrap">
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
          <Btn
            ghost
            type="button"
            className="!min-h-0 !py-2 text-xs sm:w-auto"
            onClick={() => fileInputRef.current?.click()}
            aria-controls={fileInputId}
          >
            Choose archive…
          </Btn>
          <Btn
            type="button"
            className="!min-h-0 !py-2 text-xs sm:w-auto"
            onClick={() => void runInspect()}
            disabled={inspectBusy || !pendingFile}
            busy={inspectBusy}
          >
            {inspectBusy ? 'Inspecting…' : 'Inspect (dry-run)'}
          </Btn>
          {inspectBusy && (
            <Btn ghost type="button" className="!min-h-0 !py-2 text-xs sm:w-auto" onClick={cancelInspect}>
              Cancel
            </Btn>
          )}
          <Btn
            danger
            type="button"
            className="!min-h-0 !py-2 text-xs sm:w-auto"
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
              {formatBytes(restoreResult.dbBytes)}, {restoreResult.uploadCount.toLocaleString()} upload(s).
            </p>
            {healthResult && (
              <p className={healthResult.ready ? 'text-slate-300' : 'text-amber-400'}>
                Post-restore health: liveness {healthResult.live ? 'ok' : 'failed'}, readiness{' '}
                {healthResult.ready ? 'ok' : 'failed'}
                {healthResult.version ? ` (v${healthResult.version})` : ''}.
              </p>
            )}
            <p className="text-slate-500">
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
