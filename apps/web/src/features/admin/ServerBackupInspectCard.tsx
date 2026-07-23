/**
 * Whole-server backup inspection (issue #514). Server-admin only — non-destructive
 * preview of manifest metadata and upload paths before restore.
 */
import { useId, useRef, useState } from 'react';
import { API, ApiError } from '../../lib/api';
import { noteUnauthorizedResponse } from '../../lib/sessionExpiry';
import { Card, Btn, ErrorNote } from '../../components/ui';

export interface BackupInspectResult {
  app: string;
  kind: string;
  formatVersion: number;
  appVersion: string | null;
  schemaVersion: number | null;
  createdAt: string | null;
  dbEntry: string | null;
  dbBytes: number | null;
  uploadCount: number | null;
  uploads: string[];
}

async function inspectBackupArchive(file: File): Promise<BackupInspectResult> {
  const form = new FormData();
  form.append('file', file);

  const headers: Record<string, string> = {};
  const devRole = localStorage.getItem('cf.devRole');
  const devUser = localStorage.getItem('cf.devUser');
  if (devRole) headers['x-dev-role'] = devRole;
  if (devUser) headers['x-dev-user'] = devUser;

  const res = await fetch(`${API}/backup/inspect`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: form,
  });
  if (!res.ok) {
    noteUnauthorizedResponse(`${API}/backup/inspect`, res.status);
    let message = res.statusText;
    try {
      const body = await res.json();
      message = Array.isArray(body.message) ? body.message.join('; ') : (body.message ?? message);
    } catch {
      /* non-json error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as BackupInspectResult;
}

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

export function ServerBackupInspectCard() {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BackupInspectResult | null>(null);

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = '';
    setPendingFile(file);
    setFileName(file?.name ?? null);
    setResult(null);
    setError(null);
  }

  async function runInspect() {
    if (!pendingFile) {
      setError('Choose a Campfire server backup (.zip) first.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await inspectBackupArchive(pendingFile));
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiError ? err.message : "Couldn't inspect that archive.");
    } finally {
      setBusy(false);
    }
  }

  const uploadsId = `${inputId}-uploads`;

  return (
    <Card className="server-backup-inspect-card space-y-3">
      <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Server backup inspection</h2>
      <p className="text-xs text-slate-400">
        Upload a whole-server backup archive to read its manifest — safe and non-destructive. Verify format version,
        app version, schema revision, creation time, and upload contents before restoring.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          className="sr-only"
          onChange={onPickFile}
        />
        <Btn
          ghost
          type="button"
          className="!min-h-0 !py-2 text-xs sm:w-auto"
          onClick={() => inputRef.current?.click()}
          aria-controls={inputId}
        >
          Choose archive…
        </Btn>
        <Btn
          type="button"
          className="!min-h-0 !py-2 text-xs sm:w-auto"
          onClick={() => void runInspect()}
          disabled={busy || !pendingFile}
          aria-disabled={busy || !pendingFile ? true : undefined}
        >
          {busy ? 'Inspecting…' : 'Inspect backup'}
        </Btn>
      </div>

      {fileName && (
        <p className="text-[11px] text-slate-400">
          Selected: <span className="text-slate-300">{fileName}</span>
        </p>
      )}

      {error && <ErrorNote message={error} onRetry={pendingFile ? () => void runInspect() : undefined} />}

      {result && (
        <div className="cf-inset p-3.5 space-y-3" role="region" aria-label="Backup inspection results">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-slate-500">Format version</dt>
              <dd className="font-semibold text-white">{result.formatVersion}</dd>
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
          </dl>

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
                {result.uploads.map((path) => (
                  <li key={path} className="px-2 py-1 truncate" title={path}>
                    {path}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
