/**
 * NPC detail — mirrors design/claude-design/Campfire.dc.html "NPC detail" (~632-667).
 * Layout: back link, avatar + name/role + disposition badge header, then a two-column
 * body — body copy (+ DM-secret panel) on the left, Facts + Notes cards on the right.
 * DM: edit (name/role/disposition/location/body), dmSecret panel, delete.
 * Everyone: header, facts card, markdown body, connected quests, notes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Location, Npc, Quest } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, TextArea, Skeleton, ErrorNote, DmPanel, EmptyState, statusVariant } from '../../components/ui';
import { NotFoundState } from '../../components/NotFoundState';
import { Markdown } from '../../components/Markdown';
import { NotesRail } from '../../components/NotesRail';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoSnackbar } from '../../components/UndoSnackbar';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function dispositionVariant(disposition: string) {
  const d = disposition.toLowerCase();
  if (d.includes('friend') || d.includes('ally') || d.includes('trust')) return 'completed' as const;
  if (d.includes('hostile') || d.includes('enemy') || d.includes('wary')) return 'failed' as const;
  if (d.includes('warm') || d.includes('active')) return 'active' as const;
  return statusVariant(disposition);
}

export default function NpcPage() {
  const { campaignId, npcId } = useParams<{ campaignId: string; npcId: string }>();
  const cid = Number(campaignId);
  const id = Number(npcId);
  const navigate = useNavigate();
  const { roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';

  const [npc, setNpc] = useState<Npc | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [quests, setQuests] = useState<Quest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', role: '', disposition: '', locationId: '' as string, body: '', dmSecret: '', hidden: false });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pendingUndo, setPendingUndo] = useState(false);
  const [togglingHidden, setTogglingHidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const [npcData, locationsData, questsData] = await Promise.all([
        api.get<Npc>(`${API}/npcs/${id}`),
        api.get<Location[]>(`${API}/campaigns/${cid}/locations`),
        api.get<Quest[]>(`${API}/campaigns/${cid}/quests`),
      ]);
      setNpc(npcData);
      setLocations(locationsData);
      setQuests(questsData);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't load this NPC.");
      }
    } finally {
      setLoading(false);
    }
  }, [cid, id]);

  useEffect(() => {
    if (Number.isFinite(cid) && Number.isFinite(id)) void load();
  }, [cid, id, load]);

  const locationName = useMemo(
    () => (npc?.locationId ? locations.find((l) => l.id === npc.locationId)?.name : null),
    [npc, locations],
  );

  const connectedQuests = useMemo(() => quests.filter((q) => q.giverNpcId === id), [quests, id]);

  function startEdit() {
    if (!npc) return;
    setForm({
      name: npc.name,
      role: npc.role,
      disposition: npc.disposition,
      locationId: npc.locationId ? String(npc.locationId) : '',
      body: npc.body,
      dmSecret: npc.dmSecret,
      hidden: npc.hidden,
    });
    setSaveError(null);
    setEditing(true);
  }

  // Entity-level secrecy (issue #42): reveal/hide the whole NPC from players.
  async function toggleHidden() {
    if (!npc) return;
    setTogglingHidden(true);
    try {
      const updated = await api.patch<Npc>(`${API}/npcs/${id}`, { hidden: !npc.hidden });
      setNpc(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change visibility.");
    } finally {
      setTogglingHidden(false);
    }
  }

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.patch<Npc>(`${API}/npcs/${id}`, {
        name: form.name.trim(),
        role: form.role.trim(),
        disposition: form.disposition.trim() || 'neutral',
        locationId: form.locationId ? Number(form.locationId) : null,
        body: form.body,
        dmSecret: form.dmSecret,
        hidden: form.hidden,
      });
      setNpc(updated);
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Couldn't save changes.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      // Soft-delete (issue #116) — reversible; offer an Undo instead of navigating away.
      await api.delete(`${API}/npcs/${id}`);
      setConfirmingDelete(false);
      setPendingUndo(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this NPC.");
    } finally {
      setDeleting(false);
    }
  }

  async function undoDelete() {
    await api.post(`${API}/npcs/${id}/restore`);
    setPendingUndo(false);
    await load();
  }

  if (!Number.isFinite(cid) || !Number.isFinite(id)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message="No NPC selected." />
      </div>
    );
  }

  if (loading && !npc) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <Card>
          <Skeleton lines={6} />
        </Card>
      </div>
    );
  }

  if (notFound && !npc) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <NotFoundState title="NPC not found" backTo={`/c/${cid}/npcs`} backLabel="← Back to NPCs" />
      </div>
    );
  }

  if (error && !npc) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  if (!npc) return null;

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <div>
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => navigate(`/c/${cid}/npcs`)}>
          ← Back
        </Btn>
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {!editing && (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="h-13 w-13 rounded-full bg-[var(--color-neutral-900)] border border-[var(--color-divider)] flex items-center justify-center text-base text-[var(--color-neutral-400)] shrink-0" style={{ height: 52, width: 52 }}>
              {initials(npc.name)}
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-extrabold text-white leading-tight break-words">{npc.name}</h1>
              {npc.role && <p className="text-sm text-slate-400 break-words">{npc.role}</p>}
            </div>
            <Chip variant={dispositionVariant(npc.disposition)}>{npc.disposition || 'Neutral'}</Chip>
            {isDm && npc.hidden && <Chip variant="failed">🙈 Hidden from players</Chip>}
            {isDm && (
              <div className="flex gap-2 ml-auto">
                <Btn
                  ghost
                  className="!min-h-0 !py-1.5 text-xs"
                  disabled={togglingHidden}
                  onClick={toggleHidden}
                  title={npc.hidden ? 'Make this NPC visible to players' : 'Hide this NPC from players'}
                >
                  {togglingHidden ? '…' : npc.hidden ? '👁 Reveal' : '🙈 Hide'}
                </Btn>
                <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={startEdit}>
                  ✎ Edit
                </Btn>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-4 items-start">
            <div className="space-y-4 min-w-0">
              <Card>
                {npc.body ? <Markdown>{npc.body}</Markdown> : <p className="text-sm text-slate-500 italic">No description yet.</p>}
              </Card>

              {isDm && npc.dmSecret && <DmPanel>{npc.dmSecret}</DmPanel>}

              <Card className="space-y-3">
                <h2 className="font-bold text-white text-sm">Connected</h2>
                {connectedQuests.length === 0 ? (
                  <EmptyState icon="📜" title="No connected quests" />
                ) : (
                  <div className="grid sm:grid-cols-2 gap-3">
                    {connectedQuests.map((q) => (
                      <a
                        key={q.id}
                        href={`/c/${cid}/quests/${q.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`/c/${cid}/quests/${q.id}`);
                        }}
                        className="cf-inset p-3 hover:border-amber-500/50"
                      >
                        <p className="text-sm font-bold text-amber-400">📜 {q.title}</p>
                        <Chip variant={statusVariant(q.status)} className="mt-1">
                          {q.status}
                        </Chip>
                      </a>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <div className="space-y-4 min-w-0">
              <Card className="space-y-2">
                <p className="card-kicker">Facts</p>
                <div className="flex justify-between gap-2 text-[13px]">
                  <span className="text-muted">Disposition</span>
                  <span>{npc.disposition || 'Neutral'}</span>
                </div>
                <div className="flex justify-between gap-2 text-[13px]">
                  <span className="text-muted">Last seen</span>
                  {locationName ? (
                    <a
                      href={`/c/${cid}/locations/${npc.locationId}`}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(`/c/${cid}/locations/${npc.locationId}`);
                      }}
                      className="text-[13px]"
                      style={{ color: 'var(--color-accent)' }}
                    >
                      {locationName}
                    </a>
                  ) : (
                    <span className="text-muted">Unknown</span>
                  )}
                </div>
              </Card>

              <NotesRail campaignId={cid} entityType="npc" entityId={id} />
            </div>
          </div>
        </>
      )}

      {editing && (
        <Card className="space-y-3">
          {saveError && <ErrorNote message={saveError} />}
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] text-slate-500 font-bold uppercase">Name</label>
              <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-slate-500 font-bold uppercase">Role</label>
              <TextInput value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-slate-500 font-bold uppercase">Disposition</label>
              <TextInput value={form.disposition} onChange={(e) => setForm({ ...form, disposition: e.target.value })} />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-slate-500 font-bold uppercase">Location</label>
              <select
                className="cf-select"
                value={form.locationId}
                onChange={(e) => setForm({ ...form, locationId: e.target.value })}
              >
                <option value="">Unknown / none</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-slate-500 font-bold uppercase">Description (markdown)</label>
            <TextArea style={{ minHeight: 140 }} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-amber-500 font-bold uppercase">🔒 DM secret</label>
            <TextArea style={{ minHeight: 90 }} value={form.dmSecret} onChange={(e) => setForm({ ...form, dmSecret: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
            <input type="checkbox" checked={form.hidden} onChange={(e) => setForm({ ...form, hidden: e.target.checked })} />
            <span>🙈 Hidden from players (whole NPC, not just the secret)</span>
          </label>
          <div className="flex items-center justify-between gap-2">
            <Btn danger className="!min-h-0 !py-1.5 text-xs" disabled={deleting} onClick={() => setConfirmingDelete(true)}>
              {deleting ? 'Deleting…' : 'Delete NPC'}
            </Btn>
            <div className="flex gap-2">
              <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setEditing(false)}>
                Cancel
              </Btn>
              <Btn className="!min-h-0 !py-1.5 text-xs" disabled={saving || !form.name.trim()} onClick={save}>
                {saving ? 'Saving…' : 'Save'}
              </Btn>
            </div>
          </div>
        </Card>
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete ${npc?.name}?`}
          body="This moves the NPC to the Trash — you can undo it, or restore it from the campaign Trash."
          confirmLabel={deleting ? 'Deleting…' : 'Delete NPC'}
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
      {pendingUndo && (
        <UndoSnackbar
          message="NPC moved to Trash."
          onUndo={undoDelete}
          onExpire={() => navigate(`/c/${cid}/npcs`)}
        />
      )}
    </div>
  );
}
