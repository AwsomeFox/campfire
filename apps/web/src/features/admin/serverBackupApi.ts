/**
 * Whole-server backup/restore API helpers (issue #444). Wraps the server-admin
 * backup endpoints with download/restore affordances the JSON client lacks.
 */
import { API, ApiError } from '../../lib/api';

export const RESTORE_CONFIRM_TOKEN = 'RESTORE';
export const KEY_ENVELOPE_MIN_PASSPHRASE_LEN = 12;

/** Persisted scheduled-backup cadence row (issue #732). */
export interface BackupCadenceState {
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  nextRunAt: string;
  lastSize: number | null;
  lastChecksum: string | null;
  lastError: string;
}

export interface BackupInspectAttachmentChecksum {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupInspectReconciliation {
  generation: string;
  totalAttachments: number;
  missing: number;
  changed: number;
  orphanCount: number;
  clean: boolean;
  orphans: string[];
}

export interface BackupInspectResult {
  app: string;
  kind: string;
  formatVersion: number;
  sourceFormatVersion: number;
  appVersion: string | null;
  schemaVersion: number | null;
  createdAt: string | null;
  dbEntry: string | null;
  dbBytes: number | null;
  uploadCount: number | null;
  uploads: string[];
  aiKeySource: 'env' | 'keyfile' | null;
  aiKeyIncluded: boolean;
  aiCredentialCount: number | null;
  attachmentChecksums: BackupInspectAttachmentChecksum[];
  reconciliation: BackupInspectReconciliation | null;
}

export interface BackupOnDiskEntry {
  name: string;
  bytes: number;
  mtime: string;
}

export interface BackupStatus {
  scheduleEnabled: boolean;
  intervalHours: number;
  backupDir: string;
  cadence: BackupCadenceState | null;
  onDisk: BackupOnDiskEntry[];
}

export interface RestoreResult {
  ok: true;
  restoredAt: string;
  dbBytes: number;
  uploadCount: number;
}

export interface ServerHealthResult {
  live: boolean;
  ready: boolean;
  version: string | null;
}

function devHeaders(): Headers {
  const headers = new Headers();
  const devRole = localStorage.getItem('cf.devRole');
  const devUser = localStorage.getItem('cf.devUser');
  if (devRole) headers.set('x-dev-role', devRole);
  if (devUser) headers.set('x-dev-user', devUser);
  return headers;
}

async function parseApiError(res: Response): Promise<ApiError> {
  let message = res.statusText;
  try {
    const body = await res.json();
    message = Array.isArray(body.message) ? body.message.join('; ') : (body.message ?? message);
  } catch {
    /* non-json */
  }
  return new ApiError(res.status, message);
}

export async function fetchBackupStatus(signal?: AbortSignal): Promise<BackupStatus> {
  const res = await fetch(`${API}/backup/status`, { credentials: 'include', headers: devHeaders(), signal });
  if (!res.ok) throw await parseApiError(res);
  return res.json() as Promise<BackupStatus>;
}

export async function inspectBackupArchive(file: File, signal?: AbortSignal): Promise<BackupInspectResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API}/backup/inspect`, {
    method: 'POST',
    credentials: 'include',
    headers: devHeaders(),
    body: form,
    signal,
  });
  if (!res.ok) throw await parseApiError(res);
  return res.json() as Promise<BackupInspectResult>;
}

function parseDownloadFilename(disposition: string | null): string {
  const match = /filename="([^"]+)"/.exec(disposition ?? '');
  return match?.[1] ?? 'campfire-backup.zip';
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function downloadServerBackup(options?: {
  keyPassphrase?: string;
  signal?: AbortSignal;
}): Promise<{ filename: string; bytes: number }> {
  const passphrase = options?.keyPassphrase?.trim();
  const usePost = Boolean(passphrase);
  const headers = devHeaders();
  const res = await fetch(usePost ? `${API}/backup/download` : `${API}/backup`, {
    method: usePost ? 'POST' : 'GET',
    credentials: 'include',
    headers: usePost ? (() => {
      headers.set('Content-Type', 'application/json');
      return headers;
    })() : headers,
    body: usePost ? JSON.stringify({ keyPassphrase: passphrase }) : undefined,
    signal: options?.signal,
  });
  if (!res.ok) throw await parseApiError(res);
  const blob = await res.blob();
  const filename = parseDownloadFilename(res.headers.get('Content-Disposition'));
  triggerBrowserDownload(blob, filename);
  return { filename, bytes: blob.size };
}

export async function restoreServerBackup(options: {
  file: File;
  keyPassphrase?: string;
  signal?: AbortSignal;
}): Promise<RestoreResult> {
  const form = new FormData();
  form.append('file', options.file);
  form.append('confirm', RESTORE_CONFIRM_TOKEN);
  const passphrase = options.keyPassphrase?.trim();
  if (passphrase) form.append('keyPassphrase', passphrase);
  const res = await fetch(`${API}/backup/restore`, {
    method: 'POST',
    credentials: 'include',
    headers: devHeaders(),
    body: form,
    signal: options.signal,
  });
  if (!res.ok) throw await parseApiError(res);
  return res.json() as Promise<RestoreResult>;
}

export async function verifyServerHealth(signal?: AbortSignal): Promise<ServerHealthResult> {
  const [liveRes, readyRes] = await Promise.all([
    fetch('/healthz', { signal }),
    fetch('/readyz', { signal }),
  ]);
  let liveBody: { ok?: boolean; version?: string } = {};
  let readyBody: { ok?: boolean; version?: string } = {};
  try {
    liveBody = await liveRes.json();
  } catch {
    /* ignore */
  }
  try {
    readyBody = await readyRes.json();
  } catch {
    /* ignore */
  }
  return {
    live: liveRes.ok && liveBody.ok === true,
    ready: readyRes.ok && readyBody.ok === true,
    version: liveBody.version ?? readyBody.version ?? null,
  };
}
