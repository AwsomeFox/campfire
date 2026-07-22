/**
 * Drop/click image uploader. Uploads multipart directly via fetch (the JSON-only
 * `api` client in lib/api.ts can't send FormData) to
 * POST /api/v1/campaigns/:campaignId/attachments, then hands the caller back the
 * created Attachment (id + a ready-to-store `/api/v1/attachments/:id/file` url).
 *
 * Used by CharacterPage (portrait) and Dashboard/LocationPage map cards (map/image).
 */
import { useCallback, useRef, useState, type DragEvent } from 'react';
import type { Attachment, AttachmentKind } from '@campfire/schema';
import { API, ApiError } from '../lib/api';
import { Btn } from './ui';

const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 32 * 1024 * 1024;

export function attachmentFileUrl(attachmentId: number): string {
  return `${API}/attachments/${attachmentId}/file`;
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
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [localPreview, setLocalPreview] = useState<string | null>(null);

  const shown = localPreview ?? previewUrl ?? null;

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

      const objectUrl = URL.createObjectURL(file);
      setLocalPreview(objectUrl);
      setUploading(true);
      try {
        const attachment = await uploadAttachment(campaignId, kind, file);
        onUploaded(attachment);
      } catch (err) {
        onError?.(err instanceof ApiError ? err.message : "Couldn't upload the image.");
      } finally {
        setUploading(false);
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

  const shapeClass = shape === 'circle' ? 'rounded-full' : 'rounded-xl';

  return (
    <div
      className={`relative cf-inset border-dashed overflow-hidden cursor-pointer transition-colors ${shapeClass} ${
        dragOver ? 'border-amber-400/70' : ''
      }`}
      style={shape === 'circle' ? { width: 96, height: 96 } : { minHeight: 140 }}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      role="button"
      tabIndex={0}
      aria-label={label}
      onKeyDown={(e) => {
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
        <img src={shown} alt="" className={`w-full h-full object-cover ${shapeClass}`} style={shape === 'circle' ? { width: 96, height: 96 } : undefined} />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-center p-4">
          <span className="text-[11px] text-[var(--color-neutral-600)]">{uploading ? 'Uploading…' : label}</span>
        </div>
      )}
      {uploading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs text-white">
          Uploading…
        </div>
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
