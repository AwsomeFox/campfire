/**
 * Post-encounter aftermath workflow (issue #473): recap draft, outcome review,
 * and hand-off links to loot, XP, quest, and session recap surfaces.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { EncounterAftermath } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { Card, Btn, TextArea } from '../../components/ui';
import { CopyControl } from '../../components/CopyControl';
import { storeEncounterAftermathRecap } from './encounterAftermathHandoff';

type Props = {
  campaignId: number;
  encounterId: number;
};

export function EncounterAftermathPanel({ campaignId, encounterId }: Props) {
  const { t } = useTranslation();
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
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.loadAftermath' }));
      setAftermath(null);
    } finally {
      setLoading(false);
    }
  }, [encounterId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function dismiss() {
    setDismissing(true);
    try {
      await api.post(`${API}/encounters/${encounterId}/aftermath/dismiss`, {});
      setCollapsed(true);
      setAftermath((prev) => (prev ? { ...prev, dismissedAt: new Date().toISOString() } : prev));
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.dismissAftermath' }));
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
          {t('encounters.aftermath.title')}
        </span>
        <p className="text-xs text-slate-400 m-0">{t('encounters.aftermath.loading')}</p>
      </Card>
    );
  }

  if (error || !aftermath) {
    return (
      <Card density="comfortable" aria-labelledby="encounter-aftermath-heading">
        <span id="encounter-aftermath-heading" className="text-sm font-bold text-white">
          {t('encounters.aftermath.title')}
        </span>
        <p className="text-xs text-rose-400 m-0" role="alert">
          {error ?? t('encounters.aftermath.unavailable')}
        </p>
      </Card>
    );
  }

  if (collapsed) {
    return (
      <Card density="comfortable" className="space-y-2" aria-labelledby="encounter-aftermath-heading">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 id="encounter-aftermath-heading" className="text-sm font-bold text-white m-0">
            {t('encounters.aftermath.title')}
          </h2>
          <Btn type="button" className="btn btn-secondary min-h-9" onClick={() => setCollapsed(false)}>
            {t('encounters.aftermath.show')}
          </Btn>
        </div>
        <p className="text-xs text-slate-400 m-0">{t('encounters.aftermath.deferredHint')}</p>
      </Card>
    );
  }

  const { outcome, handoffs, xp } = aftermath;
  const gridCols = handoffs.questPath && handoffs.sessionPath ? 'sm:grid-cols-2 lg:grid-cols-3' : handoffs.questPath || handoffs.sessionPath ? 'sm:grid-cols-2' : 'sm:grid-cols-2';

  return (
    <Card density="comfortable" className="space-y-4" role="region" aria-labelledby="encounter-aftermath-heading">
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <h2 id="encounter-aftermath-heading" className="text-sm font-bold text-white m-0">
            {t('encounters.aftermath.title')}
          </h2>
          <Btn
            type="button"
            className="btn btn-ghost min-h-9 text-xs"
            onClick={() => void dismiss()}
            disabled={dismissing}
          >
            {dismissing ? t('encounters.aftermath.saving') : t('encounters.aftermath.remindLater')}
          </Btn>
        </div>
        <p className="text-xs text-slate-400 m-0">{t('encounters.aftermath.intro')}</p>
      </div>

      <section aria-labelledby="encounter-aftermath-outcome-heading" className="space-y-2">
        <h3 id="encounter-aftermath-outcome-heading" className="text-xs font-bold uppercase tracking-wide text-slate-400 m-0">
          {t('encounters.aftermath.outcome')}
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
            {t('encounters.aftermath.xpSuggested', {
              amount: xp.suggestedPerCharacter,
              label: xp.difficultyLabel,
              total: xp.suggestedPartyTotal,
            })}
          </p>
        )}
        {xp.supported && xp.undistributedXp != null && xp.undistributedXp > 0 && (
          <p className="text-xs text-slate-400 m-0">
            {t('encounters.aftermath.xpRemainder', { remainder: xp.undistributedXp })}
          </p>
        )}
        {xp.supported && xp.suggestedPerCharacter == null && xp.suggestedPartyTotal != null && (
          <p className="text-xs text-slate-400 m-0">
            {t('encounters.aftermath.xpSplitManual', { total: xp.suggestedPartyTotal })}
          </p>
        )}
        {!xp.supported && (
          <p className="text-xs text-slate-400 m-0">
            {t('encounters.aftermath.xpManual', { label: xp.difficultyLabel })}
          </p>
        )}
      </section>

      <section aria-labelledby="encounter-aftermath-recap-heading" className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 id="encounter-aftermath-recap-heading" className="text-xs font-bold uppercase tracking-wide text-slate-400 m-0">
            {t('encounters.aftermath.recapDraft')}
          </h3>
          <CopyControl text={aftermath.recapDraft} label={t('encounters.aftermath.copyRecapDraft')} />
        </div>
        <TextArea
          readOnly
          value={aftermath.recapDraft}
          rows={8}
          className="font-mono text-xs min-h-[8rem]"
          aria-label={t('encounters.aftermath.recapDraftAria')}
        />
        <p className="text-[11px] text-muted m-0">
          {t('encounters.aftermath.recapHandoffHint')}{' '}
          <Link to={handoffs.encounterLogPath} className="link-button underline underline-offset-2 font-semibold">
            {t('encounters.aftermath.viewCombatLog')}
          </Link>
        </p>
      </section>

      <nav aria-label="Post-encounter hand-offs" className={`grid grid-cols-1 gap-2 ${gridCols}`}>
        <Link
          to={handoffs.recapPath}
          onClick={primeRecapNavigation}
          className="btn btn-primary min-w-0 min-h-11 flex-col !items-start text-left"
        >
          <span className="font-semibold">{t('encounters.aftermath.writeRecap')}</span>
          <span className="text-[11px] text-muted font-normal">{t('encounters.aftermath.writeRecapHint')}</span>
        </Link>
        <Link to={handoffs.awardXpPath} className="btn btn-secondary min-w-0 min-h-11 flex-col !items-start text-left">
          <span className="font-semibold">{t('encounters.aftermath.awardXp')}</span>
          <span className="text-[11px] text-muted font-normal">
            {xp.suggestedPerCharacter != null
              ? t('encounters.aftermath.awardXpSuggestedHint', { amount: xp.suggestedPerCharacter })
              : t('encounters.aftermath.awardXpHint')}
          </span>
        </Link>
        <Link to={handoffs.inventoryPath} className="btn btn-secondary min-w-0 min-h-11 flex-col !items-start text-left">
          <span className="font-semibold">{t('encounters.aftermath.distributeLoot')}</span>
          <span className="text-[11px] text-muted font-normal">{t('encounters.aftermath.distributeLootHint')}</span>
        </Link>
        {handoffs.questPath && (
          <Link to={handoffs.questPath} className="btn btn-secondary min-w-0 min-h-11 flex-col !items-start text-left">
            <span className="font-semibold">{t('encounters.aftermath.updateQuest')}</span>
            <span className="text-[11px] text-muted font-normal">{t('encounters.aftermath.updateQuestHint')}</span>
          </Link>
        )}
        {handoffs.sessionPath && (
          <Link to={handoffs.sessionPath} className="btn btn-secondary min-w-0 min-h-11 flex-col !items-start text-left">
            <span className="font-semibold">{t('encounters.aftermath.openSession')}</span>
            <span className="text-[11px] text-muted font-normal">{t('encounters.aftermath.openSessionHint')}</span>
          </Link>
        )}
      </nav>
    </Card>
  );
}
