/**
 * Quest detail page — fidelity-synced to design/claude-design/Campfire.dc.html
 * "Quest detail" screen (~L571-629).
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
  Btn,
  TextInput,
  TextArea,
  EmptyState,
  Skeleton,
  ErrorNote,
  statusVariant,
} from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { NotesRail } from '../../components/NotesRail';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Toggle } from '../../components/Toggle';

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
  const navigate = useNavigate();

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

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Objectives being toggled right now (keyed by objective id). Guards against the
  // optimistic-update race where a fast double-toggle could roll back to the wrong
  // "previous" value — see toggleObjective below.
  const [pendingObjectives, setPendingObjectives] = useState<Record<number, boolean>>({});

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
      setError("Couldn't update the objective.");
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

  // NOTE ON DELETE BEHAVIOR: QuestsService.remove() (apps/server/src/modules/quests/
  // quests.service.ts) promotes any subquests to top-level (parentId=null) and deletes
  // this quest's own objectives, all in a single transaction — subquests are never
  // orphaned or cascade-deleted. The confirm copy below reflects that.
  async function deleteQuest() {
    if (!quest) return;
    setDeleting(true);
    setError(null);
    try {
      await api.delete(`${API}/quests/${quest.id}`);
      navigate(`/c/${campaignId}/quests`);
    } catch {
      setError("Couldn't delete this quest.");
      setDeleting(false);
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

  const hasSubs = subquests.length > 0;
  const showSecret = isDm && (quest.dmSecret || editingDmSecret);

  return (
    <div className="max-w-6xl mx-auto px-4 mt-5 pb-20 lg:pb-10" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <ErrorNote message={error} onRetry={load} />}

      <div>
        <Link to={`/c/${campaignId}/quests`} className="btn btn-ghost" style={{ fontSize: 13 }}>
          ← Back
        </Link>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{quest.title}</h3>
        <Chip variant={statusVariant(quest.status)}>{capitalize(quest.status)}</Chip>
        {isDm && (
          <>
            <div style={{ flex: 1 }} />
            <Btn
              ghost
              className="!min-h-0 !py-1.5 text-xs"
              onClick={() => {
                setBodyDraft(quest.body);
                setEditingBody((v) => !v);
              }}
            >
              ✎ Edit quest
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
            <Btn danger className="!min-h-0 !py-1.5 text-xs" onClick={() => setConfirmingDelete(true)}>
              Delete
            </Btn>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        <div className="lg:col-span-7" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <div className="card elev-sm">
            {editingBody ? (
              <div className="space-y-2">
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
              <Markdown>{quest.body}</Markdown>
            )}

            <div className="hr" style={{ margin: '6px 0' }} />

            <span className="card-kicker">Objectives</span>
            {quest.objectives.length === 0 && <p className="text-xs text-slate-600">No objectives yet.</p>}
            {quest.objectives.map((o) => (
              <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 34 }}>
                <Toggle
                  checked={o.done}
                  onChange={() => toggleObjective(o)}
                  disabled={!canToggleObjectives || !!pendingObjectives[o.id]}
                  label={o.done ? `Mark "${o.text}" not done` : `Mark "${o.text}" done`}
                  size={17}
                />
                {editingObjectiveId === o.id ? (
                  <div className="flex-1 flex items-center gap-2">
                    <TextInput
                      value={objectiveDraft}
                      onChange={(e) => setObjectiveDraft(e.target.value)}
                      className="!py-1 text-sm"
                      autoFocus
                    />
                    <button onClick={() => saveObjectiveText(o)} className="text-xs text-[var(--color-accent)] hover:underline shrink-0">
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
                    {isDm && (
                      <button onClick={() => startEditObjective(o)} className="text-xs text-slate-500 hover:text-slate-300 shrink-0">
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
                  + objective
                </button>
              </div>
            )}

            {hasSubs && (
              <>
                <span className="card-kicker" style={{ marginTop: 6 }}>
                  Subquests
                </span>
                {subquests.map((sq) => (
                  <div key={sq.id} style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 30 }}>
                    <span className="text-muted">↳</span>
                    <Link
                      to={`/c/${campaignId}/quests/${sq.id}`}
                      style={{ color: 'var(--color-neutral-200)', fontSize: 14, textDecoration: 'none' }}
                    >
                      {sq.title}
                    </Link>
                    <span className="tag tag-neutral" style={{ fontSize: 10 }}>
                      {capitalize(sq.status)}
                    </span>
                  </div>
                ))}
              </>
            )}
            {isDm && (
              <Link
                to={`/c/${campaignId}/quests/new?parent=${questId}`}
                className="text-xs text-slate-500 hover:text-slate-300 pl-1 inline-block"
                style={{ marginTop: hasSubs ? 0 : 6 }}
              >
                + sub-quest
              </Link>
            )}
          </div>

          {showSecret && (
            <div
              className="card"
              style={{
                border: '1px solid var(--color-accent-700)',
                background: 'color-mix(in srgb, var(--color-accent) 5%, var(--color-surface))',
              }}
            >
              <span className="card-kicker">DM only — hidden from players</span>
              {editingDmSecret ? (
                <div className="space-y-2">
                  <TextArea style={{ minHeight: 100 }} value={dmSecretDraft} onChange={(e) => setDmSecretDraft(e.target.value)} />
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
                <div className="flex items-start justify-between gap-3">
                  <p style={{ margin: 0, fontSize: 13.5, color: 'var(--color-accent-200)', whiteSpace: 'pre-wrap' }}>{quest.dmSecret}</p>
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
        </div>

        <div className="lg:col-span-5" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <div className="card elev-sm">
            <span className="card-kicker">Facts</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span className="text-muted">Reward</span>
                <span>{quest.reward || '—'}</span>
              </div>
              {giver && (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span className="text-muted">Given by</span>
                  <Link to={`/c/${campaignId}/npcs/${giver.id}`} style={{ color: 'var(--color-accent)', fontSize: 13, textDecoration: 'none' }}>
                    {giver.name}
                  </Link>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span className="text-muted">Status</span>
                <span>{capitalize(quest.status)}</span>
              </div>
            </div>
          </div>

          <NotesRail campaignId={campaignId} entityType="quest" entityId={questId} />
        </div>
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete "${quest.title}"?`}
          body={
            <>
              This permanently deletes the quest and its objectives.
              {hasSubs
                ? ` Subquests will be promoted to top-level quests.`
                : ''}{' '}
              This can&apos;t be undone.
            </>
          }
          confirmLabel={deleting ? 'Deleting…' : 'Delete quest'}
          busy={deleting}
          onConfirm={deleteQuest}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
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
