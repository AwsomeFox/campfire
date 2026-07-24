/**
 * First-party procedural map-generation wizard (issue #409). The REST endpoints
 * (POST /campaigns/:id/maps/generate, POST /encounters/:id/generate-map) and the MCP
 * generate_map tool already exist (#306); this is the missing human workflow: choose the
 * map's shape, PREVIEW it (without attaching or revealing), reroll until it's right, then
 * atomically "Use" it.
 *
 * Why a separate preview step: the generate endpoints PERSIST an attachment, so calling
 * them for every candidate would litter the campaign with orphan maps and burn its storage
 * quota. Instead we hit POST /campaigns/:id/maps/generate/preview, which renders the SVG
 * WITHOUT saving anything. Generation is deterministic by seed, so "Use this map" replays
 * the previewed seed through the real (persisting) endpoint via `onUse` — the attached map
 * is byte-identical to what the DM saw, and nothing was written until they committed.
 *
 * Rendering-only + accessible: the preview is a plain <img> of the SVG data URL with a
 * descriptive alt text; it never attaches, reveals, or shows on the player Handouts card.
 * Every control is a native input/button (keyboard operable) and the layout wraps for
 * mobile.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenerateMapParams, GeneratedMapPreview, MapKind, MapSize, MapTheme } from '@campfire/schema';
import { api, API, ApiError } from '../lib/api';
import { Btn } from './ui';

const KINDS: { value: MapKind; label: string }[] = [
  { value: 'dungeon', label: 'Dungeon' },
  { value: 'cave', label: 'Cave' },
  { value: 'wilderness', label: 'Wilderness' },
];
const SIZES: { value: MapSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];
const THEMES: { value: MapTheme; label: string }[] = [
  { value: 'stone', label: 'Stone' },
  { value: 'cavern', label: 'Cavern' },
  { value: 'forest', label: 'Forest' },
  { value: 'crypt', label: 'Crypt' },
];

/** Data URL for the previewed SVG markup — rendered by a plain <img> (never attached). */
function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Human alt text for the preview so a screen reader describes the candidate map. */
function previewAlt(p: GeneratedMapPreview): string {
  const rooms = p.kind === 'dungeon' ? `, ${p.roomCount} room${p.roomCount === 1 ? '' : 's'}` : '';
  return `Preview of a generated ${p.kind} battle map, ${p.widthCells} by ${p.heightCells} grid squares${rooms} (seed ${p.seed}).`;
}

