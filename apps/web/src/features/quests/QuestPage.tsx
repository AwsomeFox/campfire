/**
 * Quest detail page — mirrors design/03-quest-detail.html.
 * Route: /c/:campaignId/quests/:questId (questId === 'new' renders the dm create form).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Quest, QuestObjective, Npc } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import {
  Card,
  Chip,
  Inset,
  Btn,
  TextInput,
  TextArea,
  DmPanel,
  EmptyState,
  Skeleton,
  ErrorNote,
  statusVariant,
} from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { NotesRail } from '../../components/NotesRail';

type QuestWithObjectives = Quest & { objectives: QuestObjective[] };
type QuestStatusValue = Quest['status'];

const STATUS_OPTIONS: QuestStatusValue[] = ['available', 'active', 'completed', 'failed'];

export default function QuestPage() {
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
  const { roleIn } = useAuth();
  const role = roleIn(campaignId);
  const isDm = role === 'dm';
  const canToggleObjectives = role === 'dm' || role === 'player';

  const [quest, setQuest] = useState<QuestWithObjectives | null>(null);
  const [siblingQuests, setSiblingQuests] = useState<Quest[]>([]);
  const [giver, setGiver] = useState<Npc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState('');
  const [savingBody, setSavingBody] = useState(false);

  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);

  const [newObjective, setNewObjective] = useState('');
  const [addingObjective, setAddingObjective] = useState(false);
  const [editingObjectiveId, setEditingObjectiveId] = useState<number | null>(null);
  const [objectiveDraft, setObjectiveDraft] = useState('');

  const [editingDmSecret, setEditingDmSecret] = useState(false);
  const [dmSecretDraft, setDmSecretDraft] = useState('');
  const [savingDmSecret, setSavingDmSecret] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    setLoading(true);
    try {
      const q = await api.get<QuestWithObjectives>(`${API}/quests/${questId}`);
      setQuest(q);
      setBodyDraft(q.body);
      setDmSecretDraft(q.dmSecret);

      const campaignQuests = await api.get<Quest[]>(`${API}/campaigns/${campaignId}/quests`);
      setSiblingQuests(campaignQuests);

      if (q.giverNpcId) {
        try {
          const npc = await api.get<Npc>(`${API}/npcs/${q.giverNpcId}`);
          setGiver(npc);
        } catch {
          setGiver(null);
        }
      } else {
        setGiver(null);
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setError("Couldn't load this quest.");
      }
    } finally {
      setLoading(false);
    }
  }, [campaignId, questId]);

  useEffect(() => {
    void load();
  }, [load]);

  const subquests = useMemo(
    () => siblingQuests.filter((q) => q.parentId === questId),
    [siblingQuests, questId],
  );

  async function saveBody() {
    if (!quest) return;
    setSavingBody(true);
    try {
      const updated = await api.patch<Quest>(`${API}/quests/${quest.id}`, { body: bodyDraft });
      setQuest({ ...quest, ...updated });
      setEditingBody(false);
    } catch {
      setError("Couldn't save the quest body.");
    } finally {
      setSavingBody(false);
    }
  }

  async function saveStatus(status: QuestStatusValue) {
    if (!quest) return;
    setSavingStatus(true);
    try {
      const updated = await api.post<Quest>(`${API}/quests/${quest.id}/status`, { status });
      setQuest({ ...quest, ...updated });
      setStatusMenuOpen(false);
    } catch {
      setError("Couldn't update quest status.");
    } finally {
      setSavingStatus(false);
    }
  }

  async function toggleObjective(objective: QuestObjective) {
    if (!quest) return;
    // optimistic update
    const prev = quest.objectives;
    setQuest({ ...quest, objectives: prev.map((o) => (o.id === objective.id ? { ...o, done: !o.done } : o)) });
    try {
      await api.patch<QuestObjective>(`${API}/quests/${quest.id}/objectives/${objective.id}`, {
        done: !objective.done,
      });
    } catch {
      setQuest((q) => (q ? { ...q, objectives: prev } : q));
      setError("Couldn't update the objective.");
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
      setError("Couldn't add the objective.");
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
      setError("Couldn't rename the objective.");
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
      setError("Couldn't save the DM notes.");
    } finally {
      setSavingDmSecret(false);
    }
  }

  if (forbidden) {
    return (
      <PageShell campaignId={campaignId}>
        <Card>
          <EmptyState icon="🔒" title="You don't have access to this campaign" />
        </Card>
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

  return (
    <PageShell campaignId={campaignId}>
      <main className="lg:col-span-2 space-y-5">
        <Card className="space-y-5">
          {error && <ErrorNote message={error} onRetry={load} />}
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-extrabold text-white">{quest.title}</h1>
                <Chip variant={statusVariant(quest.status)}>{capitalize(quest.status)}</Chip>
              </div>
              <p className="text-sm text-slate-400">
                {giver && (
                  <>
                    Given by{' '}
                    <Link to={`/c/${campaignId}/npcs/${giver.id}`} className="text-amber-400 hover:underline">
                      {giver.name}
                    </Link>
                  </>
                )}
                {quest.reward && (
                  <>
                    {giver ? ' · ' : ''}
                    Reward <span className="text-amber-400 font-bold">{quest.reward}</span>
                  </>
                )}
              </p>
            </div>
            {isDm && (
              <div className="flex gap-2 shrink-0">
                <Btn
                  ghost
                  className="!min-h-0 !py-1.5 text-xs"
                  onClick={() => {
                    setBodyDraft(quest.body);
                    setEditingBody((v) => !v);
                  }}
                >
                  ✎ Edit
                </Btn>
                <div className="relative">
                  <Btn
                    ghost
                    className="!min-h-0 !py-1.5 text-xs"
                    onClick={() => setStatusMenuOpen((v) => !v)}
                    disabled={savingStatus}
                  >
                    Status ▾
                  </Btn>
                  {statusMenuOpen && (
                    <div className="absolute right-0 mt-1 z-10 cf-card p-1 space-y-0.5 min-w-[140px]">
                      {STATUS_OPTIONS.map((s) => (
                        <button
                          key={s}
                          onClick={() => saveStatus(s)}
                          className={`w-full text-left text-xs rounded px-2 py-1.5 hover:bg-slate-700 ${
                            s === quest.status ? 'text-white font-semibold' : 'text-slate-300'
                          }`}
                        >
                          {capitalize(s)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {editingBody ? (
            <div className="space-y-2 border-t border-slate-700 pt-4">
              <TextArea
                style={{ minHeight: 140 }}
                value={bodyDraft}
                onChange={(e) => setBodyDraft(e.target.value)}
                placeholder="Quest body (markdown)…"
              />
              <div className="flex gap-2 justify-end">
                <Btn ghost onClick={() => setEditingBody(false)} className="!min-h-0 !py-1.5 text-xs">
                  Cancel
                </Btn>
                <Btn onClick={saveBody} disabled={savingBody} className="!min-h-0 !py-1.5 text-xs">
                  {savingBody ? 'Saving…' : 'Save'}
                </Btn>
              </div>
            </div>
          ) : (
            <div className="border-t border-slate-700 pt-4">
              <Markdown>{quest.body}</Markdown>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">
              Objectives <span className="font-normal normal-case">(players can tick)</span>
            </p>
            {quest.objectives.length === 0 && (
              <p className="text-xs text-slate-600">No objectives yet.</p>
            )}
            {quest.objectives.map((o) => (
              <div key={o.id} className="cf-inset flex items-center gap-3 p-3">
                <input
                  type="checkbox"
                  checked={o.done}
                  disabled={!canToggleObjectives}
                  onChange={() => toggleObjective(o)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-amber-500 shrink-0"
                />
                {editingObjectiveId === o.id ? (
                  <div className="flex-1 flex items-center gap-2">
                    <TextInput
                      value={objectiveDraft}
                      onChange={(e) => setObjectiveDraft(e.target.value)}
                      className="!py-1 text-sm"
                      autoFocus
                    />
                    <button
                      onClick={() => saveObjectiveText(o)}
                      className="text-xs text-amber-400 hover:underline shrink-0"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingObjectiveId(null)}
                      className="text-xs text-slate-500 hover:text-slate-300 shrink-0"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    {o.done ? (
                      <s className="text-sm text-slate-400 flex-1">{o.text}</s>
                    ) : (
                      <span className="text-sm text-slate-200 flex-1">{o.text}</span>
                    )}
                    {isDm && (
                      <button
                        onClick={() => startEditObjective(o)}
                        className="text-xs text-slate-500 hover:text-slate-300 shrink-0"
                      >
                        ✎
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
            {isDm && (
              <div className="flex items-center gap-2 pl-1">
                <TextInput
                  value={newObjective}
                  onChange={(e) => setNewObjective(e.target.value)}
                  placeholder="New objective…"
                  className="!py-1.5 text-xs max-w-xs"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addObjective();
                  }}
                />
                <button
                  onClick={addObjective}
                  disabled={addingObjective || !newObjective.trim()}
                  className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-50"
                >
                  + objective (DM)
                </button>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">Sub-quests</p>
            {subquests.length === 0 && <p className="text-xs text-slate-600">No sub-quests.</p>}
            {subquests.map((sq) => (
              <Link
                key={sq.id}
                to={`/c/${campaignId}/quests/${sq.id}`}
                className="cf-inset block p-3.5 space-y-1 hover:border-rose-500/50"
              >
                <div className="flex items-center justify-between">
                  <p className="font-bold text-rose-400 text-sm">{sq.title}</p>
                  <Chip variant={statusVariant(sq.status)}>{capitalize(sq.status)}</Chip>
                </div>
                {sq.reward && (
                  <p className="text-xs text-slate-400">
                    Reward: <span className="text-emerald-400 font-semibold">{sq.reward}</span>
                  </p>
                )}
              </Link>
            ))}
            {isDm && (
              <Link
                to={`/c/${campaignId}/quests/new?parent=${questId}`}
                className="text-xs text-slate-500 hover:text-slate-300 pl-1 inline-block"
              >
                + sub-quest
              </Link>
            )}
          </div>

          {isDm && (quest.dmSecret || editingDmSecret) && (
            <div className="space-y-1.5">
              {editingDmSecret ? (
                <div className="cf-dm-panel p-4 space-y-2">
                  <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">
                    🔒 DM only — stripped from API for players/viewers
                  </p>
                  <TextArea
                    style={{ minHeight: 100 }}
                    value={dmSecretDraft}
                    onChange={(e) => setDmSecretDraft(e.target.value)}
                  />
                  <div className="flex gap-2 justify-end">
                    <Btn ghost onClick={() => setEditingDmSecret(false)} className="!min-h-0 !py-1.5 text-xs">
                      Cancel
                    </Btn>
                    <Btn onClick={saveDmSecret} disabled={savingDmSecret} className="!min-h-0 !py-1.5 text-xs">
                      {savingDmSecret ? 'Saving…' : 'Save'}
                    </Btn>
                  </div>
                </div>
              ) : (
                <DmPanel>
                  <div className="flex items-start justify-between gap-3">
                    <p className="whitespace-pre-wrap flex-1">{quest.dmSecret}</p>
                    <button
                      onClick={() => {
                        setDmSecretDraft(quest.dmSecret);
                        setEditingDmSecret(true);
                      }}
                      className="text-[10px] text-slate-500 hover:text-slate-300 shrink-0"
                    >
                      ✎ edit
                    </button>
                  </div>
                </DmPanel>
              )}
            </div>
          )}
          {isDm && !quest.dmSecret && !editingDmSecret && (
            <button
              onClick={() => {
                setDmSecretDraft('');
                setEditingDmSecret(true);
              }}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              + DM notes
            </button>
          )}
        </Card>

        <Card className="space-y-3">
          <h2 className="font-bold text-white text-sm">Connected</h2>
          <div className="flex flex-wrap gap-2">
            {giver && (
              <Link to={`/c/${campaignId}/npcs/${giver.id}`} className="cf-chip cf-chip-active">
                🤝 {giver.name}
              </Link>
            )}
            {subquests.map((sq) => (
              <Link key={sq.id} to={`/c/${campaignId}/quests/${sq.id}`} className="cf-chip cf-chip-available">
                📜 {sq.title}
              </Link>
            ))}
            {!giver && subquests.length === 0 && <p className="text-xs text-slate-600">Nothing linked yet.</p>}
          </div>
        </Card>
      </main>

      <aside className="space-y-5">
        <NotesRail campaignId={campaignId} entityType="quest" entityId={questId} />
      </aside>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Create view (dm only) — questId === 'new'
// ---------------------------------------------------------------------------

function QuestCreatePage({ campaignId }: { campaignId: number }) {
  const { roleIn } = useAuth();
  const role = roleIn(campaignId);
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
          setError("Couldn't load campaign data.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  if (role !== null && role !== 'dm') {
    return (
      <PageShell campaignId={campaignId}>
        <Card>
          <EmptyState icon="🔒" title="Only the DM can create quests" />
        </Card>
      </PageShell>
    );
  }

  if (forbidden) {
    return (
      <PageShell campaignId={campaignId}>
        <Card>
          <EmptyState icon="🔒" title="You don't have access to this campaign" />
        </Card>
      </PageShell>
    );
  }

  async function create() {
    if (!title.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const created = await api.post<Quest>(`${API}/campaigns/${campaignId}/quests`, {
        title: title.trim(),
        body,
        reward,
        giverNpcId: giverNpcId ? Number(giverNpcId) : null,
        parentId: parent ? Number(parent) : null,
      });
      navigate(`/c/${campaignId}/quests/${created.id}`);
    } catch {
      setSaveError("Couldn't create the quest.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageShell campaignId={campaignId}>
      <main className="lg:col-span-2 space-y-5">
        <Card className="space-y-4">
          <h1 className="text-2xl font-extrabold text-white">New quest</h1>
          {error && <ErrorNote message={error} />}
          {saveError && <ErrorNote message={saveError} onRetry={create} />}
          {loading ? (
            <Skeleton lines={4} />
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Title</label>
                <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Quest title…" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Body</label>
                <TextArea
                  style={{ minHeight: 140 }}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Quest body (markdown)…"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Reward</label>
                <TextInput value={reward} onChange={(e) => setReward(e.target.value)} placeholder="e.g. 50 GP" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Giver</label>
                <select
                  className="cf-select"
                  value={giverNpcId}
                  onChange={(e) => setGiverNpcId(e.target.value)}
                >
                  <option value="">— none —</option>
                  {npcs.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Parent quest</label>
                <select className="cf-select" value={parent} onChange={(e) => setParent(e.target.value)}>
                  <option value="">— none (top-level) —</option>
                  {parentQuests.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Btn ghost onClick={() => navigate(-1)}>
                  Cancel
                </Btn>
                <Btn onClick={create} disabled={saving || !title.trim()}>
                  {saving ? 'Creating…' : 'Create quest'}
                </Btn>
              </div>
            </div>
          )}
        </Card>
      </main>
      <aside className="space-y-5" />
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

function PageShell({ campaignId, children }: { campaignId: number; children: React.ReactNode }) {
  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 grid grid-cols-1 lg:grid-cols-3 gap-5 pb-20 lg:pb-10">
      {children}
    </div>
  );
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
