/**
 * Post-encounter aftermath workflow (issue #473, #1448): recap draft, outcome review,
 * in-panel direct actions for XP/milestones, loot/treasury transfer, quest update,
 * storyline beat logging, campaign timeline event creation, and hand-off links.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { EncounterAftermath } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { Card, Btn, TextArea, TextInput } from '../../components/ui';
import { CopyControl } from '../../components/CopyControl';
import { storeEncounterAftermathRecap } from './encounterAftermathHandoff';

type Props = {
  campaignId: number;
  encounterId: number;
};

export function EncounterAftermathPanel({ campaignId, encounterId }: Props) {
  const { t } = useTranslation('encounters');
  const [aftermath, setAftermath] = useState<EncounterAftermath | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Form states for in-panel actions
  const [milestoneNote, setMilestoneNote] = useState('');
  const [customXp, setCustomXp] = useState<string>('');
  const [beatTitle, setBeatTitle] = useState('');
  const [timelineTitle, setTimelineTitle] = useState('');

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

  async function handleApplyXp(isMilestone = false) {
    setBusyAction('xp');
    setError(null);
    setActionSuccess(null);
    try {
      const amountVal = customXp ? parseInt(customXp, 10) : undefined;
      const updated = await api.post<EncounterAftermath>(`${API}/encounters/${encounterId}/aftermath/apply-xp`, {
        amount: Number.isFinite(amountVal) && amountVal! > 0 ? amountVal : undefined,
        isMilestone,
        milestoneNote: isMilestone ? milestoneNote : undefined,
      });
      setAftermath(updated);
      setActionSuccess(isMilestone ? 'Milestone progress recorded!' : 'XP awarded to party!');
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.applyXp' }));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleTransferItem(itemId: string) {
    setBusyAction(`item-${itemId}`);
    setError(null);
    setActionSuccess(null);
    try {
      const updated = await api.post<EncounterAftermath>(`${API}/encounters/${encounterId}/aftermath/transfer-loot`, {
        itemId,
        ownerType: 'party',
      });
      setAftermath(updated);
      setActionSuccess('Item transferred to party inventory!');
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.transferLoot' }));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleTransferCoins() {
    if (!aftermath) return;
    setBusyAction('coins');
    setError(null);
    setActionSuccess(null);
    try {
      const updated = await api.post<EncounterAftermath>(`${API}/encounters/${encounterId}/aftermath/transfer-loot`, {
        transferCoins: aftermath.loot.coins,
      });
      setAftermath(updated);
      setActionSuccess('Coins added to party treasury!');
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.transferLoot' }));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleUpdateQuest(questStatus?: 'completed' | 'active' | 'failed', objectiveIndex?: number) {
    if (!aftermath?.questId) return;
    setBusyAction('quest');
    setError(null);
    setActionSuccess(null);
    try {
      const updated = await api.post<EncounterAftermath>(`${API}/encounters/${encounterId}/aftermath/update-quest`, {
        questId: aftermath.questId,
        questStatus,
        objectiveIndex,
      });
      setAftermath(updated);
      setActionSuccess('Quest status updated!');
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.updateQuest' }));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCreateBeat() {
    if (!beatTitle.trim()) return;
    setBusyAction('beat');
    setError(null);
    setActionSuccess(null);
    try {
      const updated = await api.post<EncounterAftermath>(`${API}/encounters/${encounterId}/aftermath/update-beat`, {
        title: beatTitle.trim(),
        status: 'done',
      });
      setAftermath(updated);
      setBeatTitle('');
      setActionSuccess('Storyline beat logged!');
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.updateBeat' }));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleAddTimelineEvent() {
    if (!timelineTitle.trim()) return;
    setBusyAction('timeline');
    setError(null);
    setActionSuccess(null);
    try {
      const updated = await api.post<EncounterAftermath>(`${API}/encounters/${encounterId}/aftermath/add-timeline-event`, {
        title: timelineTitle.trim(),
      });
      setAftermath(updated);
      setTimelineTitle('');
      setActionSuccess('Timeline event added!');
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addTimeline' }));
    } finally {
      setBusyAction(null);
    }
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

  const { outcome, handoffs, xp, loot, xpAwarded, milestoneMode } = aftermath;
  const gridCols = handoffs.questPath && handoffs.sessionPath ? 'sm:grid-cols-2 lg:grid-cols-3' : handoffs.questPath || handoffs.sessionPath ? 'sm:grid-cols-2' : 'sm:grid-cols-2';

  const totalCoins = loot.coins.cp + loot.coins.sp + loot.coins.ep + loot.coins.gp + loot.coins.pp;

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
        {actionSuccess && (
          <p className="text-xs font-semibold text-emerald-400 m-0" role="status">
            ✓ {actionSuccess}
          </p>
        )}
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

        {/* XP & Milestone Award Actions */}
        <div className="p-3 bg-slate-800/60 rounded-md border border-slate-700/60 space-y-2 mt-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs font-semibold text-slate-200">
              {milestoneMode ? 'Milestone Progression' : 'XP Award'}
            </span>
            {xpAwarded && (
              <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
                Awarded
              </span>
            )}
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
          {!milestoneMode ? (
            <div className="flex items-center gap-2 flex-wrap">
              <TextInput
                type="number"
                placeholder={xp.suggestedPerCharacter ? String(xp.suggestedPerCharacter) : 'Custom XP'}
                value={customXp}
                onChange={(e) => setCustomXp(e.target.value)}
                className="w-32 text-xs"
              />
              <Btn
                type="button"
                className="btn btn-primary min-h-8 text-xs"
                disabled={busyAction === 'xp'}
                onClick={() => void handleApplyXp(false)}
              >
                {busyAction === 'xp' ? 'Awarding...' : xpAwarded ? 'Re-Award XP' : 'Award XP to Party'}
              </Btn>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <TextInput
                type="text"
                placeholder="Milestone note (e.g. Defeated Goblin Leader)"
                value={milestoneNote}
                onChange={(e) => setMilestoneNote(e.target.value)}
                className="flex-1 text-xs"
              />
              <Btn
                type="button"
                className="btn btn-primary min-h-8 text-xs"
                disabled={busyAction === 'xp'}
                onClick={() => void handleApplyXp(true)}
              >
                {busyAction === 'xp' ? 'Recording...' : 'Record Milestone Progress'}
              </Btn>
            </div>
          )}
        </div>
      </section>

      {/* Loot & Treasury Section */}
      <section aria-labelledby="encounter-aftermath-loot-heading" className="space-y-2">
        <h3 id="encounter-aftermath-loot-heading" className="text-xs font-bold uppercase tracking-wide text-slate-400 m-0">
          Loot & Treasury
        </h3>
        <div className="p-3 bg-slate-800/60 rounded-md border border-slate-700/60 space-y-3">
          {loot.items.length > 0 && (
            <div className="space-y-2">
              <span className="text-xs font-semibold text-slate-300">Items Found</span>
              <ul className="space-y-1.5 m-0 p-0 list-none text-xs">
                {loot.items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2 p-2 bg-slate-900/40 rounded border border-slate-700/40">
                    <div>
                      <span className="font-medium text-white">{item.name}</span>
                      {item.qty > 1 && <span className="text-slate-400"> (x{item.qty})</span>}
                      {item.notes && <p className="text-[11px] text-slate-400 m-0">{item.notes}</p>}
                    </div>
                    {item.claimed ? (
                      <span className="text-[11px] font-semibold text-emerald-400">Claimed</span>
                    ) : (
                      <Btn
                        type="button"
                        className="btn btn-secondary min-h-7 text-[11px] py-0 px-2"
                        disabled={busyAction === `item-${item.id}`}
                        onClick={() => void handleTransferItem(item.id)}
                      >
                        {busyAction === `item-${item.id}` ? 'Transferring...' : 'Transfer to Party'}
                      </Btn>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {totalCoins > 0 && (
            <div className="flex items-center justify-between gap-2 flex-wrap pt-1 border-t border-slate-700/40">
              <div className="text-xs">
                <span className="font-semibold text-slate-300">Currency: </span>
                <span className="text-amber-300 font-mono">
                  {loot.coins.gp > 0 && `${loot.coins.gp} gp `}
                  {loot.coins.sp > 0 && `${loot.coins.sp} sp `}
                  {loot.coins.cp > 0 && `${loot.coins.cp} cp `}
                  {loot.coins.ep > 0 && `${loot.coins.ep} ep `}
                  {loot.coins.pp > 0 && `${loot.coins.pp} pp `}
                </span>
              </div>
              {loot.coinsClaimed ? (
                <span className="text-[11px] font-semibold text-emerald-400">Treasury Claimed</span>
              ) : (
                <Btn
                  type="button"
                  className="btn btn-secondary min-h-7 text-[11px] py-0 px-2"
                  disabled={busyAction === 'coins'}
                  onClick={() => void handleTransferCoins()}
                >
                  {busyAction === 'coins' ? 'Adding...' : 'Add Coins to Treasury'}
                </Btn>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Quest & Storyline Updates */}
      <section aria-labelledby="encounter-aftermath-updates-heading" className="space-y-2">
        <h3 id="encounter-aftermath-updates-heading" className="text-xs font-bold uppercase tracking-wide text-slate-400 m-0">
          Quest & Storyline Progress
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {aftermath.questId && (
            <div className="p-3 bg-slate-800/60 rounded-md border border-slate-700/60 space-y-2">
              <span className="text-xs font-semibold text-slate-200">Quest Status</span>
              <div className="flex gap-1.5 flex-wrap">
                <Btn
                  type="button"
                  className="btn btn-secondary min-h-7 text-[11px] py-0 px-2"
                  disabled={busyAction === 'quest'}
                  onClick={() => void handleUpdateQuest('completed')}
                >
                  Mark Quest Completed
                </Btn>
              </div>
            </div>
          )}

          <div className="p-3 bg-slate-800/60 rounded-md border border-slate-700/60 space-y-2">
            <span className="text-xs font-semibold text-slate-200">Log Story Beat</span>
            <div className="flex items-center gap-1.5">
              <TextInput
                type="text"
                placeholder="Beat title (e.g. Cleared Goblins)"
                value={beatTitle}
                onChange={(e) => setBeatTitle(e.target.value)}
                className="text-xs flex-1"
              />
              <Btn
                type="button"
                className="btn btn-secondary min-h-7 text-[11px] py-0 px-2"
                disabled={busyAction === 'beat' || !beatTitle.trim()}
                onClick={() => void handleCreateBeat()}
              >
                Log Beat
              </Btn>
            </div>
          </div>

          <div className="p-3 bg-slate-800/60 rounded-md border border-slate-700/60 space-y-2 sm:col-span-2">
            <span className="text-xs font-semibold text-slate-200">Timeline Event</span>
            <div className="flex items-center gap-1.5">
              <TextInput
                type="text"
                placeholder="Timeline event title (e.g. Battle of Red Rock)"
                value={timelineTitle}
                onChange={(e) => setTimelineTitle(e.target.value)}
                className="text-xs flex-1"
              />
              <Btn
                type="button"
                className="btn btn-secondary min-h-7 text-[11px] py-0 px-2"
                disabled={busyAction === 'timeline' || !timelineTitle.trim()}
                onClick={() => void handleAddTimelineEvent()}
              >
                Add Event
              </Btn>
            </div>
          </div>
        </div>
      </section>

      {/* Recap Draft Section */}
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
          rows={6}
          className="font-mono text-xs min-h-[6rem]"
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

