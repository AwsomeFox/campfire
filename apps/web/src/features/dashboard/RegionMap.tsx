import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Attachment, Campaign, Location, Role } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { ErrorNote } from '../../components/ui';
import { ImageUpload, MapUploadButton, attachmentFileUrl, uploadAttachment } from '../../components/ImageUpload';

const VIEW_W = 500;
const VIEW_H = 260;

// Status tones follow the app's existing chip convention (see cf-chip-* in index.css):
// accent for "current" (matches the legend dot below), the emerald success family for
// "explored" (same #10b981/#34d399 pairing as cf-chip-completed), and the neutral ramp
// for "unexplored" — no bare Tailwind slate/amber hexes.
const STATUS_COLOR: Record<Location['status'], string> = {
  current: 'var(--color-accent)',
  explored: '#10b981',
  unexplored: 'var(--color-neutral-500)',
};
const STATUS_TEXT_COLOR: Record<Location['status'], string> = {
  current: 'var(--color-accent-300)',
  explored: '#34d399',
  unexplored: 'var(--color-neutral-400)',
};
const STATUS_LABEL: Record<Location['status'], string> = {
  current: 'Current',
  explored: 'Explored',
  unexplored: 'Unexplored',
};
// Status glyphs pair with color so pins read color+text, not color-only (matches the
// suffix already used in the no-map SVG view below).
const STATUS_GLYPH: Record<Location['status'], string> = {
  current: '📍',
  explored: '✓',
  unexplored: '?',
};

