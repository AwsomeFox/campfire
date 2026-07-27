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
  lastArchiveName?: string | null;
  lastVerifiedAt?: string | null;
  consecutiveFailures?: number;
  metrics?: BackupCadenceMetrics;
}

export interface BackupCadenceMetrics {
  successCount: number;
  failureCount: number;
  pruneCount: number;
  prunedBytes: number;
  lastFreeBytes: number | null;
  lastEstimatedBytes: number | null;
  lastPruneAt: string | null;
  lastPruneError: string;
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
  disk: {
    freeBytes: number;
    totalBytes: number;
    reserveBytes: number;
    estimatedNextBytes: number;
    lowSpace: boolean;
  } | null;
  retention: {
    policy: {
      keepCount: number | null;
      keepDays: number | null;
      maxTotalBytes: number | null;
      protectLastGood: boolean;
    };
    archiveCount: number;
    totalBytes: number;
    protectedLastGoodName: string | null;
    pruneCount: number;
    prunedBytes: number;
    lastPruneAt: string | null;
    lastPruneError: string;
  };
  alerts: string[];
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
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Defer revocation so the browser has reliably started consuming the blob URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The non-streaming browser fallback is deliberately bounded. */
export const MAX_BROWSER_BACKUP_BUFFER_BYTES = 512 * 1024 * 1024;

/** Deliberately user-actionable download constraints that should remain verbatim. */
export class BackupDownloadLimitError extends Error {}

export interface BackupDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export type BackupDownloadResult = {
  filename: string;
  bytes: number;
  /** `file-system-access` writes directly to the chosen file; `browser-memory` buffers a bounded Blob. */
  destination: 'file-system-access' | 'browser-memory';
};

type WritableFileHandle = {
  name: string;
  createWritable(): Promise<{ write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
};

type SaveFilePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<WritableFileHandle>;

function saveFilePicker(): SaveFilePicker | null {
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  // Bind to `window`: Chromium's WebIDL window methods reject a detached receiver with
  // "Illegal invocation". Calling it unbound would fail on exactly the browsers that
  // support streaming to disk, and — because the picker was detected — would skip the
  // bounded-memory fallback too, so the download would not degrade, it would just break.
  return picker ? picker.bind(window) : null;
}

function contentLength(res: Response): number | null {
  const raw = res.headers.get('Content-Length')?.trim();
  if (!raw) return null;
  const value = Number(raw);
  // A backup archive cannot be empty. Treat zero, malformed, and missing headers
  // as unknown length so chunked responses retain indeterminate progress.
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  // AbortSignal.throwIfAborted() is not available in every browser that can run
  // the app. Keep cancellation on the DOMException contract the workflow already
  // recognizes instead of turning a dismissed picker into a TypeError.
  if (signal?.aborted) {
    throw new DOMException('The backup download was cancelled before it started.', 'AbortError');
  }
}

export async function downloadServerBackup(options?: {
  keyPassphrase?: string;
  signal?: AbortSignal;
  onProgress?: (progress: BackupDownloadProgress) => void;
  onPhase?: (phase: 'streaming' | 'finalizing') => void;
}): Promise<BackupDownloadResult> {
  const passphrase = options?.keyPassphrase?.trim();
  const usePost = Boolean(passphrase);
  const headers = devHeaders();
  // Pick a destination before starting the network request: browsers only allow the
  // chooser while the user gesture that started the download is still live. POST
  // downloads cannot be handed to the browser download manager portably, so use
  // File System Access when it is available.
  const picker = saveFilePicker();
  let fileHandle: WritableFileHandle | null = null;
  if (picker) {
    throwIfAborted(options?.signal);
    try {
      fileHandle = await picker({
        suggestedName: 'campfire-backup.zip',
        types: [{ description: 'Campfire backup archive', accept: { 'application/zip': ['.zip'] } }],
      });
    } catch (error) {
      // Dismissing the save dialog rejects with AbortError. Reporting that as an API
      // failure would tell the operator the backup broke when they simply changed their
      // mind — and no request has even been issued yet.
      if (isAbortError(error)) {
        throwIfAborted(options?.signal);
        throw new DOMException('The backup download was cancelled before it started.', 'AbortError');
      }
      throw error;
    }
    throwIfAborted(options?.signal);
  }
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
  const filename = parseDownloadFilename(res.headers.get('Content-Disposition'));
  const totalBytes = contentLength(res);
  const reader = res.body?.getReader();
  if (!reader) {
    if (totalBytes === null || totalBytes > MAX_BROWSER_BACKUP_BUFFER_BYTES) {
      throw new BackupDownloadLimitError(
        `This browser cannot stream the response and can only safely buffer backups with a known size up to ${MAX_BROWSER_BACKUP_BUFFER_BYTES / 1024 / 1024} MiB. Use a browser with File System Access support or download with curl.`,
      );
    }
    const blob = await res.blob();
    if (blob.size > MAX_BROWSER_BACKUP_BUFFER_BYTES) {
      throw new BackupDownloadLimitError(
        `This browser must buffer the archive in memory and only supports backups up to ${MAX_BROWSER_BACKUP_BUFFER_BYTES / 1024 / 1024} MiB. The partial download was discarded.`,
      );
    }
    options?.onPhase?.('finalizing');
    triggerBrowserDownload(blob, filename);
    options?.onProgress?.({ receivedBytes: blob.size, totalBytes });
    return { filename, bytes: blob.size, destination: 'browser-memory' };
  }

  let receivedBytes = 0;
  const report = () => options?.onProgress?.({ receivedBytes, totalBytes });
  options?.onPhase?.('streaming');
  report();

  if (fileHandle) {
    let writable: Awaited<ReturnType<WritableFileHandle['createWritable']>> | null = null;
    try {
      writable = await fileHandle.createWritable();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        receivedBytes += value.byteLength;
        report();
      }
      options?.onPhase?.('finalizing');
      await writable.close();
      return { filename: fileHandle.name, bytes: receivedBytes, destination: 'file-system-access' };
    } catch (error) {
      // Abort removes the partial file where supported, and cancelling the fetch
      // propagates back to the server instead of generating an archive nobody
      // can receive after the destination has failed.
      await Promise.allSettled([
        writable?.abort(),
        reader.cancel(),
      ]);
      throw error;
    }
  }

  if (totalBytes !== null && totalBytes > MAX_BROWSER_BACKUP_BUFFER_BYTES) {
    await reader.cancel();
    throw new BackupDownloadLimitError(
      `This browser must buffer the archive in memory and only supports backups up to ${MAX_BROWSER_BACKUP_BUFFER_BYTES / 1024 / 1024} MiB. Use a browser with File System Access support or download with curl.`,
    );
  }
  const chunks: BlobPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_BROWSER_BACKUP_BUFFER_BYTES) {
      await reader.cancel();
      throw new BackupDownloadLimitError(
        `This browser must buffer the archive in memory and only supports backups up to ${MAX_BROWSER_BACKUP_BUFFER_BYTES / 1024 / 1024} MiB. The partial download was discarded.`,
      );
    }
    // Slice the view itself, not its backing buffer: a stream chunk can be a subarray
    // over a SharedArrayBuffer, whose slice would retain the broader backing store and
    // is not a BlobPart. Uint8Array#slice creates a tightly-sized standalone buffer.
    chunks.push(value.slice().buffer);
    report();
  }
  const blob = new Blob(chunks, { type: res.headers.get('Content-Type') ?? 'application/zip' });
  options?.onPhase?.('finalizing');
  triggerBrowserDownload(blob, filename);
  return { filename, bytes: receivedBytes, destination: 'browser-memory' };
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