export function GenerateMapPanel({
  campaignId,
  onUse,
  onError,
  onCancel,
}: {
  campaignId: number;
  /**
   * Attach the currently-previewed map by replaying its exact params + seed through the
   * persisting endpoint (POST /encounters/:id/generate-map for an encounter, or
   * .../maps/generate + PATCH for the region map). Resolves once the attach is done.
   */
  onUse: (params: Required<Pick<GenerateMapParams, 'kind' | 'size'>> & GenerateMapParams) => Promise<void>;
  onError?: (message: string) => void;
  onCancel?: () => void;
}) {
  const [kind, setKind] = useState<MapKind>('dungeon');
  const [size, setSize] = useState<MapSize>('medium');
  const [complexity, setComplexity] = useState(0.5);
  const [theme, setTheme] = useState<MapTheme | ''>('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  // The seed field: blank means "let the server pick one" — after a preview it's filled
  // with the resolved seed so the map is reproducible and the value is copyable.
  const [seed, setSeed] = useState('');
  const [preview, setPreview] = useState<GeneratedMapPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [using, setUsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Ignore an in-flight preview whose params are already stale (rapid reroll / edits).
  const previewSeq = useRef(0);
  // Handle for the transient "Copied" reset, cleared on unmount so it can't setState late.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Exact params (including the server-resolved seed) that produced the currently-shown
  // preview. "Use this map" replays THESE — never live form state — so editing a control
  // after a preview without re-previewing can't silently attach a different map than shown.
  const previewedParamsRef = useRef<
    (Required<Pick<GenerateMapParams, 'kind' | 'size'>> & GenerateMapParams) | null
  >(null);

  const busy = previewing || using;

  /** Assemble the request params from the current form + an optional explicit seed. */
  const buildParams = useCallback(
    (explicitSeed?: string): GenerateMapParams => {
      const params: GenerateMapParams = { kind, size, complexity };
      if (theme) params.theme = theme;
      const s = explicitSeed !== undefined ? explicitSeed : seed.trim();
      if (s) params.seed = s;
      return params;
    },
    [kind, size, complexity, theme, seed],
  );

  const runPreview = useCallback(
    async (explicitSeed?: string) => {
      const seq = ++previewSeq.current;
      const requestParams = buildParams(explicitSeed);
      setPreviewing(true);
      setError(null);
      try {
        const result = await api.post<GeneratedMapPreview>(
          `${API}/campaigns/${campaignId}/maps/generate/preview`,
          requestParams,
        );
        if (seq !== previewSeq.current) return; // superseded by a newer preview
        setPreview(result);
        setSeed(result.seed); // surface the resolved seed (copyable + reproducible)
        // Pin the exact params + resolved seed behind this shown preview so "Use" is faithful.
        previewedParamsRef.current = {
          ...requestParams,
          seed: result.seed,
        } as Required<Pick<GenerateMapParams, 'kind' | 'size'>> & GenerateMapParams;
      } catch (err) {
        if (seq !== previewSeq.current) return;
        const message = err instanceof ApiError ? err.message : "Couldn't generate a preview.";
        setError(message);
        onError?.(message);
      } finally {
        if (seq === previewSeq.current) setPreviewing(false);
      }
    },
    [campaignId, buildParams, onError],
  );

  // First preview on mount so the DM immediately sees a candidate map.
  useEffect(() => {
    void runPreview();
    return () => {
      // Invalidate any in-flight preview so its resolution can't setState after unmount,
      // and cancel a pending "Copied" reset for the same reason.
      previewSeq.current++;
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Reroll: discard the current seed so the server picks a fresh one, then re-preview. */
  function regenerate() {
    setSeed('');
    void runPreview('');
  }

  async function attachSelectedMap() {
    const pinned = previewedParamsRef.current;
    if (!preview || !pinned) return;
    setUsing(true);
    setError(null);
    try {
      // Replay the EXACT params + seed that produced the shown preview (not live form state),
      // so the attached map is byte-identical to what the DM saw.
      await onUse(pinned);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Couldn't attach the map.";
      setError(message);
      onError?.(message);
    } finally {
      setUsing(false);
    }
  }

  function downloadSvg() {
    if (!preview) return;
    const blob = new Blob([preview.svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Seeds are user-controllable and may contain slashes/colons/control chars; normalize to a
    // filename-safe subset (browser sanitization is inconsistent) before building the name.
    const safeSeed = preview.seed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'map';
    a.download = `${preview.kind}-${safeSeed}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revocation so the browser has reliably started consuming the blob URL before it
    // is invalidated (revoking immediately can make the download flaky in some browsers).
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function copySeed() {
    if (!preview) return;
    // Only flip to "Copied" if the Clipboard API actually exists — otherwise the write is a
    // no-op and claiming success would mislead. The seed stays visible/selectable regardless.
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(preview.seed);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the seed is still visible/selectable in the input */
    }
  }

  const selectStyle: React.CSSProperties = {
    minHeight: 36,
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-divider)',
    background: 'transparent',
    color: 'var(--color-text)',
    fontSize: 13,
    padding: '0 8px',
  };

  return (
    <div
      className="cf-inset"
      data-testid="generate-map-panel"
      style={{ padding: '12px', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span className="card-kicker">Generate a map</span>
        <span className="text-muted" style={{ fontSize: 11 }}>
          first-party, offline & reproducible — preview before you attach
        </span>
      </div>

      {/* Parameters — kind / size / complexity / theme, and an advanced seed. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
        <label className="flex flex-col gap-1 text-muted" style={{ fontSize: 11 }}>
          Kind
          <select
            data-testid="generate-map-kind"
            aria-label="Map kind"
            value={kind}
            disabled={busy}
            onChange={(e) => setKind(e.target.value as MapKind)}
            style={selectStyle}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-muted" style={{ fontSize: 11 }}>
          Size
          <select
            data-testid="generate-map-size"
            aria-label="Map size"
            value={size}
            disabled={busy}
            onChange={(e) => setSize(e.target.value as MapSize)}
            style={selectStyle}
          >
            {SIZES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-muted" style={{ fontSize: 11, minWidth: 130 }}>
          Complexity
          <input
            data-testid="generate-map-complexity"
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={complexity}
            disabled={busy}
            aria-label={`Complexity ${Math.round(complexity * 100)}%`}
            onChange={(e) => setComplexity(Number(e.target.value))}
            style={{ accentColor: 'var(--color-accent)' }}
          />
        </label>
        <label className="flex flex-col gap-1 text-muted" style={{ fontSize: 11 }}>
          Theme
          <select
            data-testid="generate-map-theme"
            aria-label="Map theme"
            value={theme}
            disabled={busy}
            onChange={(e) => setTheme(e.target.value as MapTheme | '')}
            style={selectStyle}
          >
            <option value="">Default</option>
            {THEMES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <button
          type="button"
          className="btn btn-ghost"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((v) => !v)}
          style={{ fontSize: 11, padding: '2px 6px' }}
        >
          {showAdvanced ? '▾' : '▸'} Advanced
        </button>
        {showAdvanced && (
          <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label className="flex flex-col gap-1 text-muted" style={{ fontSize: 11, flex: 1, minWidth: 180 }}>
              Seed (reproducible)
              <input
                data-testid="generate-map-seed"
                type="text"
                value={seed}
                maxLength={64}
                disabled={busy}
                placeholder="auto"
                aria-label="Reproducible seed"
                onChange={(e) => setSeed(e.target.value)}
                style={{ ...selectStyle, width: '100%' }}
              />
            </label>
            <Btn
              ghost
              data-testid="generate-map-copy-seed"
              className="!min-h-0 !py-1.5 text-[11px]"
              disabled={!preview}
              onClick={() => void copySeed()}
              title="Copy the seed to reproduce this map later"
            >
              {copied ? 'Copied' : 'Copy seed'}
            </Btn>
            <Btn
              ghost
              className="!min-h-0 !py-1.5 text-[11px]"
              disabled={busy}
              onClick={() => void runPreview()}
              title="Re-render the preview with the seed above"
            >
              Apply seed
            </Btn>
          </div>
        )}
      </div>

      {/* Large accessible preview — renders the SVG; never attaches or reveals. */}
      <div
        data-testid="generate-map-preview-frame"
        style={{
          position: 'relative',
          border: '1px solid var(--color-divider)',
          borderRadius: 'var(--radius-md)',
          background: 'rgba(15,23,42,.4)',
          minHeight: 180,
          display: 'grid',
          placeItems: 'center',
          overflow: 'hidden',
        }}
      >
        {preview ? (
          <img
            data-testid="generate-map-preview"
            src={svgDataUrl(preview.svg)}
            alt={previewAlt(preview)}
            style={{ maxWidth: '100%', maxHeight: 360, display: 'block' }}
          />
        ) : (
          <span className="text-muted" style={{ fontSize: 12, padding: 24 }} data-testid="generate-map-preview-empty">
            {previewing ? 'Generating a preview…' : 'No preview yet.'}
          </span>
        )}
        {previewing && preview && (
          <div
            role="status"
            aria-live="polite"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              background: 'rgba(15,23,42,.55)',
              fontSize: 12,
              color: '#fff',
            }}
          >
            Rerolling…
          </div>
        )}
      </div>

      {preview && (
        <p className="text-muted" style={{ fontSize: 11, margin: 0 }} data-testid="generate-map-meta">
          {preview.kind} · {preview.widthCells}×{preview.heightCells} squares
          {preview.kind === 'dungeon' ? ` · ${preview.roomCount} rooms` : ''} · seed{' '}
          <code style={{ fontSize: 11 }}>{preview.seed}</code>
        </p>
      )}

      {error && (
        <p role="alert" className="text-rose-400" style={{ fontSize: 12, margin: 0 }} data-testid="generate-map-error">
          {error}
        </p>
      )}

      {/* Actions: reroll, use, download, cancel. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Btn
          data-testid="generate-map-use"
          disabled={!preview || busy}
          onClick={() => void attachSelectedMap()}
        >
          {using ? 'Attaching…' : 'Use this map'}
        </Btn>
        <Btn
          ghost
          data-testid="generate-map-regenerate"
          disabled={busy}
          onClick={regenerate}
          title="Generate a different map (new random seed)"
        >
          {previewing ? 'Generating…' : 'Regenerate'}
        </Btn>
        <Btn
          ghost
          data-testid="generate-map-download"
          className="!min-h-0 !py-1.5 text-[12px]"
          disabled={!preview || busy}
          onClick={downloadSvg}
          title="Download the previewed SVG"
        >
          Download
        </Btn>
        <span style={{ flex: 1 }} />
        {onCancel && (
          <Btn ghost className="!min-h-0 !py-1.5 text-[12px]" disabled={using} onClick={onCancel}>
            Cancel
          </Btn>
        )}
      </div>
    </div>
  );
}
