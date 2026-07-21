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
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CoDmDraftResult, CoDmDraftTarget } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useAiDmSeat } from '../../lib/query';
import { Btn, TextArea } from '../../components/ui';

/** Targets that support drafting N items at once (mirrors CoDmService's MULTI_TARGETS). */
const MULTI_TARGETS = new Set<CoDmDraftTarget>(['npc', 'location', 'beat']);

const TARGET_NOUN: Record<CoDmDraftTarget, string> = {
  npc: 'NPC',
  location: 'location',
  beat: 'story beat',
  recap: 'session recap',
  encounter: 'encounter',
  map: 'map',
};

const TARGET_PLACEHOLDER: Record<CoDmDraftTarget, string> = {
  npc: 'e.g. a shady fence with a soft spot for stray cats, tied to the thieves guild',
  location: 'e.g. a half-flooded shrine the locals avoid after dark',
  beat: 'e.g. the next story beat once the party learns the mayor is a doppelganger',
  recap: 'e.g. summarize tonight: the ambush at the bridge, losing Kira, the truce offer',
  encounter: 'e.g. a level-3 ambush on a forest road, bandits with a hidden archer',
  map: 'e.g. a small smugglers’ cave with a tidal chamber',
};

/**
 * DM-only "Draft with AI" button for a given proposal target. Renders nothing for
 * non-DMs or when the seat is off/disabled — this is a convenience gate; the server
 * re-enforces role + experimental flag + seat + budget on every request regardless.
 */
export function DraftWithAiButton({
  campaignId,
  target,
  label = 'Draft with AI',
  className = '!min-h-0 !py-1.5 text-xs',
}: {
  campaignId: number;
  target: CoDmDraftTarget;
  label?: string;
  className?: string;
}) {
  const { roleIn } = useAuth();
  const isDm = roleIn(campaignId) === 'dm';
  const { data: seat } = useAiDmSeat(isDm ? campaignId : undefined);
  const [open, setOpen] = useState(false);

  if (!isDm || !seat || seat.mode === 'off' || !seat.enabled) return null;

  return (
    <>
      <Btn ghost className={className} onClick={() => setOpen(true)}>
        ✨ {label}
      </Btn>
      {open && <DraftWithAiModal campaignId={campaignId} target={target} onClose={() => setOpen(false)} />}
    </>
  );
}

function DraftWithAiModal({
  campaignId,
  target,
  onClose,
}: {
  campaignId: number;
  target: CoDmDraftTarget;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorIsForbidden, setErrorIsForbidden] = useState(false);
  const [result, setResult] = useState<CoDmDraftResult | null>(null);

  const multi = MULTI_TARGETS.has(target);
  const noun = TARGET_NOUN[target];

  async function submit() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    setErrorIsForbidden(false);
    try {
      const body: Record<string, unknown> = { target, prompt: prompt.trim() };
      if (multi) body.count = count;
      const draft = await api.post<CoDmDraftResult>(`${API}/campaigns/${campaignId}/ai-dm/draft`, body);
      setResult(draft);
    } catch (err) {
      if (err instanceof ApiError) {
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
      onClick={onClose}
    >
      <div
        className="cf-card w-full max-w-lg p-5 space-y-3.5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Draft ${noun} with AI`}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-extrabold text-white m-0">✨ Draft a {noun} with AI</h2>
            <p className="text-muted text-xs m-0 mt-1">
              Describe what you want — the AI DM drafts it and files {multi ? 'pending proposals' : 'a pending proposal'} for
              your review. Nothing touches canon until you approve.
            </p>
          </div>
          <button type="button" className="text-slate-500 hover:text-white text-lg leading-none" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {result ? (
          <DraftResultCard campaignId={campaignId} result={result} onClose={onClose} />
        ) : (
          <>
            <TextArea
              autoFocus
              rows={4}
              placeholder={TARGET_PLACEHOLDER[target]}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={20_000}
              disabled={busy}
            />

            {multi && (
              <div className="flex items-center gap-2.5">
                <span className="text-xs text-slate-400">How many?</span>
                <div className="flex items-center gap-1.5">
                  <Btn
                    ghost
                    className="!min-h-0 !py-1 !px-2.5 text-xs"
                    onClick={() => setCount((n) => Math.max(1, n - 1))}
                    disabled={busy || count <= 1}
                  >
                    −
                  </Btn>
                  <span className="text-sm text-white w-6 text-center tabular-nums">{count}</span>
                  <Btn
                    ghost
                    className="!min-h-0 !py-1 !px-2.5 text-xs"
                    onClick={() => setCount((n) => Math.min(10, n + 1))}
                    disabled={busy || count >= 10}
                  >
                    +
                  </Btn>
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-[var(--radius-md)] border border-rose-500/30 bg-rose-500/10 p-2.5 space-y-1.5">
                <p className="text-xs text-rose-300 m-0 whitespace-pre-wrap">{error}</p>
                {errorIsForbidden && (
                  <Link to={`/c/${campaignId}/settings`} className="text-[11px] text-purple-400 hover:underline">
                    Open AI DM settings →
                  </Link>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onClose} disabled={busy}>
                Cancel
              </Btn>
              <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => void submit()} disabled={busy || !prompt.trim()}>
                {busy ? 'Drafting…' : `Draft ${multi && count > 1 ? `${count} ${noun}s` : noun}`}
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
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onClose}>
          Close
        </Btn>
        <Link to={`/c/${campaignId}/proposals`} className="cf-btn !min-h-0 !py-1.5 text-xs no-underline">
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
