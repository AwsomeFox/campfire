/**
 * A first-class "External generator" step in the map-acquisition wizard (issue #411).
 *
 * Watabou and donjon used to be bare outbound links: the DM had to infer that they should
 * export an image, come back, and hunt for a separate upload dropzone. This turns each
 * external generator into a guided round trip inside the same card:
 *
 *   open generator → (generate + export on their site) → return → import → calibrate → attach
 *
 * without ever leaving this component. The card explains what the generator is best at, the
 * licence/terms caveat, and the expected export format; "Open generator" records the choice
 * (persisted, so a reload lands back here) and reveals a return checklist; the SAME card then
 * accepts drag/drop or a file picker, validates + previews the export, and imports it with
 * provenance. Campfire never fetches from the site itself — the copy says so plainly, so this
 * is never mistaken for an official integration or scraping.
 *
 * Imports flow through importMapWithAttribution → POST /campaigns/:id/maps/import, which saves
 * the map HIDDEN (DM-only) so it never auto-publishes on the player Handouts card, and stamps
 * the source/attribution as provenance.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { MapSource } from '@campfire/schema';
import { ApiError } from '../lib/api';
import { importMapWithAttribution } from './ImageUpload';
import { Btn } from './ui';
import {
  ACCEPTED_EXPORT_MIME,
  describeExportProblem,
  formatBytes,
} from './externalGeneratorAcquisition';

/**
 * Source-specific export guidance. Keyed by MapSource.id with a sensible fallback, so the
 * card can tell the DM exactly which export button to look for on each site (the issue's
 * "instructions are source-specific"). Kept intentionally light — a hint, not a mirror of
 * the third-party UI, which would rot as those sites change.
 */
const EXPORT_HINTS: Record<string, string> = {
  'watabou-one-page-dungeon':
    'On Watabou, use the menu (☰) → “Export” and pick PNG. The one-page dungeon exports as a single battle-map-ready image.',
  'watabou-city-generator':
    'On Watabou, open the menu (☰) → “Save/Export” and choose PNG. Great for a region or settlement map rather than a tactical grid.',
  'watabou-village-generator':
    'On Watabou, open the menu (☰) → “Export” and choose PNG. Best used as a location map.',
  'donjon-fantasy-maps':
    'On donjon, generate the map, then use the map’s own “Download”/“Save as image” control to grab a PNG.',
};

/** The generic export line every generator card shows beneath its specific hint. */
const GENERIC_EXPORT_LINE = 'Campfire accepts PNG (best for maps), JPEG, or WebP, up to 32 MB.';

/** Read an image file's pixel dimensions via an object URL, or null if it can't be decoded. */
function readImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/** A short, filename-derived default title so the DM rarely has to type one. */
function titleFromFile(file: File): string {
  const base = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  return base.slice(0, 120) || 'Imported map';
}

