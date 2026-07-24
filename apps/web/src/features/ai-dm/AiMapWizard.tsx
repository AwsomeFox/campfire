/**
 * Genuine AI map generation wizard (issue #410) — the DM-facing prompt UI for the
 * capability-routed map generator. Composable chips (terrain, encounter type, mood, hazards,
 * landmarks, grid size), a concept-art vs battle-map mode toggle, a cost/readiness preview
 * BEFORE spending, then 2–4 candidates the DM can regenerate/refine and attach. Talks only to
 * the #410 REST surface (POST/GET /campaigns/:id/ai-maps…); generation is orphan-safe (nothing
 * persists until Attach), and every candidate carries an HONEST provenance label.
 */
import { useId, useState } from 'react';
import type {
  AiMapGenerationJob,
  AiMapMode,
  AiMapPreview,
  AiMapReadiness,
} from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Btn, TextArea } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { useDialog } from '../../components/useDialog';
import { useAuth } from '../../app/auth';

/** DM-only entry button; opens the wizard modal. Renders nothing for non-DMs. */
export function AiMapButton({
  campaignId,
  encounterId,
  onAttached,
}: {
  campaignId: number;
  /** When set, "Attach" links the generated map to this encounter (reveal/replace). */
  encounterId?: number;
  onAttached?: (attachmentId: number) => void;
}) {
  const { roleIn } = useAuth();
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  if (roleIn(campaignId) !== 'dm') return null;
  return (
    <>
      <button
        type="button"
        data-testid="ai-map-toggle"
        className="cf-chip"
        style={{ cursor: 'pointer' }}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
      >
        <GameIcon slug="sparkles" size={12} className="inline align-text-bottom mr-1" />AI map
      </button>
      {open && (
        <AiMapModal
          id={dialogId}
          campaignId={campaignId}
          encounterId={encounterId}
          onAttached={onAttached}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Render a candidate as a data-URI image (SVG inline / raster base64) — safe, no DOM inject. */
function previewSrc(p: AiMapPreview): string {
  if (p.svg) return `data:image/svg+xml;utf8,${encodeURIComponent(p.svg)}`;
  if (p.imageBase64) return `data:${p.mime};base64,${p.imageBase64}`;
  return '';
}

function AiMapModal({
  id,
  campaignId,
  encounterId,
  onAttached,
  onClose,
}: {
  id: string;
  campaignId: number;
  encounterId?: number;
  onAttached?: (attachmentId: number) => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<AiMapMode>('battle-map');
  const [terrain, setTerrain] = useState('');
  const [encounterType, setEncounterType] = useState('');
  const [mood, setMood] = useState('');
  const [hazards, setHazards] = useState('');
  const [landmarks, setLandmarks] = useState('');
  const [gridSizeCells, setGridSizeCells] = useState(20);
  const [count, setCount] = useState(2);

  const [readiness, setReadiness] = useState<AiMapReadiness | null>(null);
  const [job, setJob] = useState<AiMapGenerationJob | null>(null);
  const [busy, setBusy] = useState<'idle' | 'readiness' | 'generating' | 'attaching'>('idle');
  const [error, setError] = useState<string | null>(null);

  const titleId = useId();
  const dialogRef = useDialog<HTMLDivElement>({ onClose, disabled: busy !== 'idle', inertBackground: true });

  function buildBody() {
    const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12);
    return {
      prompt: prompt.trim(),
      mode,
      count,
      chips: {
        terrain: terrain.trim() || undefined,
        encounterType: encounterType.trim() || undefined,
        mood: mood.trim() || undefined,
        hazards: list(hazards),
        landmarks: list(landmarks),
        gridSizeCells,
      },
    };
  }

  async function checkReadiness() {
    if (!prompt.trim()) return;
    setBusy('readiness');
    setError(null);
    try {
      const r = await api.post<AiMapReadiness>(`${API}/campaigns/${campaignId}/ai-maps/readiness`, buildBody());
      setReadiness(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't estimate readiness.");
    } finally {
      setBusy('idle');
    }
  }

  async function generate() {
    if (!prompt.trim()) return;
    setBusy('generating');
    setError(null);
    try {
      const j = await api.post<AiMapGenerationJob>(`${API}/campaigns/${campaignId}/ai-maps`, buildBody());
      setJob(j);
      if (j.status === 'failed') setError(j.error ?? 'Generation failed.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't generate maps.");
    } finally {
      setBusy('idle');
    }
  }

  async function regenerate() {
    if (!job) return;
    setBusy('generating');
    setError(null);
    try {
      const j = await api.post<AiMapGenerationJob>(`${API}/campaigns/${campaignId}/ai-maps/${job.id}/refine`, {
        prompt: prompt.trim(),
        chips: buildBody().chips,
        count,
      });
      setJob(j);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't regenerate.");
    } finally {
      setBusy('idle');
    }
  }

  async function attach(preview: AiMapPreview) {
    if (!job) return;
    setBusy('attaching');
    setError(null);
    try {
      const res = await api.post<{ attachment: { id: number } }>(
        `${API}/campaigns/${campaignId}/ai-maps/${job.id}/attach`,
        { previewId: preview.id, ...(encounterId !== undefined ? { encounterId } : {}) },
      );
      onAttached?.(res.attachment.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't attach the map.");
    } finally {
      setBusy('idle');
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'color-mix(in srgb, var(--color-neutral-900) 55%, transparent)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget && busy === 'idle') onClose();
      }}
    >
      <div
        id={id}
        ref={dialogRef}
        className="cf-card w-full max-w-2xl p-5 space-y-3.5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy !== 'idle' || undefined}
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id={titleId} className="flex items-center gap-2 text-base font-extrabold text-white m-0">
            <GameIcon slug="sparkles" size={16} /> Generate a map with AI
          </h2>
          <button
            type="button"
            className="text-slate-500 hover:text-white text-lg leading-none disabled:opacity-50"
            onClick={onClose}
            aria-label="Close AI map dialog"
            disabled={busy !== 'idle'}
          >
            ×
          </button>
        </div>

        {/* Mode: concept art vs battle map */}
        <div className="flex items-center gap-2" role="group" aria-label="Map mode">
          <ModeChip active={mode === 'battle-map'} onClick={() => setMode('battle-map')} label="Battle map" />
          <ModeChip active={mode === 'concept-art'} onClick={() => setMode('concept-art')} label="Concept art" />
        </div>

        <TextArea
          rows={3}
          placeholder="e.g. a fog-drowned crypt with a collapsed altar and two flanking corridors"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={2000}
          disabled={busy !== 'idle'}
        />

        {/* Chips */}
        <div className="grid grid-cols-2 gap-2">
          <ChipInput label="Terrain" value={terrain} onChange={setTerrain} placeholder="dungeon, cave, forest" />
          <ChipInput label="Encounter type" value={encounterType} onChange={setEncounterType} placeholder="ambush, boss" />
          <ChipInput label="Mood" value={mood} onChange={setMood} placeholder="tense, eerie" />
          <ChipInput label="Hazards (comma-sep)" value={hazards} onChange={setHazards} placeholder="pit, lava" />
          <ChipInput label="Landmarks (comma-sep)" value={landmarks} onChange={setLandmarks} placeholder="altar, well" />
          <label className="text-xs text-slate-400 flex flex-col gap-1">
            Grid size (cells)
            <input
              type="number"
              min={4}
              max={60}
              value={gridSizeCells}
              onChange={(e) => setGridSizeCells(Math.max(4, Math.min(60, Number(e.target.value) || 20)))}
              className="cf-input"
            />
          </label>
        </div>

        <div className="flex items-center gap-2.5">
          <span className="text-xs text-slate-400">Previews</span>
          <Btn ghost className="!min-h-0 !py-1 !px-2.5 text-xs" onClick={() => setCount((n) => Math.max(1, n - 1))} disabled={busy !== 'idle' || count <= 1} aria-label="Fewer previews">−</Btn>
          <output className="text-sm text-white min-w-6 text-center tabular-nums">{count}</output>
          <Btn ghost className="!min-h-0 !py-1 !px-2.5 text-xs" onClick={() => setCount((n) => Math.min(4, n + 1))} disabled={busy !== 'idle' || count >= 4} aria-label="More previews">+</Btn>
        </div>

        {/* Cost / readiness before generating */}
        {readiness && (
          <div className="rounded-[var(--radius-md)] border border-white/10 bg-white/5 p-2.5 text-[11px] text-slate-300 space-y-1" data-testid="ai-map-readiness">
            <p className="m-0">
              Method: <strong>{readiness.method}</strong> · cost: {readiness.cost.imageCount} image(s)
              {readiness.capabilities?.imageGeneration === false ? ' · provider is text-only' : ''}
            </p>
            <p className="m-0">
              Grid {readiness.gridLikely ? 'likely' : 'not guaranteed'} · doors {readiness.doorsLikely ? 'likely' : 'unlikely'} · corridors {readiness.corridorsLikely ? 'likely' : 'unlikely'}
            </p>
            {readiness.warnings.map((w, i) => (
              <p key={i} className="m-0 text-amber-300">⚠ {w}</p>
            ))}
            {readiness.moderation.flagged && <p className="m-0 text-rose-300">Prompt blocked by moderation.</p>}
          </div>
        )}

        {error && (
          <div className="rounded-[var(--radius-md)] border border-rose-500/30 bg-rose-500/10 p-2.5">
            <p className="text-xs text-rose-300 m-0 whitespace-pre-wrap">{error}</p>
          </div>
        )}

        {/* Previews */}
        {job && job.previews.length > 0 && (
          <div className="grid grid-cols-2 gap-3" data-testid="ai-map-previews">
            {job.previews.map((p) => (
              <div key={p.id} className="rounded-[var(--radius-md)] border border-white/10 p-2 space-y-1.5">
                <img src={previewSrc(p)} alt={`Candidate ${p.seed}`} className="w-full rounded bg-black/20" style={{ aspectRatio: `${p.width} / ${p.height}` }} />
                <p className="text-[10px] text-slate-400 m-0">{p.provenance.label}</p>
                {p.warnings.map((w, i) => (
                  <p key={i} className="text-[10px] text-amber-300 m-0">⚠ {w}</p>
                ))}
                <Btn className="!min-h-0 !py-1 text-[11px] w-full" onClick={() => void attach(p)} disabled={busy !== 'idle'}>
                  {busy === 'attaching' ? 'Attaching…' : 'Attach (hidden)'}
                </Btn>
              </div>
            ))}
          </div>
        )}

        {job && job.method === 'external-instructions' && (
          <div className="rounded-[var(--radius-md)] border border-white/10 bg-white/5 p-2.5 text-[11px] text-slate-300 space-y-1" data-testid="ai-map-external">
            {job.externalInstructions.map((line, i) => (
              <p key={i} className="m-0">{line}</p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onClose} disabled={busy !== 'idle'}>
            Cancel
          </Btn>
          <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => void checkReadiness()} disabled={busy !== 'idle' || !prompt.trim()}>
            {busy === 'readiness' ? 'Checking…' : 'Check cost/readiness'}
          </Btn>
          {job ? (
            <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => void regenerate()} disabled={busy !== 'idle'}>
              {busy === 'generating' ? 'Working…' : 'Regenerate'}
            </Btn>
          ) : (
            <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => void generate()} disabled={busy !== 'idle' || !prompt.trim()}>
              {busy === 'generating' ? 'Generating…' : `Generate ${count}`}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function ModeChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cf-chip"
      aria-pressed={active}
      style={{ cursor: 'pointer', opacity: active ? 1 : 0.55, fontWeight: active ? 700 : 400 }}
    >
      {label}
    </button>
  );
}

function ChipInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="text-xs text-slate-400 flex flex-col gap-1">
      {label}
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="cf-input" />
    </label>
  );
}
