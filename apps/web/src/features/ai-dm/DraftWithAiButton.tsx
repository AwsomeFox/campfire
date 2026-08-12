/**
 * "Draft with AI" entry point (issue #341) — a small button + modal that any authoring
 * surface (NPCs, locations, quests/beats, sessions/recaps, encounters, the map surface)
 * can drop in to invoke the co-DM draft endpoint (#313): POST /campaigns/:id/ai-dm/draft
 * asks the configured provider for structured content and files it as PENDING PROPOSAL(S)
 * — nothing writes to canon directly. The DM reviews/approves in the normal queue
 * (features/proposals/ProposalsPage.tsx), where AI-authored proposals carry a distinct
 * "drafted by AI" badge (issue #341's other half).
 *
 * Self-gates so callers don't have to duplicate the check: renders nothing unless the
 * caller is DM in this campaign AND the AI-DM seat is enabled with mode co_dm or driver
 * (mirrors the server's gate in CoDmService — off/disabled/player is a silent no-op here,
 * the 403 path below is for budget-exhausted or flag-disabled edge cases that slip past
 * a stale seat read).
 */
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CoDmDraftResult, CoDmDraftTarget } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Btn, TextArea } from '../../components/ui';
import type { UiDensity } from '../../components/density';
import { isKnownAiGate } from './aiGate';
import { AiGateExplainer } from './AiSetupChecklist';
import { GameIcon } from '../../components/GameIcon';
import { UIIcon } from '../../components/UIIcon';
import { useDialog } from '../../components/useDialog';
import { useDraftWithAiAvailable } from './useDraftWithAiAvailable';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

/** Targets that support drafting N items at once (mirrors CoDmService's MULTI_TARGETS). */
const MULTI_TARGETS = new Set<CoDmDraftTarget>(['npc', 'location', 'beat', 'quest', 'faction', 'timeline_event']);

const TARGET_NOUN: Record<CoDmDraftTarget, string> = {
  npc: 'NPC',
  location: 'location',
  arc: 'story arc',
  beat: 'story beat',
  recap: 'session recap',
  encounter: 'encounter',
  map: 'map',
  quest: 'quest',
  faction: 'faction',
  timeline_event: 'timeline event',
};

const TARGET_PLURAL: Record<CoDmDraftTarget, string> = {
  npc: 'NPCs',
  location: 'locations',
  arc: 'story arcs',
  beat: 'story beats',
  recap: 'session recaps',
  encounter: 'encounters',
  map: 'maps',
  quest: 'quests',
  faction: 'factions',
  timeline_event: 'timeline events',
};

const TARGET_TITLE: Record<CoDmDraftTarget, string> = {
  npc: 'Draft an NPC with AI',
  location: 'Draft a location with AI',
  arc: 'Edit a story arc with AI',
  beat: 'Draft a story beat with AI',
  recap: 'Draft a session recap with AI',
  encounter: 'Draft an encounter with AI',
  map: 'Draft a map with AI',
  quest: 'Draft a quest with AI',
  faction: 'Draft a faction with AI',
  timeline_event: 'Draft a timeline event with AI',
};

const TARGET_EXAMPLE: Record<CoDmDraftTarget, string> = {
  npc: 'a shady fence with a soft spot for stray cats, tied to the thieves guild',
  location: 'a half-flooded shrine the locals avoid after dark',
  arc: 'make the central mystery more urgent and tighten the summary',
  beat: 'the next story beat once the party learns the mayor is a doppelganger',
  recap: 'summarize tonight: the ambush at the bridge, losing Kira, the truce offer',
  encounter: 'a level-3 ambush on a forest road, bandits with a hidden archer',
  map: "a small smugglers' cave with a tidal chamber",
  quest: "retrieve the stolen relic from the bandits' hideout before the full moon",
  faction: 'a merchant guild that secretly controls the city council through debts',
  timeline_event: 'a major battle in 1492 DR where the ancient alliance was broken',
};

