/**
 * NPC detail — mirrors design/04-npc-detail.html.
 * DM: edit (name/role/disposition/location/body), dmSecret panel, delete.
 * Everyone: header, meta grid, markdown body, connected quests, notes rail.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Location, Npc, Quest } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, TextArea, Skeleton, ErrorNote, DmPanel, EmptyState, statusVariant } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { NotesRail } from '../../components/NotesRail';

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

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', role: '', disposition: '', locationId: '' as string, body: '', dmSecret: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
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
      setError(err instanceof ApiError ? err.message : "Couldn't load this NPC.");
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
    });
    setSaveError(null);
    setEditing(true);
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
    if (!confirm(`Delete ${npc?.name}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.delete(`${API}/npcs/${id}`);
      navigate(`/c/${cid}/npcs`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this NPC.");
      setDeleting(false);
    }
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

  if (error && !npc) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  if (!npc) return null;

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 grid grid-cols-1 lg:grid-cols-3 gap-5 pb-20 md:pb-10">
      <main className="lg:col-span-2 space-y-5">
        <Card className="md:p-6 space-y-5">
          {error && <ErrorNote message={error} onRetry={load} />}

          {!editing && (
            <>
              <div className="flex items-start gap-4">
                <div className="h-16 w-16 rounded-xl bg-amber-500/15 border border-amber-500/60 flex items-center justify-center text-xl font-bold text-amber-400 shrink-0">
                  {initials(npc.name)}
                </div>
                <div className="flex-1 space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h1 className="text-2xl font-extrabold text-white">{npc.name}</h1>
                    <Chip variant={dispositionVariant(npc.disposition)}>{npc.disposition || 'Neutral'}</Chip>
                  </div>
                  {npc.role && <p className="text-sm text-slate-400">{npc.role}</p>}
                </div>
                {isDm && (
                  <Btn ghost className="!min-h-0 !py-1.5 text-xs shrink-0" onClick={startEdit}>
                    ✎ Edit
                  </Btn>
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 border-y border-slate-700 py-4">
                <div>
                  <p className="text-[10px] text-slate-500 font-bold uppercase">Disposition</p>
                  <p className="text-sm font-semibold text-amber-400">{npc.disposition || 'Neutral'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-500 font-bold uppercase">Location</p>
                  {locationName ? (
                    <a
                      href={`/c/${cid}/locations/${npc.locationId}`}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(`/c/${cid}/locations/${npc.locationId}`);
                      }}
                      className="text-sm font-semibold text-sky-400 hover:underline"
                    >
                      {locationName}
                    </a>
                  ) : (
                    <p className="text-sm font-semibold text-slate-500">Unknown</p>
                  )}
                </div>
                <div>
                  <p className="text-[10px] text-slate-500 font-bold uppercase">Role</p>
                  <p className="text-sm font-semibold text-slate-300">{npc.role || '—'}</p>
                </div>
              </div>

              {npc.body ? <Markdown>{npc.body}</Markdown> : <p className="text-sm text-slate-500 italic">No description yet.</p>}

              {isDm && npc.dmSecret && <DmPanel>{npc.dmSecret}</DmPanel>}
            </>
          )}

          {editing && (
            <div className="space-y-3">
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
              <div className="flex items-center justify-between gap-2">
                <Btn danger className="!min-h-0 !py-1.5 text-xs" disabled={deleting} onClick={remove}>
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
            </div>
          )}
        </Card>

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
      </main>

      <aside className="space-y-5">
        <NotesRail campaignId={cid} entityType="npc" entityId={id} />
      </aside>
    </div>
  );
}