export function ExternalGeneratorCard({
  campaignId,
  source,
  acquisitionActive,
  onOpenGenerator,
  onCancelAcquisition,
  onImported,
  onError,
}: {
  campaignId: number;
  /** A curated `generator-external` map source (Watabou, donjon). */
  source: MapSource;
  /** True when this is the generator the DM opened and hasn't finished importing from. */
  acquisitionActive: boolean;
  /** Record the round trip (persist) + reveal the return checklist. */
  onOpenGenerator: () => void;
  /** Abandon the round trip ("I'll do this later") — clears the persisted marker. */
  onCancelAcquisition: () => void;
  /** Called with the new hidden 'map' attachment id after a successful import. */
  onImported: (attachmentId: number) => void;
  onError?: (message: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // The object URL we own and must revoke to avoid a blob leak (mirrors ImageUpload).
  const previewUrlRef = useRef<string | null>(null);

  // Revoke any staged preview URL on unmount.
  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  // Each card stays mounted while the DM browses generators. Drop staged state when this
  // card is no longer the active round trip so blob URLs aren't leaked and stale previews
  // don't resurrect if the DM returns later.
  useEffect(() => {
    if (acquisitionActive) return;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setFile(null);
    setPreviewUrl(null);
    setDims(null);
    setProblem(null);
    setTitle('');
  }, [acquisitionActive]);

  const stageFile = useCallback(
    async (picked: File) => {
      // Revoke the previous preview before staging a new one.
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const url = URL.createObjectURL(picked);
      // Track the owned URL synchronously (not via a post-render effect) so the unmount
      // cleanup can always revoke the newest one even if the component unmounts before a
      // render commits.
      previewUrlRef.current = url;
      setFile(picked);
      setPreviewUrl(url);
      setTitle(titleFromFile(picked));
      setDims(null);
      setProblem(null);
      // Decode dimensions so the validator (and the DM) can see them, then validate.
      const decoded = await readImageDimensions(picked);
      if (previewUrlRef.current !== url) return;
      setDims(decoded);
      setProblem(
        describeExportProblem({
          type: picked.type,
          size: picked.size,
          width: decoded?.width,
          height: decoded?.height,
        }),
      );
    },
    [],
  );

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    if (picked) void stageFile(picked);
    e.target.value = '';
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) void stageFile(dropped);
  }

  function clearStaged() {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setFile(null);
    setPreviewUrl(null);
    setDims(null);
    setProblem(null);
    // Reset the title too, so the next staged file doesn't inherit the previous map's
    // title (which would produce a wrong attachment filename/attribution).
    setTitle('');
  }

  const canImport = file != null && problem == null && !busy;

  async function submit() {
    if (!file || problem) return;
    setBusy(true);
    try {
      const result = await importMapWithAttribution(
        campaignId,
        {
          title: title.trim() || titleFromFile(file),
          // The generator is the author to credit; the licence + link come from the curated
          // source (the server derives the trusted licence from sourceId, not this string).
          author: source.name,
          license: source.license,
          sourceUrl: source.url,
          sourceId: source.id,
        },
        file,
      );
      clearStaged();
      onImported(result.attachment.id);
    } catch (err) {
      onError?.(err instanceof ApiError ? err.message : "Couldn't import the map.");
    } finally {
      setBusy(false);
    }
  }

  const hint = EXPORT_HINTS[source.id];

  return (
    <div
      data-testid={`external-generator-${source.id}`}
      style={{ borderTop: '1px solid var(--cf-border, rgba(255,255,255,0.08))', paddingTop: 8 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 12 }}>{source.name}</strong>
        <span className="cf-chip" style={{ fontSize: 10 }}>{source.license}</span>
      </div>

      {source.goodFor.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '4px 0' }}>
          {source.goodFor.map((g) => (
            <span key={g} className="cf-chip" style={{ fontSize: 10, opacity: 0.8 }}>{g}</span>
          ))}
        </div>
      )}

      <p className="text-muted" style={{ fontSize: 11, margin: '4px 0 2px' }}>{source.description}</p>
      <p className="text-muted" style={{ fontSize: 11, margin: '0 0 6px' }}>
        {hint ? `${hint} ` : ''}{GENERIC_EXPORT_LINE}
      </p>

      {!acquisitionActive ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Btn
            className="!min-h-0 !py-1 text-[11px]"
            data-testid={`open-generator-${source.id}`}
            onClick={() => {
              onOpenGenerator();
              // Open the generator in a new tab; Campfire never fetches it server-side.
              if (source.url) window.open(source.url, '_blank', 'noopener,noreferrer');
            }}
            title={`${source.description} — ${source.license}`}
          >
            Open generator ↗
          </Btn>
          <span className="text-muted" style={{ fontSize: 10, alignSelf: 'center', maxWidth: 320 }}>
            Opens {source.name} in a new tab. Campfire can’t generate or fetch the map for
            you, and this isn’t an official integration — export the image there, then bring
            the file back here.
          </span>
        </div>
      ) : (
        <div
          data-testid={`return-checklist-${source.id}`}
          className="cf-inset"
          style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span className="card-kicker">Bring your map back</span>
            <span style={{ flex: 1 }} />
            {source.url && (
              <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-muted" style={{ fontSize: 11 }}>
                reopen {source.name} ↗
              </a>
            )}
          </div>
          <ol
            className="text-muted"
            style={{ fontSize: 11, margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}
          >
            <li>Generate a map you like on {source.name}.</li>
            <li>Export it as an image ({hint ? 'see the tip above' : 'PNG, JPEG, or WebP'}).</li>
            <li>Come back here and drop the file below (or click to choose it).</li>
            <li>Preview it, then import — you’ll calibrate the grid after it attaches.</li>
          </ol>

          {/* Drop / pick the exported file — the same card, no separate dropzone elsewhere. */}
          <div
            role="button"
            tabIndex={0}
            aria-label={`Drop your ${source.name} export here, or click to choose a file`}
            data-testid={`generator-dropzone-${source.id}`}
            className={`cf-inset border-dashed ${dragOver ? 'border-amber-400/70' : ''}`}
            style={{ padding: 10, cursor: 'pointer', textAlign: 'center', minHeight: 64 }}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED_EXPORT_MIME.join(',')}
              className="hidden"
              onChange={onPick}
              data-testid={`generator-file-input-${source.id}`}
            />
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={`Preview of the ${source.name} export`}
                data-testid={`generator-preview-${source.id}`}
                style={{ maxWidth: '100%', maxHeight: 200, display: 'block', margin: '0 auto' }}
              />
            ) : (
              <span className="text-muted" style={{ fontSize: 11 }}>
                Drop your exported map here, or click to choose a file.
              </span>
            )}
          </div>

          {file && (
            <p className="text-muted" style={{ fontSize: 11, margin: 0 }} data-testid={`generator-meta-${source.id}`}>
              {file.name} · {formatBytes(file.size)}
              {dims ? ` · ${dims.width}×${dims.height}px` : ''}
            </p>
          )}

          {problem && (
            <p role="alert" className="text-rose-400" style={{ fontSize: 11, margin: 0 }} data-testid={`generator-problem-${source.id}`}>
              {problem}
            </p>
          )}

          {file && !problem && (
            <label className="flex flex-col gap-1 text-muted" style={{ fontSize: 11 }}>
              Map title
              <input
                type="text"
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
                data-testid={`generator-title-${source.id}`}
                style={{
                  minHeight: 32,
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-divider)',
                  background: 'transparent',
                  color: 'var(--color-text)',
                  fontSize: 12,
                  padding: '0 8px',
                }}
              />
            </label>
          )}

          <p className="text-muted" style={{ fontSize: 10, margin: 0 }}>
            Imported under “{source.license}”. The map is saved DM-only — it won’t appear on the
            player Handouts card until you reveal it. After it attaches, open Grid &amp; fog to
            calibrate the grid to the map.
          </p>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Btn
              className="!min-h-0 !py-1 text-[11px]"
              data-testid={`generator-import-${source.id}`}
              disabled={!canImport}
              onClick={() => void submit()}
            >
              {busy ? 'Importing…' : 'Import map'}
            </Btn>
            {file && (
              <Btn ghost className="!min-h-0 !py-1 text-[11px]" disabled={busy} onClick={clearStaged}>
                Choose a different file
              </Btn>
            )}
            <span style={{ flex: 1 }} />
            <Btn
              ghost
              className="!min-h-0 !py-1 text-[11px]"
              data-testid={`generator-later-${source.id}`}
              disabled={busy}
              onClick={() => {
                clearStaged();
                onCancelAcquisition();
              }}
            >
              I’ll do this later
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