/**
 * DM-only "Draft with AI" button for a given proposal target. Renders nothing for
 * non-DMs or when the seat is off/disabled — this is a convenience gate; the server
 * re-enforces role + experimental flag + seat + budget on every request regardless.
 *
 * Controlled `open` / `onOpenChange` + `showTrigger={false}` let PageHeader (#707)
 * open the same dialog from an overflow menuitem without a second trigger.
 */
export function DraftWithAiButton({
  campaignId,
  target,
  label = 'Draft with AI',
  className = 'text-xs',
  // Issue #1692 review (Codex): this trigger is shared across both dense per-row
  // contexts (an arc card's own "Draft beat with AI") AND header/page-level triggers
  // that are sometimes someone's SOLE way to reach the function (StorylinesPage's
  // empty-state header button) — the UiDensity contract explicitly forbids xs for
  // the latter. Default to compact (safe everywhere); callers in a genuinely dense
  // row opt into xs explicitly instead of it being baked in for everyone.
  density = 'compact',
  arcId,
  entityId,
  currentContent,
  disabled = false,
  disabledTitle,
  open: openProp,
  onOpenChange,
  showTrigger = true,
  dialogId: dialogIdProp,
}: {
  campaignId: number;
  target: CoDmDraftTarget;
  label?: string;
  className?: string;
  density?: UiDensity;
  /** When target is `beat`, pin drafted beat(s) to this arc (#1307). */
  arcId?: number;
  /** Existing arc/beat id to rewrite through an update proposal (#1311). */
  entityId?: number;
  /** Current content shown read-only in the rewrite dialog; the server reloads authority. */
  currentContent?: { title: string; prose: string };
  disabled?: boolean;
  disabledTitle?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** When false, only the dialog mounts (caller owns the trigger). */
  showTrigger?: boolean;
  /** Stable id shared with an external PageHeader trigger (issue #707). */
  dialogId?: string;
}) {
  const available = useDraftWithAiAvailable(campaignId);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = openProp !== undefined && onOpenChange !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const setOpen = isControlled ? onOpenChange : setUncontrolledOpen;
  const generatedDialogId = useId();
  const dialogId = dialogIdProp ?? generatedDialogId;

  if (!available) return null;

  return (
    <>
      {showTrigger && (
        <Btn
          ghost
          density={density}
          className={`${className}${disabled ? ' opacity-50 cursor-not-allowed' : ''}`}
          onClick={() => {
            if (disabled) return;
            setOpen(true);
          }}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={dialogId}
          aria-disabled={disabled || undefined}
          title={disabled ? disabledTitle : undefined}
        >
          <GameIcon slug="sparkles" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />{label}
        </Btn>
      )}
      {open && (
        <DraftWithAiModal
          id={dialogId}
          campaignId={campaignId}
          target={target}
          arcId={arcId}
          entityId={entityId}
          currentContent={currentContent}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function DraftWithAiModal({
  id,
  campaignId,
  target,
  arcId,
  entityId,
  currentContent,
  onClose,
}: {
  id: string;
  campaignId: number;
  target: CoDmDraftTarget;
  arcId?: number;
  entityId?: number;
  currentContent?: { title: string; prose: string };
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [includeCampaignSecrets, setIncludeCampaignSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorIsForbidden, setErrorIsForbidden] = useState(false);
  // The raw error, so a known AI gate renders the shared explainer + precise deep link
  // (aiGate.ts / #343) instead of a bare 403 string.
  const [gateErr, setGateErr] = useState<unknown>(null);
  const [result, setResult] = useState<CoDmDraftResult | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const promptId = useId();
  const promptHelpId = useId();
  const quantityLabelId = useId();
  const quantityValueId = useId();

  const editing = entityId != null;
  const multi = !editing && MULTI_TARGETS.has(target);
  const noun = TARGET_NOUN[target];
  const plural = TARGET_PLURAL[target];
  const dialogRef = useDialog<HTMLDivElement>({
    onClose,
    disabled: busy,
    initialFocusRef: promptRef,
    inertBackground: true,
  });

  async function submit() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    setErrorIsForbidden(false);
    setGateErr(null);
    try {
      const body: Record<string, unknown> = { target, prompt: prompt.trim() };
      if (multi) body.count = count;
      if (target === 'beat' && arcId != null) body.arcId = arcId;
      if (entityId != null) body.entityId = entityId;
      if (editing) body.includeCampaignSecrets = includeCampaignSecrets;
      const draft = await api.post<CoDmDraftResult>(`${API}/campaigns/${campaignId}/ai-dm/draft`, body);
      setResult(draft);
    } catch (err) {
      if (isKnownAiGate(err)) {
        setGateErr(err);
      } else if (err instanceof ApiError) {
        setError(err.message);
        setErrorIsForbidden(err.status === 403);
      } else {
        setError("Couldn't reach the AI DM.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'color-mix(in srgb, var(--color-neutral-900) 55%, transparent)' }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        id={id}
        ref={dialogRef}
        className="cf-card cf-density-default w-full max-w-lg space-y-3.5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 id={titleId} className="flex items-center gap-2 text-base font-extrabold text-white m-0">
              <GameIcon slug="sparkles" size={UI_ICON_SIZE.sm} /> {editing ? `Edit ${noun} with AI` : TARGET_TITLE[target]}
            </h2>
            <p id={descriptionId} className="text-muted text-xs m-0 mt-1">
              {editing
                ? 'Add rewrite instructions. The AI DM receives the current storyline context and files an update proposal against this same entity. Nothing touches canon until you approve.'
                : <>Describe what you want — the AI DM drafts it and files {multi ? 'pending proposals' : 'a pending proposal'} for your review. Nothing touches canon until you approve.</>}
            </p>
          </div>
          <button
            type="button"
            className="text-secondary hover:text-white leading-none disabled:opacity-50"
            onClick={onClose}
            aria-label={editing ? 'Close AI editing dialog' : 'Close AI drafting dialog'}
            disabled={busy}
          >
            <UIIcon name="close" size="sm" />
          </button>
        </div>

        {result ? (
          <DraftResultCard campaignId={campaignId} result={result} onClose={onClose} />
        ) : (
          <>
            {editing && currentContent && (
              <fieldset className="space-y-1.5" disabled={busy}>
                <legend className="text-xs font-semibold text-slate-300">Current content</legend>
                <label className="block text-[11px] text-slate-400" htmlFor={`${promptId}-current-title`}>Title</label>
                <input
                  id={`${promptId}-current-title`}
                  className="input"
                  value={currentContent.title}
                  readOnly
                />
                <label className="block text-[11px] text-slate-400" htmlFor={`${promptId}-current-prose`}>
                  {target === 'arc' ? 'Summary' : 'Body'}
                </label>
                <TextArea
                  id={`${promptId}-current-prose`}
                  rows={3}
                  value={currentContent.prose}
                  readOnly
                />
              </fieldset>
            )}
            <div className="space-y-1.5">
              <label htmlFor={promptId} className="block text-xs font-semibold text-slate-300">
                {editing ? 'Rewrite instructions' : `Describe the ${noun} you want to draft`}
              </label>
              <TextArea
                id={promptId}
                ref={promptRef}
                rows={4}
                placeholder={`e.g. ${TARGET_EXAMPLE[target]}`}
                aria-describedby={promptHelpId}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                maxLength={20_000}
                disabled={busy}
              />
              <p id={promptHelpId} className="text-[11px] text-slate-400 m-0">
                {editing ? 'Explain what to preserve and what to change.' : 'Include the details, tone, and connections the AI should use.'} Example: {TARGET_EXAMPLE[target]}
              </p>
            </div>

            {editing && (
              <label className="flex items-start gap-2 rounded-[var(--radius-md)] border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-slate-300">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={includeCampaignSecrets}
                  onChange={(event) => setIncludeCampaignSecrets(event.target.checked)}
                  disabled={busy}
                />
                <span>
                  Include the current DM-only storyline prep in this AI request. It may be sent to the configured external provider.
                </span>
              </label>
            )}

            {multi && (
              <div className="flex items-center gap-2.5" role="group" aria-labelledby={quantityLabelId}>
                <span id={quantityLabelId} className="text-xs text-slate-400">Number of {plural}</span>
                <div className="flex items-center gap-1.5">
                  <Btn density="xs"
                    ghost
                    className="!px-2.5 text-xs"
                    onClick={() => setCount((n) => Math.max(1, n - 1))}
                    disabled={busy || count <= 1}
                    aria-label={`Decrease number of ${plural}`}
                    aria-describedby={quantityValueId}
                  >
                    −
                  </Btn>
                  <output
                    id={quantityValueId}
                    className="text-sm text-white min-w-6 text-center tabular-nums"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    {count}<span className="sr-only"> {count === 1 ? noun : plural}</span>
                  </output>
                  <Btn density="xs"
                    ghost
                    className="!px-2.5 text-xs"
                    onClick={() => setCount((n) => Math.min(10, n + 1))}
                    disabled={busy || count >= 10}
                    aria-label={`Increase number of ${plural}`}
                    aria-describedby={quantityValueId}
                  >
                    +
                  </Btn>
                </div>
              </div>
            )}

            {gateErr != null && (
              <div className="rounded-[var(--radius-md)] border border-rose-500/30 bg-rose-500/10 p-2.5">
                <AiGateExplainer err={gateErr} campaignId={campaignId} />
              </div>
            )}
            {error && (
              <div className="rounded-[var(--radius-md)] border border-rose-500/30 bg-rose-500/10 p-2.5 space-y-1.5">
                <p className="text-xs text-rose-300 m-0 whitespace-pre-wrap">{error}</p>
                {errorIsForbidden && (
                  <Link to={`/c/${campaignId}/settings#ai-dm`} className="text-[11px] text-purple-400 hover:underline">
                    Open AI DM settings →
                  </Link>
                )}
              </div>
            )}

            {/* compact, not xs (issue #1692 review — Codex): this dialog's Cancel/
                Draft pair is its only submission control, not a dense inline row. */}
            <div className="flex items-center justify-end gap-2">
              <Btn density="compact" ghost className="text-xs" onClick={onClose} disabled={busy}>
                Cancel
              </Btn>
              <Btn density="compact" className="text-xs" onClick={() => void submit()} disabled={busy || !prompt.trim() || (editing && !includeCampaignSecrets)}>
                {busy ? (editing ? 'Rewriting…' : 'Drafting…') : editing ? 'File rewrite proposal' : `Draft ${multi && count > 1 ? `${count} ${noun}s` : noun}`}
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DraftResultCard({
  campaignId,
  result,
  onClose,
}: {
  campaignId: number;
  result: CoDmDraftResult;
  onClose: () => void;
}) {
  const count = result.proposalIds.length;
  return (
    <div className="space-y-2.5">
      <div className="rounded-[var(--radius-md)] border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-1">
        <p className="text-sm text-emerald-300 m-0 font-semibold">
          {count === 0
            ? 'No proposals were filed.'
            : `Filed ${count} pending ${count === 1 ? 'proposal' : 'proposals'} for review.`}
        </p>
        <p className="text-[11px] text-slate-400 m-0">
          {result.tokensUsed} tokens used · {result.budgetRemaining} remaining · via {result.provider}
          {result.model ? ` (${result.model})` : ''}
        </p>
      </div>
      {count > 0 && (
        <ul className="space-y-1 max-h-40 overflow-y-auto">
          {result.proposals.map((p) => (
            <li key={p.id} className="text-xs text-slate-300 truncate">
              · {proposalLabel(p.entityType, p.payload)}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-end gap-2">
        <Btn density="xs" ghost className="text-xs" onClick={onClose}>
          Close
        </Btn>
        <Link to={`/c/${campaignId}/proposals`} className="cf-btn cf-density-compact text-xs no-underline">
          Review in proposals →
        </Link>
      </div>
    </div>
  );
}

function proposalLabel(entityType: string, payload: Record<string, unknown>): string {
  const name = typeof payload.name === 'string' ? payload.name : typeof payload.title === 'string' ? payload.title : null;
  return name ? `${entityType}: ${name}` : entityType;
}
