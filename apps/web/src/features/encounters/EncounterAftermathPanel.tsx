/**
 * Post-encounter aftermath workflow (issue #473): recap draft, outcome review,
 * and hand-off links to loot, XP, quest, and session recap surfaces.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EncounterAftermath } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { Card, Btn, TextArea } from '../../components/ui';
import { CopyControl } from '../../components/CopyControl';
import { storeEncounterAftermathRecap } from './encounterAftermathHandoff';

type Props = {
  campaignId: number;
  encounterId: number;
};

export function EncounterAftermathPanel({ campaignId, encounterId }: Props) {
  const [aftermath, setAftermath] = useState<EncounterAftermath | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<EncounterAftermath>(`${API}/encounters/${encounterId}/aftermath`);
      setAftermath(data);
      setCollapsed(data.dismissedAt != null);
    } catch {
      setError("Couldn't load the aftermath workflow.");
      setAftermath(null);
    } finally {
      setLoading(false);
    }
  }, [encounterId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function dismiss() {
    setDismissing(true);
    try {
      await api.post(`${API}/encounters/${encounterId}/aftermath/dismiss`, {});
      setCollapsed(true);
      setAftermath((prev) => (prev ? { ...prev, dismissedAt: new Date().toISOString() } : prev));
    } catch {
      setError("Couldn't defer the aftermath panel.");
    } finally {
      setDismissing(false);
    }
  }

  function primeRecapNavigation() {
    if (aftermath?.recapDraft) storeEncounterAftermathRecap(campaignId, encounterId, aftermath.recapDraft);
  }

  if (loading) {
    return (
      <Card density="comfortable" aria-labelledby="encounter-aftermath-heading">
        <span id="encounter-aftermath-heading" className="text-sm font-bold text-white">
          Aftermath
        </span>
        <p className="text-xs text-slate-400 m-0">Loading post-encounter hand-offs…</p>
      </Card>
    );
  }

  if (error || !aftermath) {
    return (
      <Card density="comfortable" aria-labelledby="encounter-aftermath-heading">
        <span id="encounter-aftermath-heading" className="text-sm font-bold text-white">
          Aftermath
        </span>
        <p className="text-xs text-rose-400 m-0" role="alert">
          {error ?? "Aftermath isn't available."}
        </p>
      </Card>
    );
  }

  if (collapsed) {
    return (
      <Card density="comfortable" className="space-y-2" aria-labelledby="encounter-aftermath-heading">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 id="encounter-aftermath-heading" className="text-sm font-bold text-white m-0">
            Aftermath
          </h2>
          <Btn type="button" className="btn btn-secondary min-h-9" onClick={() => setCollapsed(false)}>
            Show aftermath
          </Btn>
        </div>
        <p className="text-xs text-slate-400 m-0">Deferred — reopen when you are ready to distribute loot, award XP, or draft the recap.</p>
      </Card>
    );
  }

  const { outcome, handoffs, xp } = aftermath;
  const gridCols = handoffs.questPath && handoffs.sessionPath ? 'sm:grid-cols-2 lg:grid-cols-3' : handoffs.questPath || handoffs.sessionPath ? 'sm:grid-cols-2' : 'sm:grid-cols-2';

  return (
    <Card density="comfortable" className="space-y-4" role="region" aria-label="Aftermath" aria-labelledby="encounter-aftermath-heading">
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <h2 id="encounter-aftermath-heading" className="text-sm font-bold text-white m-0">
            Aftermath
          </h2>
          <Btn
            type="button"
            className="btn btn-ghost min-h-9 text-xs"
            onClick={() => void dismiss()}
            disabled={dismissing}
          >
            {dismissing ? 'Saving…' : 'Remind me later'}
          </Btn>
        </div>
        <p className="text-xs text-slate-400 m-0">
          Review the fight, then hand off loot, XP, quest updates, and a recap draft while it is still fresh.
        </p>
      </div>

      <section aria-labelledby="encounter-aftermath-outcome-heading" className="space-y-2">
        <h3 id="encounter-aftermath-outcome-heading" className="text-xs font-bold uppercase tracking-wide text-slate-400 m-0">
          Outcome
        </h3>
        <div className="flex gap-4 flex-wrap text-[13px]">
          <span>
            Rounds: <b>{outcome.rounds}</b>
          </span>
          <span>
            Dead: <b>{outcome.dead.length}</b>
            {outcome.dead.length > 0 && (
              <span className="text-muted"> ({outcome.dead.map((c) => c.name).join(', ')})</span>
            )}
          </span>
          <span>
            Downed: <b>{outcome.downed.length}</b>
            {outcome.downed.length > 0 && (
              <span className="text-muted"> ({outcome.downed.map((c) => c.name).join(', ')})</span>
            )}
          </span>
          <span>
            Survivors: <b>{outcome.survivors.length}</b>
          </span>
        </div>
        {xp.supported && xp.suggestedPerCharacter != null && (
          <p className="text-xs text-slate-400 m-0">
            Suggested award: <b>{xp.suggestedPerCharacter} XP</b> each ({xp.difficultyLabel},{' '}
            {xp.suggestedPartyTotal} adjusted total).
          </p>
        )}
        {!xp.supported && (
          <p className="text-xs text-slate-400 m-0">XP guidance: {xp.difficultyLabel} — award manually for this ruleset.</p>
        )}
      </section>

      <section aria-labelledby="encounter-aftermath-recap-heading" className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 id="encounter-aftermath-recap-heading" className="text-xs font-bold uppercase tracking-wide text-slate-400 m-0">
            Recap draft
          </h3>
          <CopyControl value={aftermath.recapDraft} label="Copy recap draft" />
        </div>
        <TextArea
          readOnly
          value={aftermath.recapDraft}
          rows={8}
          className="font-mono text-xs min-h-[8rem]"
          aria-label="Recap draft seeded from this encounter"
        />
        <p className="text-[11px] text-muted m-0">
          Opens the session recap editor with this draft pre-filled.{' '}
          <Link to={handoffs.encounterLogPath} className="link-button">
            View combat log
          </Link>
        </p>
      </section>

      <nav aria-label="Post-encounter hand-offs" className={`grid grid-cols-1 gap-2 ${gridCols}`}>
        <Link
          to={handoffs.recapPath}
          onClick={primeRecapNavigation}
          className="btn btn-primary min-w-0 min-h-11 flex-col !items-start text-left"
        >
          <span className="font-semibold">Write recap</span>
          <span className="text-[11px] text-muted font-normal">Open the recap editor with this draft.</span>
        </Link>
        <Link to={handoffs.awardXpPath} className="btn btn-secondary min-w-0 min-h-11 flex-col !items-start text-left">
          <span className="font-semibold">Award XP</span>
          <span className="text-[11px] text-muted font-normal">
            {xp.suggestedPerCharacter != null
              ? `Open the party XP form (${xp.suggestedPerCharacter} each suggested).`
              : 'Open the party XP form.'}
          </span>
        </Link>
        <Link to={handoffs.inventoryPath} className="btn btn-secondary min-w-0 min-h-11 flex-col !items-start text-left">
          <span className="font-semibold">Distribute loot</span>
          <span className="text-[11px] text-muted font-normal">Party treasury and inventory.</span>
        </Link>
        {handoffs.questPath && (
          <Link to={handoffs.questPath} className="btn btn-secondary min-w-0 min-h-11 flex-col !items-start text-left">
            <span className="font-semibold">Update quest</span>
            <span className="text-[11px] text-muted font-normal">Open the linked quest objectives.</span>
          </Link>
        )}
        {handoffs.sessionPath && (
          <Link to={handoffs.sessionPath} className="btn btn-secondary min-w-0 min-h-11 flex-col !items-start text-left">
            <span className="font-semibold">Open linked session</span>
            <span className="text-[11px] text-muted font-normal">Review session details and recap.</span>
          </Link>
        )}
      </nav>
    </Card>
  );
}
