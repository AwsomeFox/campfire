/**
 * Drop/click image uploader. Uploads multipart directly via fetch (the JSON-only
 * `api` client in lib/api.ts can't send FormData) to
 * POST /api/v1/campaigns/:campaignId/attachments, then hands the caller back the
 * created Attachment (id + a ready-to-store `/api/v1/attachments/:id/file` url).
 *
 * Used by CharacterPage (portrait) and Dashboard/LocationPage map cards (map/image).
 *
 * Preview-vs-stored lifecycle (issue #583): a local object URL created on file
 * select is STAGED, never confused with a stored attachment. While the upload is
 * in flight the staged preview wears a clear "Uploading…" badge and a distinct
 * border; on failure it stays staged (so the user can Retry/Discard) but is
 * marked "Not saved" — never read as a confirmed image. Only when onUploaded
 * resolves does the component reset to the committed url, revoking the staged
 * object URL to avoid a blob leak. See imageUploadState.ts for the pure model.
 */
import { useCallback, useEffect, useReducer, useRef, useState, type DragEvent } from 'react';
import type { Attachment, AttachmentKind } from '@campfire/schema';
import { API, ApiError } from '../lib/api';
import { Btn } from './ui';
import {
  initialUploadState,
  isPreviewUncommitted,
  reduceUpload,
  visiblePreview,
  type UploadEvent,
} from './imageUploadState';