export function RegionMap({
  campaignId,
  campaign,
  locations,
  role,
  onChange,
}: {
  campaignId: number;
  campaign: Campaign;
  locations: Location[];
  role: Role | null;
  onChange: () => void;
}) {
  const isDm = role === 'dm';
  const pinned = locations.filter((l) => l.mapX != null && l.mapY != null);
  const unpinned = locations.filter((l) => l.mapX == null || l.mapY == null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const mapImageUrl = campaign.mapAttachmentId ? attachmentFileUrl(campaign.mapAttachmentId) : null;

  async function handleMapUpload(attachment: Attachment) {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`${API}/campaigns/${campaignId}`, { mapAttachmentId: attachment.id });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the map.");
    } finally {
      setBusy(false);
    }
  }

  async function handleMapRemove() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`${API}/campaigns/${campaignId}`, { mapAttachmentId: null });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove the map.");
    } finally {
      setBusy(false);
    }
  }

  /** "Replace map" button path — bare upload (no dropzone UI), then wire the new attachment id. */
  async function uploadMapFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const attachment = await uploadAttachment(campaignId, 'map', file);
      await handleMapUpload(attachment);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't upload the map.");
    } finally {
      setBusy(false);
    }
  }

  async function savePinPercent(locationId: number, xPct: number, yPct: number) {
    try {
      await api.patch(`${API}/locations/${locationId}`, {
        mapX: Math.max(0, Math.min(100, xPct)),
        mapY: Math.max(0, Math.min(100, yPct)),
      });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't move the pin.");
    }
  }

  function pointerToPercent(e: ReactPointerEvent): { x: number; y: number } | null {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    return { x, y };
  }

  function onPinPointerDown(e: ReactPointerEvent<HTMLDivElement>, locationId: number) {
    if (!isDm || !mapImageUrl) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDraggingId(locationId);
    setDragPos(pointerToPercent(e));
  }

  function onSurfacePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (draggingId == null) return;
    const pct = pointerToPercent(e);
    if (pct) setDragPos(pct);
  }

  function onSurfacePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (draggingId == null) return;
    const pct = pointerToPercent(e) ?? dragPos;
    const id = draggingId;
    setDraggingId(null);
    setDragPos(null);
    if (!pct) return;
    void savePinPercent(id, pct.x, pct.y);
  }

  return (
    <div className="card elev-sm" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px 0', flexWrap: 'wrap' }}>
        <span className="card-kicker">World map</span>
        <div style={{ flex: 1 }} />
        {isDm && mapImageUrl && (
          <MapUploadButton
            campaignId={campaignId}
            hasMap
            uploading={busy}
            onPick={(file) => void uploadMapFile(file)}
            onRemove={() => void handleMapRemove()}
          />
        )}
        <Link to={`/c/${campaignId}/locations`} className="btn btn-ghost" style={{ fontSize: 12 }}>
          All locations →
        </Link>
      </div>

      {error && (
        <div style={{ padding: '8px 14px 0' }}>
          <ErrorNote message={error} onRetry={() => setError(null)} />
        </div>
      )}

      {isDm && !mapImageUrl && (
        <div style={{ padding: '8px 14px 0' }}>
          <DmMapUploader campaignId={campaignId} onUploaded={handleMapUpload} onError={setError} />
        </div>
      )}

      <div
        ref={surfaceRef}
        className="relative overflow-hidden h-56 md:h-64"
        style={{ margin: '8px 14px', touchAction: draggingId != null ? 'none' : undefined }}
        onPointerMove={onSurfacePointerMove}
        onPointerUp={onSurfacePointerUp}
      >
        {mapImageUrl ? (
          <img src={mapImageUrl} alt="Campaign map" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div
            className="absolute inset-0 opacity-35"
            style={{
              backgroundImage: 'radial-gradient(#334155 1px, transparent 1px)',
              backgroundSize: '16px 16px',
            }}
          />
        )}

        {mapImageUrl ? (
          // Percent-positioned pins overlaid directly on the uploaded map image.
          <>
            {pinned.map((loc) => {
              const isCurrent = loc.status === 'current';
              const isDragging = draggingId === loc.id && dragPos != null;
              const left = isDragging ? dragPos!.x : (loc.mapX ?? 0);
              const top = isDragging ? dragPos!.y : (loc.mapY ?? 0);
              return (
                <div
                  key={loc.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
                  style={{
                    left: `${left}%`,
                    top: `${top}%`,
                    width: 44,
                    height: 44,
                    justifyContent: 'center',
                    cursor: isDm ? 'grab' : 'pointer',
                    touchAction: 'none',
                    opacity: isDragging ? 0.85 : 1,
                    zIndex: isDragging ? 10 : 1,
                  }}
                  onPointerDown={(e) => onPinPointerDown(e, loc.id)}
                >
                  <Link
                    to={`/c/${campaignId}/locations/${loc.id}`}
                    onClick={(e) => {
                      if (draggingId != null) e.preventDefault();
                    }}
                    className="flex flex-col items-center gap-0.5"
                  >
                    <span
                      style={{
                        width: isCurrent ? 14 : 10,
                        height: isCurrent ? 14 : 10,
                        borderRadius: '50%',
                        background: STATUS_COLOR[loc.status],
                        boxShadow: `0 0 0 6px color-mix(in srgb, ${STATUS_COLOR[loc.status]} 20%, transparent)`,
                      }}
                    />
                    <span
                      className="text-[10px] font-bold px-1 rounded"
                      style={{ color: STATUS_TEXT_COLOR[loc.status], background: 'rgba(15,23,42,.6)' }}
                      title={STATUS_LABEL[loc.status]}
                    >
                      {STATUS_GLYPH[loc.status]} {loc.name}
                    </span>
                  </Link>
                </div>
              );
            })}
          </>
        ) : (
          <svg className="w-full h-full" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} xmlns="http://www.w3.org/2000/svg">
            {pinned.map((loc) => {
              const x = ((loc.mapX ?? 0) / 100) * VIEW_W;
              const y = ((loc.mapY ?? 0) / 100) * VIEW_H;
              const isCurrent = loc.status === 'current';
              const isExplored = loc.status === 'explored';
              const r = isCurrent ? 5.5 : loc.status === 'unexplored' ? 3.5 : 4.5;
              const glowR = isCurrent ? 12 : isExplored ? 9 : 7;
              const suffix = ` ${STATUS_GLYPH[loc.status]}`;
              return (
                <g key={loc.id} transform={`translate(${x}, ${y})`}>
                  <Link to={`/c/${campaignId}/locations/${loc.id}`}>
                    <circle
                      r={glowR}
                      style={{ fill: STATUS_COLOR[loc.status] }}
                      fillOpacity={isCurrent ? 0.25 : isExplored ? 0.2 : 0.3}
                    >
                      {isCurrent && (
                        <animate attributeName="fill-opacity" values=".25;.5;.25" dur="2s" repeatCount="indefinite" />
                      )}
                    </circle>
                    <circle r={r} style={{ fill: STATUS_COLOR[loc.status] }} />
                    <text
                      x={isCurrent ? -12 : isExplored ? 13 : 12}
                      y={isCurrent ? -12 : isExplored ? 4 : 4}
                      fontSize="11"
                      style={{ fill: STATUS_TEXT_COLOR[loc.status] }}
                      fontWeight={isCurrent ? 'bold' : undefined}
                      textAnchor={isCurrent ? 'end' : 'start'}
                    >
                      {loc.name}
                      {suffix}
                    </text>
                  </Link>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {unpinned.length > 0 && (
        <div className="flex flex-wrap gap-2" style={{ padding: '0 14px 10px' }}>
          {unpinned.map((loc) => (
            <Link
              key={loc.id}
              to={`/c/${campaignId}/locations/${loc.id}`}
              className="cf-chip"
              style={{
                background: 'color-mix(in srgb, var(--color-neutral-500) 20%, transparent)',
                color: STATUS_TEXT_COLOR[loc.status],
              }}
            >
              {STATUS_GLYPH[loc.status]} {loc.name}
            </Link>
          ))}
        </div>
      )}
      <div
        className="text-muted"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          padding: '10px 14px',
          borderTop: '1px solid var(--color-divider)',
          fontSize: 11,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR.current }} />
          {STATUS_GLYPH.current} {STATUS_LABEL.current}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR.explored }} />
          {STATUS_GLYPH.explored} {STATUS_LABEL.explored}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', border: '1px dashed var(--color-neutral-600)' }} />
          {STATUS_GLYPH.unexplored} {STATUS_LABEL.unexplored}
        </span>
        <span style={{ marginLeft: 'auto' }}>{isDm && mapImageUrl ? 'Drag a pin to move it' : 'Drag to pan · tap a pin'}</span>
      </div>
    </div>
  );
}

/** Compact inline dropzone DM uses to upload/replace the campaign map. */
function DmMapUploader({
  campaignId,
  onUploaded,
  onError,
}: {
  campaignId: number;
  onUploaded: (a: Attachment) => void;
  onError: (msg: string) => void;
}) {
  return (
    <ImageUpload
      campaignId={campaignId}
      kind="map"
      shape="rect"
      label="Drop a map image, or click to choose"
      onUploaded={onUploaded}
      onError={onError}
    />
  );
}
