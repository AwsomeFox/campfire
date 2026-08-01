/**
 * Quest detail page — fidelity-synced to design/claude-design/Campfire.dc.html
 * "Quest detail" screen (~L571-629).
 * Route: /c/:campaignId/quests/:questId (questId === 'new' renders the dm create form).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DetailPageWayfinding } from '../../components/DetailPageWayfinding';
import { preserveListOriginState } from '../../lib/detailListOrigin';
import { QuestStatus, type Quest, type QuestObjective, type Npc } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import {
  compositionSafeFormSubmit,
  createCompositionSubmitGate,
} from '../../lib/compositionSafeSubmit';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { timeAgo, useTimeTick } from '../../lib/format';
import {
  Card,
  Chip,
  Btn,
  TextInput,
  TextArea,
  EmptyState,
  Skeleton,
  ErrorNote,
  DmPanel,
} from '../../components/ui';
import { QuestStatusBadge } from '../../components/EntitySemanticBadges';
import { Markdown } from '../../components/Markdown';
import { PrintControl } from '../../components/PrintControl';
import { PrintOnly } from '../../components/PrintOnly';
import { PageTitle } from '../../components/PageTitle';
import { NotFoundState } from '../../components/NotFoundState';
import { NotesRail } from '../../components/NotesRail';
import { EntityDiscussion } from '../comments/EntityDiscussion';
import { EncounterBacklinksCard } from '../../components/EncounterBacklinksCard';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { VisibleToPlayersBar } from '../../components/VisibleToPlayersBar';
import { EntitySecrecyControls } from '../../components/EntitySecrecyControls';
import { buildQuestRevealPreview } from '../../components/entityRevealPreview';
import { AudienceField, audienceToHidden, type AudienceValue } from '../../components/AudienceField';
import { Toggle } from '../../components/Toggle';
import { RevisionHistoryPanel } from '../../components/RevisionHistoryPanel';
import { StatusMenuButton } from '../../components/StatusMenuButton';
import { useAnnounce } from '../../components/Announcer';
import { entityTargetProps } from '../../lib/entityLinks';
import {
  QUEST_BODY_HELP,
  QUEST_BODY_LABEL,
  QUEST_GIVER_HELP,
  QUEST_GIVER_LABEL,
  QUEST_NEW_FORM_PREFIX,
  QUEST_PARENT_HELP,
  QUEST_PARENT_LABEL,
  QUEST_REWARD_HELP,
  QUEST_REWARD_LABEL,
  QUEST_TITLE_HELP,
  QUEST_TITLE_LABEL,
  QUEST_TITLE_REQUIRED_ERROR,
  questFieldErrorId,
  questFieldHelpId,
  questFieldId,
} from './questFormA11y';

type QuestWithObjectives = Quest & { objectives: QuestObjective[] };
type QuestStatusValue = Quest['status'];

const STATUS_OPTIONS: QuestStatusValue[] = QuestStatus.options;

export default function QuestPage() {
  useTimeTick();
  const { campaignId, questId } = useParams<{ campaignId: string; questId: string }>();
  const cid = Number(campaignId);

  if (questId === 'new') {
    return <QuestCreatePage campaignId={cid} />;
  }
  return <QuestDetailPage campaignId={cid} questId={Number(questId)} />;
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function QuestDetailPage({ campaignId, questId }: { campaignId: number; questId: number }) {
  const location = useLocation();
  const { t } = useTranslation();
  const { role, isDm, canDmWrite, canPlayerWrite } = useCampaignAccess();
  const canToggleObjectives = canPlayerWrite;
  const announce = useAnnounce();
  const navigate = useNavigate();

  const [quest, setQuest] = useState<QuestWithObjectives | null>(null);
  const [siblingQuests, setSiblingQuests] = useState<Quest[]>([]);
  const [giver, setGiver] = useState<Npc | null>(null);
  const [npcs, setNpcs] = useState<Npc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const [editingBody, setEditingBody] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [bodyDraft, setBodyDraft] = useState('');
  const [rewardDraft, setRewardDraft] = useState('');
  const [giverNpcIdDraft, setGiverNpcIdDraft] = useState('');
  const [parentIdDraft, setParentIdDraft] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [savingBody, setSavingBody] = useState(false);
  // Optimistic-concurrency guard (#157/#233): a stale body save 409s instead of
  // clobbering a co-DM's or a connected AI's interleaved edit. `bodyConflict` shows a
  // Reload-latest affordance; `historyNonce` refetches the edit-history panel on save.
  const [bodyConflict, setBodyConflict] = useState(false);
  const [historyNonce, setHistoryNonce] = useState(0);

  const editPrefix = 'quest-edit';
  const editTitleId = questFieldId(editPrefix, 'title');
  const editBodyId = questFieldId(editPrefix, 'body');
  const editRewardId = questFieldId(editPrefix, 'reward');
  const editGiverId = questFieldId(editPrefix, 'giver');
  const editParentId = questFieldId(editPrefix, 'parent');

  // Propose mode (issue #240): a non-DM member editing the quest body submits the
  // change to the DM's proposal queue (PATCH ?proposed=true) instead of writing directly.
  const [proposeMode, setProposeMode] = useState(false);
  const [submittingProposal, setSubmittingProposal] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [proposalDone, setProposalDone] = useState(false);

  const [savingStatus, setSavingStatus] = useState(false);

  const [newObjective, setNewObjective] = useState('');
  const [addingObjective, setAddingObjective] = useState(false);
  const [editingObjectiveId, setEditingObjectiveId] = useState<number | null>(null);
  const [objectiveDraft, setObjectiveDraft] = useState('');
  // Issue #854: Enter confirming IME composition must not create an objective.
  const objectiveCompositionGateRef = useRef<ReturnType<typeof createCompositionSubmitGate> | null>(null);
  if (objectiveCompositionGateRef.current === null) {
    objectiveCompositionGateRef.current = createCompositionSubmitGate();
  }
  const objectiveCompositionGate = objectiveCompositionGateRef.current;

  const [editingDmSecret, setEditingDmSecret] = useState(false);
  const [dmSecretDraft, setDmSecretDraft] = useState('');
  const [savingDmSecret, setSavingDmSecret] = useState(false);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pendingUndo, setPendingUndo] = useState(false);

  // Objectives being toggled right now (keyed by objective id). Guards against the
  // optimistic-update race where a fast double-toggle could roll back to the wrong
  // "previous" value — see toggleObjective below.
  const [pendingObjectives, setPendingObjectives] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    setNotFound(false);
    setLoading(true);
    try {
      const q = await api.get<QuestWithObjectives>(`${API}/quests/${questId}`);
      setQuest(q);
      setTitleDraft(q.title);
      setBodyDraft(q.body);
      setRewardDraft(q.reward ?? '');
      setGiverNpcIdDraft(q.giverNpcId ? String(q.giverNpcId) : '');
      setParentIdDraft(q.parentId ? String(q.parentId) : '');
      setDmSecretDraft(q.dmSecret);

      const [campaignQuests, npcList] = await Promise.all([
        api.get<Quest[]>(`${API}/campaigns/${campaignId}/quests`),
        api.get<Npc[]>(`${API}/campaigns/${campaignId}/npcs`).catch(() => [] as Npc[]),
      ]);
      setSiblingQuests(campaignQuests);
      setNpcs(npcList);

      if (q.giverNpcId) {
        const found = npcList.find((n) => n.id === q.giverNpcId);
        if (found) {
          setGiver(found);
        } else {
          try {
            const npc = await api.get<Npc>(`${API}/npcs/${q.giverNpcId}`);
            setGiver(npc);
          } catch {
            setGiver(null);
          }
        }
      } else {
        setGiver(null);
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else if (e instanceof ApiError && e.status === 404) {
        setNotFound(true);
      } else {
        setError(t('quests.loadOneFailed'));
      }
    } finally {
      setLoading(false);
    }
  }, [campaignId, questId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const subquests = useMemo(
    () => siblingQuests.filter((q) => q.parentId === questId),
    [siblingQuests, questId],
  );

  function startEdit() {
    if (!quest) return;
    setTitleDraft(quest.title);
    setBodyDraft(quest.body);
    setRewardDraft(quest.reward ?? '');
    setGiverNpcIdDraft(quest.giverNpcId ? String(quest.giverNpcId) : '');
    setParentIdDraft(quest.parentId ? String(quest.parentId) : '');
    setTitleError(null);
    setBodyConflict(false);
    setError(null);
    setProposeMode(false);
    setEditingBody(true);
  }

  async function save() {
    if (!quest) return;
    if (!titleDraft.trim()) {
      setTitleError(QUEST_TITLE_REQUIRED_ERROR);
      document.getElementById(editTitleId)?.focus();
      return;
    }
    setTitleError(null);
    setSavingBody(true);
    setError(null);
    setBodyConflict(false);
    try {
      const updated = await api.patch<Quest>(`${API}/quests/${quest.id}`, {
        title: titleDraft.trim(),
        body: bodyDraft,
        reward: rewardDraft,
        giverNpcId: giverNpcIdDraft ? Number(giverNpcIdDraft) : null,
        parentId: parentIdDraft ? Number(parentIdDraft) : null,
        // Echo back the updatedAt we loaded so a concurrent edit 409s (#157/#233) instead
        // of silently overwriting the other author's work.
        ...(quest.updatedAt ? { expectedUpdatedAt: quest.updatedAt } : {}),
      });
      setQuest({ ...quest, ...updated });
      if (updated.giverNpcId !== quest.giverNpcId) {
        if (updated.giverNpcId) {
          const found = npcs.find((n) => n.id === updated.giverNpcId);
          if (found) {
            setGiver(found);
          } else {
            try {
              const npc = await api.get<Npc>(`${API}/npcs/${updated.giverNpcId}`);
              setGiver(npc);
            } catch {
              setGiver(null);
            }
          }
        } else {
          setGiver(null);
        }
      }
      if (updated.parentId !== quest.parentId) {
        try {
          const campaignQuests = await api.get<Quest[]>(`${API}/campaigns/${campaignId}/quests`);
          setSiblingQuests(campaignQuests);
        } catch {
          // ignore
        }
      }
      setEditingBody(false);
      setHistoryNonce((n) => n + 1);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone saved between our load and this save — keep the draft, block the
        // clobber, and prompt a reload of the latest before saving again.
        setBodyConflict(true);
        setError(t('quests.bodyConflict'));
      } else {
        setError(t('quests.saveBodyFailed'));
      }
    } finally {
      setSavingBody(false);
    }
  }

  async function reloadBody() {
    setError(null);
    setBodyConflict(false);
    try {
      const fresh = await api.get<QuestWithObjectives>(`${API}/quests/${questId}`);
      setQuest(fresh);
      setTitleDraft(fresh.title);
      setBodyDraft(fresh.body);
      setRewardDraft(fresh.reward ?? '');
      setGiverNpcIdDraft(fresh.giverNpcId ? String(fresh.giverNpcId) : '');
      setParentIdDraft(fresh.parentId ? String(fresh.parentId) : '');
    } catch {
      setError(t('quests.loadOneFailed'));
    }
  }

  // Non-DM members suggest an edit (issue #240) — routed to the DM's proposal queue.
  function startPropose() {
    if (!quest) return;
    setTitleDraft(quest.title);
    setBodyDraft(quest.body);
    setRewardDraft(quest.reward ?? '');
    setGiverNpcIdDraft(quest.giverNpcId ? String(quest.giverNpcId) : '');
    setParentIdDraft(quest.parentId ? String(quest.parentId) : '');
    setTitleError(null);
    setProposalError(null);
    setProposalDone(false);
    setProposeMode(true);
    setEditingBody(true);
  }

  function cancelBodyEdit() {
    setEditingBody(false);
    setProposeMode(false);
    setProposalError(null);
    setTitleError(null);
  }

  async function submitBodyProposal() {
    if (!quest) return;
    if (!titleDraft.trim()) {
      setTitleError(QUEST_TITLE_REQUIRED_ERROR);
      document.getElementById(editTitleId)?.focus();
      return;
    }
    setTitleError(null);
    setSubmittingProposal(true);
    setProposalError(null);
    try {
      await api.patch(`${API}/quests/${quest.id}?proposed=true`, {
        title: titleDraft.trim(),
        body: bodyDraft,
        reward: rewardDraft,
        giverNpcId: giverNpcIdDraft ? Number(giverNpcIdDraft) : null,
        parentId: parentIdDraft ? Number(parentIdDraft) : null,
      });
      setEditingBody(false);
      setProposeMode(false);
      setProposalDone(true);
    } catch {
      setProposalError(t('quests.suggestFailed'));
    } finally {
      setSubmittingProposal(false);
    }
  }

  async function saveStatus(status: QuestStatusValue) {
    if (!quest) return;
    setSavingStatus(true);
    try {
      const updated = await api.post<Quest>(`${API}/quests/${quest.id}/status`, { status });
      setQuest((q) => (q ? { ...q, ...updated } : q));
      // Announce the server-acknowledged status, not the requested one — if the
      // backend normalizes/overrides the value, the spoken message must match
      // what was actually persisted.
      announce(t('quests.statusChanged', { status: questStatusWord(t, updated.status) }));
    } catch {
      // Selection is preserved (quest.status is unchanged). Surface the failure
      // both visually (page-level ErrorNote) and to the screen reader so the
      // user learns the save did not stick.
      setError(t('quests.updateStatusFailed'));
      throw new Error('status save failed');
    } finally {
      setSavingStatus(false);
    }
  }

  async function toggleObjective(objective: QuestObjective) {
    if (!quest) return;
    // Ignore toggles on an objective that already has a request in flight — prevents
    // a fast double-click from firing two overlapping PATCHes whose responses could
    // land out of order and roll the checkbox back to the wrong state.
    if (pendingObjectives[objective.id]) return;

    const previousDone = objective.done;
    const nextDone = !previousDone;
    setPendingObjectives((p) => ({ ...p, [objective.id]: true }));
    setQuest((q) =>
      q ? { ...q, objectives: q.objectives.map((o) => (o.id === objective.id ? { ...o, done: nextDone } : o)) } : q,
    );
    try {
      await api.patch<QuestObjective>(`${API}/quests/${quest.id}/objectives/${objective.id}`, {
        done: nextDone,
      });
    } catch {
      // Roll back only to the pre-THIS-toggle value, not to whatever the objectives
      // array looked like when the request started (which could now be stale).
      setQuest((q) =>
        q ? { ...q, objectives: q.objectives.map((o) => (o.id === objective.id ? { ...o, done: previousDone } : o)) } : q,
      );
      setError(t('quests.updateObjectiveFailed'));
    } finally {
      setPendingObjectives((p) => {
        const next = { ...p };
        delete next[objective.id];
        return next;
      });
    }
  }

  async function addObjective() {
    if (!quest || !newObjective.trim()) return;
    setAddingObjective(true);
    try {
      const created = await api.post<QuestObjective>(`${API}/quests/${quest.id}/objectives`, {
        text: newObjective.trim(),
      });
      setQuest({ ...quest, objectives: [...quest.objectives, created] });
      setNewObjective('');
    } catch {
      setError(t('quests.addObjectiveFailed'));
    } finally {
      setAddingObjective(false);
    }
  }

  function startEditObjective(o: QuestObjective) {
    setEditingObjectiveId(o.id);
    setObjectiveDraft(o.text);
  }

  async function saveObjectiveText(o: QuestObjective) {
    if (!quest || !objectiveDraft.trim()) return;
    try {
      const updated = await api.patch<QuestObjective>(`${API}/quests/${quest.id}/objectives/${o.id}`, {
        text: objectiveDraft.trim(),
      });
      setQuest({ ...quest, objectives: quest.objectives.map((x) => (x.id === o.id ? updated : x)) });
      setEditingObjectiveId(null);
    } catch {
      setError(t('quests.renameObjectiveFailed'));
    }
  }

  async function deleteObjective(o: QuestObjective) {
    if (!quest) return;
    try {
      await api.delete(`${API}/quests/${quest.id}/objectives/${o.id}`);
      setQuest({ ...quest, objectives: quest.objectives.filter((x) => x.id !== o.id) });
    } catch {
      setError(t('quests.deleteObjectiveFailed'));
    }
  }

  // Move an objective one slot up/down and persist the new order (#100). Sends the
  // full reordered id list to the atomic reorder endpoint, then adopts the server's
  // canonical ordering from the response.
  async function reorderObjective(index: number, direction: -1 | 1) {
    if (!quest) return;
    const target = index + direction;
    if (target < 0 || target >= quest.objectives.length) return;
    const next = [...quest.objectives];
    [next[index], next[target]] = [next[target], next[index]];
    setQuest({ ...quest, objectives: next }); // optimistic
    try {
      const updated = await api.post<QuestObjective[]>(`${API}/quests/${quest.id}/objectives/reorder`, {
        objectiveIds: next.map((o) => o.id),
      });
      setQuest((q) => (q ? { ...q, objectives: updated } : q));
    } catch {
      setError(t('quests.reorderFailed'));
      void load();
    }
  }

  async function saveDmSecret() {
    if (!quest) return;
    setSavingDmSecret(true);
    try {
      const updated = await api.patch<Quest>(`${API}/quests/${quest.id}`, { dmSecret: dmSecretDraft });
      setQuest({ ...quest, ...updated });
      setEditingDmSecret(false);
    } catch {
      setError(t('quests.saveDmNotesFailed'));
    } finally {
      setSavingDmSecret(false);
    }
  }

  // NOTE ON DELETE BEHAVIOR (issue #116): QuestsService.remove() now SOFT-deletes — it
  // stamps deleted_at (the quest + its objectives vanish from reads but survive, its
  // subquests keep their parentId), so the delete is reversible. We surface that with an
  // Undo snackbar: instead of navigating away immediately we keep the page and offer a
  // one-click restore; only on expiry/dismiss do we return to the quest list.
  async function deleteQuest() {
    if (!quest) return;
    setDeleting(true);
    setError(null);
    try {
      await api.delete(`${API}/quests/${quest.id}`);
      setConfirmingDelete(false);
      setPendingUndo(true);
    } catch {
      setError(t('quests.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  }

  async function undoDelete() {
    if (!quest) return;
    await api.post(`${API}/quests/${quest.id}/restore`);
    setPendingUndo(false);
    await load();
  }

  if (forbidden) {
    return (
      <PageShell campaignId={campaignId}>
        <Card>
          <EmptyState icon="padlock" title={t('quests.noAccess')} />
        </Card>
      </PageShell>
    );
  }

  if (notFound) {
    return (
      <PageShell campaignId={campaignId}>
        <NotFoundState
          title={t('quests.notFound')}
          backTo={`/c/${campaignId}/quests`}
          backLabel={t('quests.backToQuests')}
        />
      </PageShell>
    );
  }

  if (loading) {
    return (
      <PageShell campaignId={campaignId}>
        <Card>
          <Skeleton lines={5} />
        </Card>
      </PageShell>
    );
  }

  if (error && !quest) {
    return (
      <PageShell campaignId={campaignId}>
        <Card>
          <ErrorNote message={error} onRetry={load} />
        </Card>
      </PageShell>
    );
  }

  if (!quest) return null;

  const hasSubs = subquests.length > 0;
  const showSecret = isDm && (quest.dmSecret || editingDmSecret);
  const revealPreview = buildQuestRevealPreview({
    title: quest.title,
    body: quest.body,
    reward: quest.reward,
    objectives: quest.objectives,
    giverName: giver?.name,
    subquestTitles: subquests.map((sq) => sq.title),
  });

  return (
    <div className="cf-print-root cf-print-reference max-w-6xl mx-auto px-4 mt-5 pb-20 lg:pb-10" style={{ display: 'flex', flexDirection: 'column', gap: 14 }} {...entityTargetProps('quest', quest.id)}>
      {error && <div className="cf-print-hide"><ErrorNote message={error} onRetry={load} /></div>}

      {canDmWrite && (
        <div className="cf-print-hide"><VisibleToPlayersBar
          visible={!quest.hidden}
          onHide={async () => {
            const updated = await api.patch<Quest>(`${API}/quests/${quest.id}`, {
              hidden: true,
              ...(quest.updatedAt ? { expectedUpdatedAt: quest.updatedAt } : {}),
            });
            setQuest({ ...quest, ...updated });
          }}
          onUndoHide={async () => {
            const updated = await api.patch<Quest>(`${API}/quests/${quest.id}`, {
              hidden: false,
              ...(quest.updatedAt ? { expectedUpdatedAt: quest.updatedAt } : {}),
            });
            setQuest({ ...quest, ...updated });
          }}
        /></div>
      )}

      <div className="cf-print-chrome"><DetailPageWayfinding
        campaignId={campaignId}
        defaultPath={`/c/${campaignId}/quests`}
        defaultLabel={t('quests.backToQuests')}
      /></div>
      <PrintOnly>
        <section className="cf-print-only cf-print-paper">
          <h1>{quest.title}</h1>
          <p><strong>Status:</strong> {questStatusWord(t, quest.status)}</p>
          <Markdown>{quest.body || 'No description yet.'}</Markdown>
          <h2>{t('quests.objectives')}</h2>
          <ul>{quest.objectives.map((objective) => <li key={objective.id}>{objective.done ? 'Done — ' : 'Open — '}{objective.text}</li>)}</ul>
          <p><strong>{t('quests.reward')}:</strong> {quest.reward || '—'} · <strong>{t('quests.givenBy')}:</strong> {giver?.name || '—'}</p>
          {isDm && quest.dmSecret && <div className="cf-print-secret"><DmPanel>{quest.dmSecret}</DmPanel></div>}
        </section>
      </PrintOnly>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {/* Issue #1711 (sibling audit off the Dashboard <h1> gap): this route's only real
            <h1> was inside the screen-hidden PrintOnly reference sheet above — the visible
            title here was a bare <h3> with no font-size override at all (Tailwind preflight
            resets heading sizes to inherit), so it rendered at plain body size. `size="compact"`
            gives it PageTitle's real semantics while keeping it visually modest enough to sit
            inline with the status badge/print control row, matching the Dashboard's identical
            title-plus-chips shape. */}
        <PageTitle size="compact" className="min-w-0 break-words" style={{ margin: 0 }}>{quest.title}</PageTitle>
        <QuestStatusBadge status={quest.status} />
        <PrintControl
          resetKey={quest.id}
          allowSecrets={isDm && Boolean(quest.dmSecret)}
          className="ml-auto"
        />
        {isDm && quest.hidden && <Chip variant="failed">{t('quests.hiddenChip')}</Chip>}
        {canDmWrite && (
          <div className="cf-print-hide flex items-center gap-2">
            <EntitySecrecyControls
              entityKind="quest"
              entityName={quest.title}
              hidden={quest.hidden}
              preview={revealPreview}
              onReveal={async () => {
                const updated = await api.patch<Quest>(`${API}/quests/${quest.id}`, {
                  hidden: false,
                  ...(quest.updatedAt ? { expectedUpdatedAt: quest.updatedAt } : {}),
                });
                setQuest({ ...quest, ...updated });
              }}
              onUndoReveal={async () => {
                const updated = await api.patch<Quest>(`${API}/quests/${quest.id}`, {
                  hidden: true,
                  ...(quest.updatedAt ? { expectedUpdatedAt: quest.updatedAt } : {}),
                });
                setQuest({ ...quest, ...updated });
              }}
            />
            <div style={{ flex: 1 }} />
            <Btn density="xs"
              ghost
              className="text-xs"
              onClick={() => {
                if (editingBody) {
                  cancelBodyEdit();
                } else {
                  startEdit();
                }
              }}
            >
              {t('quests.editQuest')}
            </Btn>
            <StatusMenuButton
              ghost
              density="compact"
              className="text-xs"
              triggerLabel={t('quests.statusMenuLabel', { status: questStatusWord(t, quest.status) })}
              triggerDescription={t('quests.statusMenuHint')}
              value={quest.status}
              options={STATUS_OPTIONS.map((s) => ({
                value: s,
                label: <QuestStatusBadge status={s} />,
              }))}
              disabled={savingStatus}
              triggerText={t('quests.statusMenu')}
              onSelect={(s) => saveStatus(s)}
              announceFailure={announce}
              failureMessage={t('quests.updateStatusFailed')}
            />
            <Btn density="xs" danger className="text-xs" onClick={() => setConfirmingDelete(true)}>
              {t('quests.delete')}
            </Btn>
          </div>
        )}
        {!isDm && role !== null && (
          <div className="cf-print-hide flex items-center gap-2">
            <div style={{ flex: 1 }} />
            <Btn density="xs"
              ghost
              className="text-xs"
              onClick={startPropose}
              title={t('quests.suggestEditTitle')}
            >
              {t('quests.suggestEdit')}
            </Btn>
          </div>
        )}
      </div>

      {proposalDone && !editingBody && (
        <Card density="compact" className="flex items-center justify-between gap-3 border border-[var(--color-accent-700)] text-sm">
          <span className="text-slate-200">{t('quests.suggestDone')}</span>
          <Link to={`/c/${campaignId}/proposals`} className="text-purple-400 hover:underline shrink-0">
            {t('quests.viewMyProposals')}
          </Link>
        </Card>
      )}

      <div className="cf-print-columns grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        <div className="lg:col-span-7" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <Card density="compact" elev="sm">
            {editingBody ? (
              <div className="space-y-3">
                {proposeMode && (
                  <p className="text-xs text-slate-400 m-0 rounded-[var(--radius-md)] bg-[var(--color-accent)]/10 border border-[var(--color-accent-700)] px-3 py-2">
                    {t('quests.suggestHint')}
                  </p>
                )}
                <div className="space-y-1">
                  <label htmlFor={editTitleId} className="text-xs font-bold text-secondary uppercase tracking-wide">
                    {QUEST_TITLE_LABEL}
                  </label>
                  <TextInput
                    id={editTitleId}
                    value={titleDraft}
                    aria-invalid={titleError != null}
                    onChange={(e) => {
                      setTitleDraft(e.target.value);
                      setTitleError(null);
                    }}
                    placeholder={t('quests.titlePlaceholder')}
                    maxLength={200}
                  />
                  {titleError && (
                    <p role="alert" className="text-xs text-rose-400 m-0">
                      {titleError}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <label htmlFor={editBodyId} className="text-xs font-bold text-secondary uppercase tracking-wide">
                    {QUEST_BODY_LABEL}
                  </label>
                  <TextArea
                    id={editBodyId}
                    style={{ minHeight: 140 }}
                    value={bodyDraft}
                    onChange={(e) => setBodyDraft(e.target.value)}
                    placeholder={t('quests.bodyPlaceholder')}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor={editRewardId} className="text-xs font-bold text-secondary uppercase tracking-wide">
                    {QUEST_REWARD_LABEL}
                  </label>
                  <TextInput
                    id={editRewardId}
                    value={rewardDraft}
                    onChange={(e) => setRewardDraft(e.target.value)}
                    placeholder={t('quests.rewardPlaceholder')}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor={editGiverId} className="text-xs font-bold text-secondary uppercase tracking-wide">
                    {QUEST_GIVER_LABEL}
                  </label>
                  <select
                    id={editGiverId}
                    className="cf-select"
                    value={giverNpcIdDraft}
                    onChange={(e) => setGiverNpcIdDraft(e.target.value)}
                  >
                    <option value="">{t('quests.giverNone')}</option>
                    {npcs.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label htmlFor={editParentId} className="text-xs font-bold text-secondary uppercase tracking-wide">
                    {QUEST_PARENT_LABEL}
                  </label>
                  <select
                    id={editParentId}
                    className="cf-select"
                    value={parentIdDraft}
                    onChange={(e) => setParentIdDraft(e.target.value)}
                  >
                    <option value="">{t('quests.parentNone')}</option>
                    {siblingQuests
                      .filter((q) => q.id !== quest.id)
                      .map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.title}
                        </option>
                      ))}
                  </select>
                </div>
                {proposalError && <p className="text-xs text-red-400 m-0">{proposalError}</p>}
                <div className="flex gap-2 justify-end">
                  {bodyConflict && (
                    <Btn density="xs" ghost onClick={reloadBody} disabled={savingBody} className="text-xs">
                      {t('quests.reloadLatest')}
                    </Btn>
                  )}
                  <Btn density="xs" ghost onClick={proposeMode ? cancelBodyEdit : () => setEditingBody(false)} className="text-xs">
                    {t('quests.cancel')}
                  </Btn>
                  {proposeMode ? (
                    <Btn density="xs" onClick={submitBodyProposal} disabled={submittingProposal} className="text-xs">
                      {submittingProposal ? t('quests.suggesting') : t('quests.suggestSubmit')}
                    </Btn>
                  ) : (
                    <Btn density="xs" onClick={save} disabled={savingBody} className="text-xs">
                      {savingBody ? t('quests.saving') : t('quests.save')}
                    </Btn>
                  )}
                </div>
              </div>
            ) : (
              <Markdown>{quest.body}</Markdown>
            )}

            <div className="hr" style={{ margin: '6px 0' }} />

            <span className="card-kicker">{t('quests.objectives')}</span>
            {quest.objectives.length === 0 && <p className="text-xs text-secondary">{t('quests.noObjectives')}</p>}
            {quest.objectives.map((o, i) => (
              <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 34 }}>
                <Toggle
                  checked={o.done}
                  onChange={() => toggleObjective(o)}
                  disabled={!canToggleObjectives || !!pendingObjectives[o.id]}
                  title={!canToggleObjectives ? t('quests.objectiveToggleHint') : undefined}
                  label={o.done ? t('quests.markNotDone', { text: o.text }) : t('quests.markDone', { text: o.text })}
                  size={17}
                />
                {editingObjectiveId === o.id ? (
                  <div className="flex-1 flex items-center gap-2">
                    <TextInput density="xs"
                      value={objectiveDraft}
                      onChange={(e) => setObjectiveDraft(e.target.value)}
                      className="text-sm"
                      autoFocus
                    />
                    <button onClick={() => saveObjectiveText(o)} className="text-xs text-[var(--color-accent)] hover:underline shrink-0">
                      {t('quests.save')}
                    </button>
                    <button
                      onClick={() => setEditingObjectiveId(null)}
                      className="text-xs text-secondary hover:text-[var(--color-neutral-300)] shrink-0"
                    >
                      {t('quests.cancel')}
                    </button>
                  </div>
                ) : (
                  <>
                    <span
                      style={{
                        fontSize: 14,
                        flex: 1,
                        textDecorationLine: o.done ? 'line-through' : 'none',
                        opacity: o.done ? 0.6 : 1,
                      }}
                    >
                      {o.text}
                    </span>
                    {canDmWrite && (
                      <>
                        <button
                          onClick={() => reorderObjective(i, -1)}
                          disabled={i === 0}
                          aria-label={t('quests.moveUp', { text: o.text })}
                          className="text-xs text-secondary hover:text-[var(--color-neutral-300)] disabled:opacity-30 disabled:hover:text-[var(--color-text-secondary)] shrink-0"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => reorderObjective(i, 1)}
                          disabled={i === quest.objectives.length - 1}
                          aria-label={t('quests.moveDown', { text: o.text })}
                          className="text-xs text-secondary hover:text-[var(--color-neutral-300)] disabled:opacity-30 disabled:hover:text-[var(--color-text-secondary)] shrink-0"
                        >
                          ↓
                        </button>
                        <button onClick={() => startEditObjective(o)} className="text-xs text-secondary hover:text-[var(--color-neutral-300)] shrink-0">
                          ✎
                        </button>
                        <button
                          onClick={() => void deleteObjective(o)}
                          aria-label={t('quests.deleteObjective', { text: o.text })}
                          className="text-xs text-rose-400 hover:text-rose-300 shrink-0"
                        >
                          🗑
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            ))}
            {canDmWrite && (
              <form
                className="flex items-center gap-2 pl-1"
                onSubmit={compositionSafeFormSubmit(objectiveCompositionGate, () => {
                  void addObjective();
                })}
              >
                <TextInput density="xs"
                  value={newObjective}
                  onChange={(e) => setNewObjective(e.target.value)}
                  placeholder={t('quests.newObjectivePlaceholder')}
                  className="text-xs max-w-xs"
                  {...objectiveCompositionGate.inputProps}
                />
                <button
                  type="submit"
                  disabled={addingObjective || !newObjective.trim()}
                  className="text-xs text-secondary hover:text-[var(--color-neutral-300)] disabled:opacity-50"
                >
                  {t('quests.addObjective')}
                </button>
              </form>
            )}

            {hasSubs && (
              <>
                <span className="card-kicker" style={{ marginTop: 6 }}>
                  {t('quests.subquests')}
                </span>
                {subquests.map((sq) => (
                  <div key={sq.id} style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 30 }}>
                    <span className="text-muted">↳</span>
                    <Link
                      to={`/c/${campaignId}/quests/${sq.id}`}
                      state={preserveListOriginState(location.state)}
                      style={{ color: 'var(--color-neutral-200)', fontSize: 14, textDecoration: 'none' }}
                    >
                      {sq.title}
                    </Link>
                    <QuestStatusBadge status={sq.status} />
                  </div>
                ))}
              </>
            )}
            {canDmWrite && (
              <Link
                to={`/c/${campaignId}/quests/new?parent=${questId}`}
                className="text-xs text-secondary hover:text-[var(--color-neutral-300)] pl-1 inline-block"
                style={{ marginTop: hasSubs ? 0 : 6 }}
              >
                {t('quests.addSubquest')}
              </Link>
            )}
          </Card>

          {/* Body revision history + restore (#157/#233) — DM-only, so a clobbered or
              regretted edit is recoverable. Refetches after each body save. */}
          {isDm && (
            <RevisionHistoryPanel
              entityType="quest"
              entityId={quest.id}
              currentSnapshot={{ body: quest.body }}
              expectedUpdatedAt={quest.updatedAt}
              reloadNonce={historyNonce}
              onRestored={() => {
                setHistoryNonce((n) => n + 1);
                void reloadBody();
              }}
            />
          )}

          {showSecret && (
            <Card
              density="compact" className="cf-print-secret"
              style={{
                border: '1px solid var(--color-accent-700)',
                background: 'color-mix(in srgb, var(--color-accent) 5%, var(--color-surface))',
              }}
            >
              <span className="card-kicker">{t('quests.dmOnly')}</span>
              {editingDmSecret ? (
                <div className="space-y-2">
                  <TextArea style={{ minHeight: 100 }} value={dmSecretDraft} onChange={(e) => setDmSecretDraft(e.target.value)} />
                  <div className="flex gap-2 justify-end">
                    <Btn density="xs" ghost onClick={() => setEditingDmSecret(false)} className="text-xs">
                      {t('quests.cancel')}
                    </Btn>
                    <Btn density="xs" onClick={saveDmSecret} disabled={savingDmSecret} className="text-xs">
                      {savingDmSecret ? t('quests.saving') : t('quests.save')}
                    </Btn>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <p style={{ margin: 0, fontSize: 13.5, color: 'var(--color-accent-200)', whiteSpace: 'pre-wrap' }}>{quest.dmSecret}</p>
                  {canDmWrite && (
                    <button
                      onClick={() => {
                        setDmSecretDraft(quest.dmSecret);
                        setEditingDmSecret(true);
                      }}
                      className="text-[10px] text-secondary hover:text-[var(--color-neutral-300)] shrink-0"
                    >
                      {t('quests.editSmall')}
                    </button>
                  )}
                </div>
              )}
            </Card>
          )}
          {canDmWrite && !quest.dmSecret && !editingDmSecret && (
            <button
              onClick={() => {
                setDmSecretDraft('');
                setEditingDmSecret(true);
              }}
              className="text-xs text-secondary hover:text-[var(--color-neutral-300)]"
            >
              {t('quests.addDmNotes')}
            </button>
          )}

          <EncounterBacklinksCard campaignId={campaignId} encounters={quest.linkedEncounters ?? []} />

          <div className="cf-print-hide"><EntityDiscussion campaignId={campaignId} entityType="quest" entityId={quest.id} /></div>
        </div>

        <div className="lg:col-span-5" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <Card density="compact" elev="sm">
            <span className="card-kicker">{t('quests.facts')}</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span className="text-muted">{t('quests.reward')}</span>
                <span>{quest.reward || '—'}</span>
              </div>
              {giver && (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span className="text-muted">{t('quests.givenBy')}</span>
                  <Link to={`/c/${campaignId}/npcs/${giver.id}`} style={{ color: 'var(--color-accent)', fontSize: 13, textDecoration: 'none' }}>
                    {giver.name}
                  </Link>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span className="text-muted">{t('quests.statusLabel')}</span>
                <QuestStatusBadge status={quest.status} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span className="text-muted">{t('quests.updated')}</span>
                <span title={quest.updatedAt}>{timeAgo(quest.updatedAt)}</span>
              </div>
            </div>
          </Card>

          <div className="cf-print-hide"><NotesRail campaignId={campaignId} entityType="quest" entityId={questId} /></div>
        </div>
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title={t('quests.deleteConfirmTitle', { title: quest.title })}
          body={
            <>
              {t('quests.deleteBody1')}
              {hasSubs ? t('quests.deleteBodySubs') : ''}{' '}
              {t('quests.deleteBodyUndone')}
            </>
          }
          confirmLabel={t('quests.deleteQuest')}
          pendingLabel={t('quests.deleting')}
          busy={deleting}
          onConfirm={deleteQuest}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
      {pendingUndo && quest && (
        <UndoSnackbar
          message={t('quests.deletedUndo', { defaultValue: 'Quest moved to Trash.' })}
          onUndo={undoDelete}
          onExpire={() => navigate(`/c/${campaignId}/quests`)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create view (dm only) — questId === 'new'
// ---------------------------------------------------------------------------

function QuestCreatePage({ campaignId }: { campaignId: number }) {
  const { t } = useTranslation();
  const { isDm } = useCampaignAccess();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const parentId = searchParams.get('parent');

  const [npcs, setNpcs] = useState<Npc[]>([]);
  const [parentQuests, setParentQuests] = useState<Quest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reward, setReward] = useState('');
  const [giverNpcId, setGiverNpcId] = useState<string>('');
  const [parent, setParent] = useState<string>(parentId ?? '');
  // #754: create defaults to DM-only; AudienceField is the creation-time choice.
  const [audience, setAudience] = useState<AudienceValue>('dm');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);

  // Associated create-form ids (issue #452) — stable prefixes for labels/help/errors.
  const prefix = QUEST_NEW_FORM_PREFIX;
  const titleId = questFieldId(prefix, 'title');
  const titleHelpId = questFieldHelpId(prefix, 'title');
  const titleErrorId = questFieldErrorId(prefix, 'title');
  const bodyId = questFieldId(prefix, 'body');
  const bodyHelpId = questFieldHelpId(prefix, 'body');
  const rewardId = questFieldId(prefix, 'reward');
  const rewardHelpId = questFieldHelpId(prefix, 'reward');
  const giverId = questFieldId(prefix, 'giver');
  const giverHelpId = questFieldHelpId(prefix, 'giver');
  const parentFieldId = questFieldId(prefix, 'parent');
  const parentHelpId = questFieldHelpId(prefix, 'parent');
  const titleDescribedBy = titleError ? `${titleHelpId} ${titleErrorId}` : titleHelpId;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      setForbidden(false);
      try {
        const [npcList, questList] = await Promise.all([
          api.get<Npc[]>(`${API}/campaigns/${campaignId}/npcs`),
          api.get<Quest[]>(`${API}/campaigns/${campaignId}/quests`),
        ]);
        if (cancelled) return;
        setNpcs(npcList);
        setParentQuests(questList);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          setForbidden(true);
        } else {
          setError(t('quests.loadCampaignFailed'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [campaignId, t]);

  if (!isDm) {
    return (
      <PageShell campaignId={campaignId}>
        <Card>
          <EmptyState icon="padlock" title={t('quests.onlyDmCreate')} />
        </Card>
      </PageShell>
    );
  }

  if (forbidden) {
    return (
      <PageShell campaignId={campaignId}>
        <Card>
          <EmptyState icon="padlock" title={t('quests.noAccess')} />
        </Card>
      </PageShell>
    );
  }

  async function create() {
    if (!title.trim()) {
      setTitleError(QUEST_TITLE_REQUIRED_ERROR);
      document.getElementById(titleId)?.focus();
      return;
    }
    setTitleError(null);
    setSaving(true);
    setSaveError(null);
    try {
      const hidden = audienceToHidden(audience);
      const created = await api.post<Quest>(`${API}/campaigns/${campaignId}/quests`, {
        title: title.trim(),
        body,
        reward,
        giverNpcId: giverNpcId ? Number(giverNpcId) : null,
        parentId: parent ? Number(parent) : null,
        hidden,
      });
      navigate(`/c/${campaignId}/quests/${created.id}`);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : t('quests.createFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageShell campaignId={campaignId}>
      <section className="lg:col-span-2 space-y-5" aria-labelledby="quest-create-heading">
        <Card className="space-y-4" data-testid="quest-create-form">
          <h1 id="quest-create-heading" className="text-2xl font-extrabold text-white">
            {t('quests.newQuestHeading')}
          </h1>
          {error && <ErrorNote message={error} />}
          {saveError && <ErrorNote message={saveError} onRetry={create} />}
          {loading ? (
            <Skeleton lines={4} />
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label htmlFor={titleId} className="text-xs font-bold text-secondary uppercase tracking-wide">
                  {QUEST_TITLE_LABEL}
                </label>
                <TextInput
                  id={titleId}
                  value={title}
                  aria-invalid={titleError != null}
                  aria-describedby={titleDescribedBy}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleError(null);
                  }}
                  placeholder={t('quests.titlePlaceholder')}
                  maxLength={200}
                />
                <p id={titleHelpId} className="text-[11px] text-secondary m-0">
                  {QUEST_TITLE_HELP}
                </p>
                {titleError && (
                  <p id={titleErrorId} role="alert" className="text-xs text-rose-400 m-0">
                    {titleError}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <label htmlFor={bodyId} className="text-xs font-bold text-secondary uppercase tracking-wide">
                  {QUEST_BODY_LABEL}
                </label>
                <TextArea
                  id={bodyId}
                  style={{ minHeight: 140 }}
                  value={body}
                  aria-describedby={bodyHelpId}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={t('quests.bodyPlaceholder')}
                />
                <p id={bodyHelpId} className="text-[11px] text-secondary m-0">
                  {QUEST_BODY_HELP}
                </p>
              </div>
              <div className="space-y-1">
                <label htmlFor={rewardId} className="text-xs font-bold text-secondary uppercase tracking-wide">
                  {QUEST_REWARD_LABEL}
                </label>
                <TextInput
                  id={rewardId}
                  value={reward}
                  aria-describedby={rewardHelpId}
                  onChange={(e) => setReward(e.target.value)}
                  placeholder={t('quests.rewardPlaceholder')}
                />
                <p id={rewardHelpId} className="text-[11px] text-secondary m-0">
                  {QUEST_REWARD_HELP}
                </p>
              </div>
              <div className="space-y-1">
                <label htmlFor={giverId} className="text-xs font-bold text-secondary uppercase tracking-wide">
                  {QUEST_GIVER_LABEL}
                </label>
                <select
                  id={giverId}
                  className="cf-select"
                  value={giverNpcId}
                  aria-describedby={giverHelpId}
                  onChange={(e) => setGiverNpcId(e.target.value)}
                >
                  <option value="">{t('quests.giverNone')}</option>
                  {npcs.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>
                <p id={giverHelpId} className="text-[11px] text-secondary m-0">
                  {QUEST_GIVER_HELP}
                </p>
              </div>
              <div className="space-y-1">
                <label htmlFor={parentFieldId} className="text-xs font-bold text-secondary uppercase tracking-wide">
                  {QUEST_PARENT_LABEL}
                </label>
                <select
                  id={parentFieldId}
                  className="cf-select"
                  value={parent}
                  aria-describedby={parentHelpId}
                  onChange={(e) => setParent(e.target.value)}
                >
                  <option value="">{t('quests.parentNone')}</option>
                  {parentQuests.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.title}
                    </option>
                  ))}
                </select>
                <p id={parentHelpId} className="text-[11px] text-secondary m-0">
                  {QUEST_PARENT_HELP}
                </p>
              </div>
              <AudienceField value={audience} onChange={setAudience} entityLabel="quest" name="quest-audience" />
              <div className="flex justify-end gap-2 pt-2">
                <Btn ghost onClick={() => navigate(-1)}>
                  {t('quests.cancel')}
                </Btn>
                <Btn onClick={create} disabled={saving}>
                  {saving ? t('quests.creating') : t('quests.createQuest')}
                </Btn>
              </div>
            </div>
          )}
        </Card>
      </section>
      <aside className="space-y-5" />
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

function PageShell({ children }: { campaignId: number; children: React.ReactNode }) {
  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 grid grid-cols-1 lg:grid-cols-3 gap-5 pb-20 lg:pb-10">
      {children}
    </div>
  );
}



// Localized display word for a quest status, used in trigger labels and
// announcements so the menu reads "Quest status: Active" instead of the raw
// enum value. Mirrors QuestStatusBadge's presentation label set.
function questStatusWord(t: (key: string, opts?: Record<string, unknown>) => string, status: QuestStatusValue): string {
  switch (status) {
    case 'available':
      return t('quests.statusWordAvailable');
    case 'active':
      return t('quests.statusWordActive');
    case 'completed':
      return t('quests.statusWordCompleted');
    case 'failed':
      return t('quests.statusWordFailed');
    default:
      return status;
  }
}