const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * Build the file-byte URL for an attachment, optionally content-versioned (issue #498).
 *
 * The server serves protected attachments with a long-lived browser cache but NO
 * `immutable`: the browser may reuse a fresh (in-window) cached response without
 * revalidation, but it revalidates at stale boundaries and on reload — so the
 * membership/hidden check runs at those points. The DURABLE authorization guarantee
 * is the `?v=<token>` below: it makes an authorization change produce a brand-new
 * URL (so the browser cache-misses and the request hits the server, where the check
 * runs and a now-unauthorized caller gets 403/404). The token folds id + hidden +
 * updatedAt, exactly the three row-level signals that change on re-upload,
 * reveal/hide toggle, or delete-then-restore. Pass the row when you have it
 * (Handouts list, freshly uploaded attachment); call sites with only an id
 * (campaign/encounter `mapAttachmentId`) can omit it and still be safe, just
 * without the cache-bust.
 *
 * NOTE: the server (AttachmentsService.versionToken) exposes a parallel helper
 * that hashes the SAME inputs for any non-web caller. The two do NOT need to
 * produce identical bytes — `?v=` is a client-controlled cache-buster the server
 * never validates; what matters is that BOTH are deterministic functions of
 * (id, hidden, updatedAt), so a given authorization state yields a stable URL and
 * a changed state yields a different one (modulo the extremely-unlikely 64-bit
 * hash collision). The web client uses a sync FNV-style hash (below); the server
 * uses sha256 via node:crypto. Keep both folding the same three fields.
 */
export function attachmentVersionToken(row: { id: number; hidden: boolean; updatedAt: string }): string {
  // Sync browser hash over `${id}|${hidden}|${updatedAt}`. We don't use SubtleCrypto
  // (the only sync-less Web Crypto surface) because it's async and would force every
  // caller into a Promise for a 64-bit value they don't await. A non-crypto hash is
  // correct here: the goal is uniqueness-per-authorization-state, not cryptographic
  // unpredictability (the underlying attachment id is already public).
  let h1 = 0x811c9dc5;
  const sig = `${row.id}|${row.hidden ? '1' : '0'}|${row.updatedAt}`;
  for (let i = 0; i < sig.length; i++) {
    h1 ^= sig.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  // Mix in a second word to widen the avalanche; encode as 16 hex chars.
  let h2 = 0xcbf29ce4;
  for (let i = sig.length - 1; i >= 0; i--) {
    h2 ^= sig.charCodeAt(i);
    h2 = Math.imul(h2, 0x01000193);
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  return hex.slice(0, 16);
}

export function attachmentFileUrl(
  attachmentId: number,
  version?: { hidden: boolean; updatedAt: string },
  /**
   * Extra query params to append (e.g. { size: 'thumb' }). Handled correctly whether
   * or not `version` is provided, so callers never hand-build the query string and
   * risk a double-`?` (which would silently drop the param — issue #498 review).
   */
  extra?: Record<string, string>,
): string {
  const base = `${API}/attachments/${attachmentId}/file`;
  const params = new URLSearchParams();
  if (version) {
    params.set('v', attachmentVersionToken({ id: attachmentId, hidden: version.hidden, updatedAt: version.updatedAt }));
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Role-safe VTT map endpoint (issue #463). Never use attachmentFileUrl for an
 * encounter canvas: non-DMs must receive the server-rendered fog revision rather
 * than the underlying attachment. `revision` changes with fog/map updates so an
 * existing <img> is replaced immediately; the server still sends no-store.
 */
export function encounterMapUrl(encounterId: number, revision: string): string {
  return `${API}/encounters/${encounterId}/map?revision=${encodeURIComponent(revision)}`;
}

/** Dev-auth headers (mirrors the JSON api client) for the multipart helpers below. */
function devAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const devRole = localStorage.getItem('cf.devRole');
  const devUser = localStorage.getItem('cf.devUser');
  if (devRole) headers['x-dev-role'] = devRole;
  if (devUser) headers['x-dev-user'] = devUser;
  return headers;
}

/** Parse a non-ok fetch Response into an ApiError with the server's message. */
async function toApiError(res: Response): Promise<ApiError> {
  let message = res.statusText;
  try {
    const body = await res.json();
    message = Array.isArray(body.message) ? body.message.join('; ') : (body.message ?? message);
  } catch {
    /* non-json error body */
  }
  return new ApiError(res.status, message);
}

/** Attribution the DM supplies when importing an open-licensed external map (issue #303). */
export interface MapImportAttribution {
  title: string;
  author: string;
  license?: string;
  sourceUrl?: string;
  sourceId?: string;
}

/** Result of a maps/import call: the stored map attachment + the stamped attribution. */
export interface ImportedMapResult {
  attachment: Attachment;
  attribution: { title: string; author: string; license: string; sourceUrl?: string };
}

/**
 * Import an open-licensed external map with attribution (issue #303) — a One Page Dungeon
 * (CC-BY-SA) entry or a Watabou/donjon export the DM downloaded. Multipart POST to
 * /campaigns/:id/maps/import; the server validates the licence, saves the map hidden
 * (DM-only), and stamps the credit onto the filename.
 */
export async function importMapWithAttribution(
  campaignId: number,
  attribution: MapImportAttribution,
  file: File,
): Promise<ImportedMapResult> {
  const form = new FormData();
  form.append('title', attribution.title);
  form.append('author', attribution.author);
  if (attribution.license) form.append('license', attribution.license);
  if (attribution.sourceUrl) form.append('sourceUrl', attribution.sourceUrl);
  if (attribution.sourceId) form.append('sourceId', attribution.sourceId);
  form.append('file', file);

  const res = await fetch(`${API}/campaigns/${campaignId}/maps/import`, {
    method: 'POST',
    credentials: 'include',
    headers: devAuthHeaders(),
    body: form,
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as ImportedMapResult;
}

/** Multipart upload helper — exported so callers that need a bare upload (no dropzone UI, e.g. the "Replace map" button) can reuse it. */
export async function uploadAttachment(campaignId: number, kind: AttachmentKind, file: File): Promise<Attachment> {
  const form = new FormData();
  form.append('kind', kind);
  form.append('file', file);

  const headers: Record<string, string> = {};
  const devRole = localStorage.getItem('cf.devRole');
  const devUser = localStorage.getItem('cf.devUser');
  if (devRole) headers['x-dev-role'] = devRole;
  if (devUser) headers['x-dev-user'] = devUser;

  const res = await fetch(`${API}/campaigns/${campaignId}/attachments`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: form,
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = Array.isArray(body.message) ? body.message.join('; ') : (body.message ?? message);
    } catch {
      /* non-json error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as Attachment;
}

export function ImageUpload({
  campaignId,
  kind,
  previewUrl,
  shape = 'rect',
  label = 'Drop an image, or click to choose',
  onUploaded,
  onError,
}: {
  campaignId: number;
  kind: AttachmentKind;
  /** Existing file to show before any new upload — e.g. character.portraitUrl already resolved to a URL. */
  previewUrl?: string | null;
  shape?: 'rect' | 'circle';
  label?: string;
  onUploaded: (attachment: Attachment) => void;
  onError?: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // The currently staged File, held in a ref (not state) so re-renders aren't
  // driven by it and so Retry can re-issue the exact same bytes.
  const pendingFileRef = useRef<File | null>(null);
  // The staged object URL we are responsible for revoking. Tracked alongside the
  // reducer state so we never lose the handle to revoke (issue #583 leak fix).
  const stagedUrlRef = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [state, dispatch] = useReducer(reduceUpload, initialUploadState);

  // Revoke the staged object URL whenever it is replaced or cleared, and on
  // unmount. This is the leak fix: previously the URL was created on select and
  // only revoked implicitly. Now every terminal transition drops it.
  useEffect(() => {
    if (state.stagedPreview !== stagedUrlRef.current) {
      // The reducer moved on from the old staged URL (or cleared it). Revoke the
      // old handle and track the new one (or null).
      if (stagedUrlRef.current) URL.revokeObjectURL(stagedUrlRef.current);
      stagedUrlRef.current = state.stagedPreview;
    }
  }, [state.stagedPreview]);

  useEffect(() => {
    // Unmount: revoke whatever is still staged so we don't leak the blob past
    // the component's life. This runs once; React keeps the ref current.
    const handle = stagedUrlRef;
    return () => {
      if (handle.current) {
        URL.revokeObjectURL(handle.current);
        handle.current = null;
      }
    };
  }, []);

  const shown = visiblePreview(state, previewUrl);
  const uncommitted = isPreviewUncommitted(state, previewUrl);
  const isUploading = state.status === 'uploading' || state.status === 'saving';
  const isFailed = state.status === 'failed';

  const doUpload = useCallback(
    async (file: File) => {
      if (!ACCEPTED_MIME.includes(file.type)) {
        onError?.('Unsupported file type — use PNG, JPEG, or WebP.');
        return;
      }
      if (file.size > MAX_BYTES) {
        onError?.('File is too large — 32MB max.');
        return;
      }

      // Stage the local preview. If a previous staged URL exists (e.g. retrying
      // with a different file), the effect above revokes it.
      pendingFileRef.current = file;
      const objectUrl = URL.createObjectURL(file);
      dispatch({ type: 'select', stagedUrl: objectUrl });

      try {
        const attachment = await uploadAttachment(campaignId, kind, file);
        // Bytes are durably stored. Flip to "saving" so the badge reflects that
        // the linking PATCH (the caller's onUploaded) is the remaining step.
        const committedUrl = attachmentFileUrl(attachment.id, {
          hidden: attachment.hidden,
          updatedAt: attachment.updatedAt,
        });
        dispatch({ type: 'bytes-stored', committedUrl });
        try {
          // Await the host's linking step (e.g. PATCH characters/:id with the
          // portraitUrl). If THAT fails we keep the committed url but mark the
          // state failed, so the user sees a distinct "stored but not linked"
          // error rather than a silent half-success (issue #583 recoverable state).
          await onUploaded(attachment);
          // Fully committed: drop the staged preview so the caller's previewUrl
          // (refreshed from the server) becomes the single source of truth.
          dispatch({ type: 'reset' });
        } catch (err) {
          const message = err instanceof ApiError ? err.message : "Couldn't link the uploaded image.";
          onError?.(message);
          dispatch({ type: 'commit-failed', committedUrl, error: message });
        }
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Couldn't upload the image.";
        onError?.(message);
        dispatch({ type: 'upload-failed', error: message });
      }
    },
    [campaignId, kind, onUploaded, onError],
  );

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void doUpload(file);
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void doUpload(file);
    e.target.value = '';
  }

  function onRetry() {
    const file = pendingFileRef.current;
    if (!file) {
      // No file to re-send (shouldn't happen) — reset to a clean slate.
      dispatch({ type: 'discard' });
      return;
    }
    dispatch({ type: 'retry' });
    void doUpload(file);
  }

  function onDiscard() {
    pendingFileRef.current = null;
    dispatch({ type: 'discard' });
  }

  const shapeClass = shape === 'circle' ? 'rounded-full' : 'rounded-xl';
  // A staged (uncommitted) preview wears a distinct amber dashed border so it is
  // never mistaken for a stored image; a failed one goes rose. The committed
  // preview keeps the default inset look.
  const stateBorder = isFailed
    ? 'border-rose-400/80'
    : uncommitted
      ? 'border-amber-400/80'
      : '';

  return (
    <div className="space-y-1.5">
      <div
        className={`relative cf-inset border-dashed overflow-hidden transition-colors ${shapeClass} ${
          dragOver ? 'border-amber-400/70' : stateBorder
        } ${isFailed ? '' : 'cursor-pointer'}`}
        style={shape === 'circle' ? { width: 96, height: 96 } : { minHeight: 140 }}
        onClick={() => {
          // Don't open the picker while a failed upload is awaiting a decision —
          // force an explicit Retry/Discard so the staged file isn't silently
          // abandoned (issue #583: no duplicate silent uploads).
          if (isFailed) return;
          inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        role="button"
        tabIndex={isFailed ? -1 : 0}
        aria-label={label}
        aria-busy={isUploading}
        onKeyDown={(e) => {
          if (isFailed) return;
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_MIME.join(',')}
          className="hidden"
          onChange={onPick}
        />
        {shown ? (
          <img
            src={shown}
            alt=""
            className={`w-full h-full object-cover ${shapeClass}`}
            style={shape === 'circle' ? { width: 96, height: 96 } : undefined}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-center p-4">
            <span className="text-[11px] text-[var(--color-neutral-600)]">{isUploading ? 'Uploading…' : label}</span>
          </div>
        )}

        {/* Uncommitted badge: the core of issue #583. A staged local preview is
            labeled so a user can never read it as a saved image. Different copy
            per sub-state makes the distinction obvious. */}
        {uncommitted && shown && (
          <div
            className={`absolute top-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-semibold leading-tight ${
              isFailed
                ? 'bg-rose-500/90 text-white'
                : 'bg-amber-400/90 text-black'
            }`}
          >
            {isFailed ? 'Not saved' : state.status === 'saving' ? 'Saving…' : 'Uploading…'}
          </div>
        )}

        {isUploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs text-white">
            {state.status === 'saving' ? 'Saving…' : 'Uploading…'}
          </div>
        )}

        {/* Failed: explicit recovery. Retry re-sends the staged file (no silent
            re-upload); Discard drops it and revokes the object URL. */}
        {isFailed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/60 p-2 text-center">
            <span className="text-[11px] font-semibold text-rose-200">Upload failed</span>
            {state.error && <span className="text-[10px] text-rose-100/80 line-clamp-2">{state.error}</span>}
            <div className="flex gap-1.5">
              <button
                type="button"
                className="cf-btn cf-btn-ghost !min-h-0 !py-1 !px-2 text-[10px]"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry();
                }}
              >
                Retry
              </button>
              <button
                type="button"
                className="cf-btn cf-btn-ghost !min-h-0 !py-1 !px-2 text-[10px]"
                onClick={(e) => {
                  e.stopPropagation();
                  onDiscard();
                }}
              >
                Discard
              </button>
            </div>
          </div>
        )}
      </div>
      {uncommitted && shown && !isFailed && (
        <p className="text-[10px] text-amber-300/80 leading-tight">
          {state.status === 'saving' ? 'Stored — linking to your page…' : 'Preview — not saved yet.'}
        </p>
      )}
    </div>
  );
}

/** Small "Upload map" / "Remove map" affordance for DM map cards (Dashboard). */
export function MapUploadButton({
  campaignId,
  hasMap,
  uploading,
  onPick,
  onRemove,
}: {
  campaignId: number;
  hasMap: boolean;
  uploading?: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  void campaignId;

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_MIME.join(',')}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          e.target.value = '';
        }}
      />
      <Btn ghost className="!min-h-0 !py-1 text-[10px]" disabled={uploading} onClick={() => inputRef.current?.click()}>
        {uploading ? 'Uploading…' : hasMap ? 'Replace map' : 'Upload map'}
      </Btn>
      {hasMap && (
        <Btn ghost className="!min-h-0 !py-1 text-[10px]" disabled={uploading} onClick={onRemove}>
          Remove map
        </Btn>
      )}
    </div>
  );
}
