/**
 * AI portrait generation wizard (issue #1321) — the prompt UI for the capability-routed portrait
 * generator. A DM or owning player composes a brief (pre-filled from entity fields), previews the
 * cost/readiness before spending, then generates 1–4 square candidates and attaches the chosen one.
 * Talks only to the #1321 REST surface (POST/GET /campaigns/:id/ai-portraits…); generation is
 * orphan-safe (nothing persists until Attach), and every candidate carries an HONEST provenance
 * label. With no image-capable provider, the wizard shows concrete external-generator steps.
 */
import { useId, useState } from 'react';
import type {
  AiPortraitGenerationJob,
  AiPortraitPreview,
  AiPortraitReadiness,
  AiPortraitStyle,
} from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Btn, TextArea } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { UIIcon } from '../../components/UIIcon';
import { useDialog } from '../../components/useDialog';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

export type PortraitEntityTarget = { type: 'character' | 'npc' | 'faction' | 'location'; id: number };

/**
 * Entry button; opens the wizard modal. Visible only when the caller passes a target (and the host
 * page has already gated visibility by edit authority). Unlike the DM-only AI map button this is
 * member-scoped — a player may generate/attach a portrait for their OWN character.
 */
export function AiPortraitButton({
  campaignId,
  target,
  initialPrompt,
  onAttached,
}: {
  campaignId: number;
  target: PortraitEntityTarget;
  initialPrompt?: string;
  onAttached?: (attachmentId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  return (
    <>
      <button
        type="button"
        data-testid="ai-portrait-toggle"
        className="cf-chip"
        style={{ cursor: 'pointer' }}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
      >
        <GameIcon slug="sparkles" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />AI image
      </button>
      {open && (
        <AiPortraitModal
          id={dialogId}
          campaignId={campaignId}
          target={target}
          initialPrompt={initialPrompt}
          onAttached={onAttached}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Render a candidate as a base64 data-URI image — safe, no DOM inject. */
function previewSrc(p: AiPortraitPreview): string {
  if (p.imageBase64) return `data:${p.mime};base64,${p.imageBase64}`;
  return '';
}

function AiPortraitModal({
  id,
  campaignId,
  target,
  initialPrompt = '',
  onAttached,
  onClose,
}: {
  id: string;
  campaignId: number;
  target: PortraitEntityTarget;
  initialPrompt?: string;
  onAttached?: (attachmentId: number) => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [style, setStyle] = useState<AiPortraitStyle>('illustration');
  const [count, setCount] = useState(2);

  const [readiness, setReadiness] = useState<AiPortraitReadiness | null>(null);
  const [job, setJob] = useState<AiPortraitGenerationJob | null>(null);
  const [busy, setBusy] = useState<'idle' | 'readiness' | 'generating' | 'attaching'>('idle');
  const [error, setError] = useState<string | null>(null);

  const titleId = useId();
  const dialogRef = useDialog<HTMLDivElement>({ onClose, disabled: busy !== 'idle', inertBackground: true });

  function buildBody() {
    return {
      prompt: prompt.trim(),
      count,
      style,
      entityType: target.type,
      entityId: target.id,
    };
  }

  async function checkReadiness() {
    if (!prompt.trim()) return;
    setBusy('readiness');
    setError(null);
    try {
      const r = await api.post<AiPortraitReadiness>(`${API}/campaigns/${campaignId}/ai-portraits/readiness`, buildBody());
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
      const j = await api.post<AiPortraitGenerationJob>(`${API}/campaigns/${campaignId}/ai-portraits`, buildBody());
      setJob(j);
      if (j.status === 'failed') setError(j.error ?? 'Generation failed.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't generate portraits.");
    } finally {
      setBusy('idle');
    }
  }

  async function regenerate() {
    if (!job) return;
    setBusy('generating');
    setError(null);
    try {
      const j = await api.post<AiPortraitGenerationJob>(`${API}/campaigns/${campaignId}/ai-portraits/${job.id}/refine`, {
        prompt: prompt.trim(),
        count,
      });
      setJob(j);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't regenerate.");
    } finally {
      setBusy('idle');
    }
  }

  async function attach(preview: AiPortraitPreview) {
    if (!job) return;
    setBusy('attaching');
    setError(null);
    try {
      const res = await api.post<{ attachment: { id: number } }>(
        `${API}/campaigns/${campaignId}/ai-portraits/${job.id}/attach`,
        { previewId: preview.id, entityType: target.type, entityId: target.id },
      );
      onAttached?.(res.attachment.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't attach the portrait.");
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
        className="cf-card cf-density-default w-full max-w-2xl space-y-3.5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy !== 'idle' || undefined}
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id={titleId} className="flex items-center gap-2 text-base font-extrabold text-white m-0">
            <GameIcon slug="sparkles" size={UI_ICON_SIZE.sm} /> Generate a portrait with AI
          </h2>
          <button
            type="button"
            className="text-secondary hover:text-white leading-none disabled:opacity-50"
            onClick={onClose}
            aria-label="Close AI portrait dialog"
            disabled={busy !== 'idle'}
          >
            <UIIcon name="close" size="sm" />
          </button>
        </div>

        {/* Style preset */}
        <div className="flex items-center gap-2" role="group" aria-label="Portrait style">
          <StyleChip active={style === 'illustration'} onClick={() => setStyle('illustration')} label="Illustration" />
          <StyleChip active={style === 'realistic'} onClick={() => setStyle('realistic')} label="Realistic" />
          <StyleChip active={style === 'painterly'} onClick={() => setStyle('painterly')} label="Painterly" />
        </div>

        <TextArea
          rows={3}
          placeholder="e.g. a weathered human ranger with a scarred cheek, dark green hood, and a short beard"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={2000}
          disabled={busy !== 'idle'}
        />

        <div className="flex items-center gap-2.5">
          <span className="text-xs text-slate-400">Previews</span>
          <Btn density="xs" ghost className="!px-2.5 text-xs" onClick={() => setCount((n) => Math.max(1, n - 1))} disabled={busy !== 'idle' || count <= 1} aria-label="Fewer previews">−</Btn>
          <output className="text-sm text-white min-w-6 text-center tabular-nums">{count}</output>
          <Btn density="xs" ghost className="!px-2.5 text-xs" onClick={() => setCount((n) => Math.min(4, n + 1))} disabled={busy !== 'idle' || count >= 4} aria-label="More previews">+</Btn>
        </div>

        {/* Cost / readiness before generating */}
        {readiness && (
          <div className="rounded-[var(--radius-md)] border border-white/10 bg-white/5 p-2.5 text-[11px] text-slate-300 space-y-1" data-testid="ai-portrait-readiness">
            <p className="m-0">
              Method: <strong>{readiness.method}</strong> · cost: {readiness.cost.imageCount} image(s)
              {readiness.capabilities?.imageGeneration === false ? ' · provider is text-only' : ''}
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
          <div className="grid grid-cols-2 gap-3" data-testid="ai-portrait-previews">
            {job.previews.map((p) => (
              <div key={p.id} className="rounded-[var(--radius-md)] border border-white/10 p-2 space-y-1.5">
                <img src={previewSrc(p)} alt={`Candidate ${p.seed}`} className="w-full rounded bg-black/20" style={{ aspectRatio: `${p.width} / ${p.height}` }} />
                <p className="text-[10px] text-slate-400 m-0">{p.provenance.label}</p>
                {p.warnings.map((w, i) => (
                  <p key={i} className="text-[10px] text-amber-300 m-0">⚠ {w}</p>
                ))}
                <Btn density="xs" className="text-[11px] w-full" onClick={() => void attach(p)} disabled={busy !== 'idle'}>
                  {busy === 'attaching' ? 'Attaching…' : 'Attach portrait'}
                </Btn>
              </div>
            ))}
          </div>
        )}

        {job && job.method === 'external-instructions' && (
          <div className="rounded-[var(--radius-md)] border border-white/10 bg-white/5 p-2.5 text-[11px] text-slate-300 space-y-1" data-testid="ai-portrait-external">
            {job.externalInstructions.map((line, i) => (
              <p key={i} className="m-0">{line}</p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Btn density="xs" ghost className="text-xs" onClick={onClose} disabled={busy !== 'idle'}>
            Cancel
          </Btn>
          <Btn density="xs" ghost className="text-xs" onClick={() => void checkReadiness()} disabled={busy !== 'idle' || !prompt.trim()}>
            {busy === 'readiness' ? 'Checking…' : 'Check cost/readiness'}
          </Btn>
          {job ? (
            <Btn density="xs" className="text-xs" onClick={() => void regenerate()} disabled={busy !== 'idle'}>
              {busy === 'generating' ? 'Working…' : 'Regenerate'}
            </Btn>
          ) : (
            <Btn density="xs" className="text-xs" onClick={() => void generate()} disabled={busy !== 'idle' || !prompt.trim()}>
              {busy === 'generating' ? 'Generating…' : `Generate ${count}`}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function StyleChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
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

export { AiPortraitModal };
