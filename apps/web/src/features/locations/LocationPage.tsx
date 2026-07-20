/**
 * Location detail — mirrors design/claude-design/Campfire.dc.html "Location detail" (~670-698).
 * Layout: back link, name + status chip + DM discover action, then a two-column body —
 * body copy (+ pin map, DM-secret panel) on the left, Facts + Notes cards on the right.
 * DM: edit (name/kind/body), status cycle (POST /discover, incl. 'current' promotion),
 * move pin (numeric X/Y -> PATCH), dmSecret panel, delete.
 * Everyone: header, mini pin map, markdown body, here & connected, notes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Campaign, Location, Npc, Quest } from '@campfire/schema';
import { LocationStatus } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, TextArea, Skeleton, ErrorNote, DmPanel, EmptyState, statusVariant } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { NotesRail } from '../../components/NotesRail';
import { attachmentFileUrl } from '../../components/ImageUpload';
import { ConfirmDialog } from '../../components/ConfirmDialog';

const statusLabel: Record<Location['status'], string> = {
  unexplored: 'Unexplored',
  explored: 'Explored',
  current: '📍 Current',
};

/** Design's primary "discover" action advances one step: unexplored -> explored -> current. */
const NEXT_STATUS: Record<Location['status'], Location['status'] | null> = {
  unexplored: 'explored',
  explored: 'current',
  current: null,
};
const NEXT_STATUS_LABEL: Record<Location['status'], string> = {
  unexplored: 'Mark explored',
  explored: 'Mark current',
  current: 'Current',
};

export default function LocationPage() {
  const { campaignId, locationId } = useParams<{ campaignId: string; locationId: string }>();
  const cid = Number(campaignId);
  const id = Number(locationId);
  const navigate = useNavigate();
  const { roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';

  const [location, setLocation] = useState<Location | null>(null);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [npcs, setNpcs] = useState<Npc[]>([]);
  const [quests, setQuests] = useState<Quest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', kind: '', body: '', dmSecret: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);

  const [movingPin, setMovingPin] = useState(false);
  const [pinX, setPinX] = useState('50');
  const [pinY, setPinY] = useState('50');
  const [pinSaving, setPinSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [locData, npcsData, questsData, campaignData] = await Promise.all([
        api.get<Location>(`${API}/locations/${id}`),
        api.get<Npc[]>(`${API}/campaigns/${cid}/npcs`),
        api.get<Quest[]>(`${API}/campaigns/${cid}/quests`),
        api.get<Campaign>(`${API}/campaigns/${cid}`),
      ]);
      setLocation(locData);
      setNpcs(npcsData);
      setQuests(questsData);
      setCampaign(campaignData);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load this location.");
    } finally {
      setLoading(false);
    }
  }, [cid, id]);

  useEffect(() => {
    if (Number.isFinite(cid) && Number.isFinite(id)) void load();
  }, [cid, id, load]);

  const hereNpcs = useMemo(() => npcs.filter((n) => n.locationId === id), [npcs, id]);
  const hereNpcIds = useMemo(() => new Set(hereNpcs.map((n) => n.id)), [hereNpcs]);
  const connectedQuests = useMemo(
    () => quests.filter((q) => q.giverNpcId != null && hereNpcIds.has(q.giverNpcId)),
    [quests, hereNpcIds],
  );

  function startEdit() {
    if (!location) return;
    setForm({ name: location.name, kind: location.kind, body: location.body, dmSecret: location.dmSecret });
    setSaveError(null);
    setEditing(true);
  }

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.patch<Location>(`${API}/locations/${id}`, {
        name: form.name.trim(),
        kind: form.kind.trim(),
        body: form.body,
        dmSecret: form.dmSecret,
      });
      setLocation(updated);
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
      await api.delete(`${API}/locations/${id}`);
      navigate(`/c/${cid}/locations`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this location.");
      setDeleting(false);
    }
  }

  async function setStatus(status: Location['status']) {
    setStatusSaving(true);
    setStatusMenuOpen(false);
    try {
      const updated = await api.post<Location>(`${API}/locations/${id}/discover`, { status });
      setLocation(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update status.");
    } finally {
      setStatusSaving(false);
    }
  }

  function startMovePin() {
    if (!location) return;
    setPinX(location.mapX != null ? String(location.mapX) : '50');
    setPinY(location.mapY != null ? String(location.mapY) : '50');
    setMovingPin(true);
  }

  async function savePin() {
    const x = Number(pinX);
    const y = Number(pinY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    setPinSaving(true);
    try {
      const updated = await api.patch<Location>(`${API}/locations/${id}`, { mapX: x, mapY: y });
      setLocation(updated);
      setMovingPin(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't move the pin.");
    } finally {
      setPinSaving(false);
    }
  }

  if (!Number.isFinite(cid) || !Number.isFinite(id)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message="No location selected." />
      </div>
    );
  }

  if (loading && !location) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <Card>
          <Skeleton lines={6} />
        </Card>
      </div>
    );
  }

  if (error && !location) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  if (!location) return null;

  const px = location.mapX ?? 50;
  const py = location.mapY ?? 50;
  const nextStatus = NEXT_STATUS[location.status];

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <div>
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => navigate(`/c/${cid}/locations`)}>
          ← Back
        </Btn>
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {!editing && (
        <>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-extrabold text-white min-w-0 break-words">{location.name}</h1>
            <Chip variant={statusVariant(location.status)}>{statusLabel[location.status]}</Chip>
            {isDm && nextStatus && (
              <Btn className="!min-h-0 !py-1.5 text-xs" disabled={statusSaving} onClick={() => setStatus(nextStatus)}>
                {NEXT_STATUS_LABEL[location.status]}
              </Btn>
            )}
            {isDm && (
              <div className="flex gap-2 shrink-0 relative ml-auto">
                <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={startEdit}>
                  ✎ Edit
                </Btn>
                <Btn
                  ghost
                  className="!min-h-0 !py-1.5 text-xs"
                  disabled={statusSaving}
                  onClick={() => setStatusMenuOpen((v) => !v)}
                  title="DM: set status directly"
                >
                  Status ▾
                </Btn>
                {statusMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-10 cf-card p-1.5 space-y-1 min-w-[160px]">
                    {(LocationStatus.options as Location['status'][]).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setStatus(s)}
                        className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-semibold hover:bg-slate-700 ${
                          s === location.status ? 'text-amber-400' : 'text-slate-300'
                        }`}
                      >
                        {statusLabel[s]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {location.kind && <p className="text-sm text-slate-400 -mt-3">{location.kind}</p>}

          <div className="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-4 items-start">
            <div className="space-y-4 min-w-0">
              <Card className="space-y-4">
                {/* Mini pin map */}
                <div className="relative cf-inset overflow-hidden h-36">
                  {campaign?.mapAttachmentId ? (
                    <img
                      src={attachmentFileUrl(campaign.mapAttachmentId)}
                      alt="Campaign map"
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-[radial-gradient(#334155_1px,transparent_1px)] [background-size:16px_16px] opacity-35" />
                  )}
                  <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <g transform={`translate(${px},${py})`}>
                      <circle r="4.4" fill="#f59e0b" fillOpacity=".25" vectorEffect="non-scaling-stroke" />
                      <circle r="2" fill="#f59e0b" vectorEffect="non-scaling-stroke" />
                    </g>
                  </svg>
                  <span
                    className="absolute text-[10px] font-bold text-amber-400 -translate-x-1/2"
                    style={{ left: `${px}%`, top: `calc(${py}% + 10px)` }}
                  >
                    {location.name}
                  </span>
                  {isDm && !movingPin && (
                    <Btn ghost className="absolute bottom-2 right-2 !min-h-0 !py-1 text-[10px]" onClick={startMovePin}>
                      Move pin (DM)
                    </Btn>
                  )}
                  {isDm && movingPin && (
                    <div className="absolute bottom-2 right-2 cf-card p-2 flex items-end gap-2">
                      <div className="space-y-0.5">
                        <label className="text-[9px] text-slate-500 font-bold uppercase">X</label>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          className="cf-input !min-h-0 !py-1 !w-16 text-xs"
                          value={pinX}
                          onChange={(e) => setPinX(e.target.value)}
                        />
                      </div>
                      <div className="space-y-0.5">
                        <label className="text-[9px] text-slate-500 font-bold uppercase">Y</label>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          className="cf-input !min-h-0 !py-1 !w-16 text-xs"
                          value={pinY}
                          onChange={(e) => setPinY(e.target.value)}
                        />
                      </div>
                      <Btn ghost className="!min-h-0 !py-1 text-[10px]" onClick={() => setMovingPin(false)}>
                        Cancel
                      </Btn>
                      <Btn className="!min-h-0 !py-1 text-[10px]" disabled={pinSaving} onClick={savePin}>
                        {pinSaving ? '…' : 'Save'}
                      </Btn>
                    </div>
                  )}
                </div>

                {location.body ? <Markdown>{location.body}</Markdown> : <p className="text-sm text-slate-500 italic">No description yet.</p>}
              </Card>

              {isDm && location.dmSecret && <DmPanel>{location.dmSecret}</DmPanel>}

              <Card className="space-y-3">
                <h2 className="font-bold text-white text-sm">Here &amp; connected</h2>
                {hereNpcs.length === 0 && connectedQuests.length === 0 ? (
                  <EmptyState icon="🤝" title="Nothing connected here yet" />
                ) : (
                  <div className="grid sm:grid-cols-2 gap-3">
                    {hereNpcs.map((npc) => (
                      <a
                        key={`npc-${npc.id}`}
                        href={`/c/${cid}/npcs/${npc.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`/c/${cid}/npcs/${npc.id}`);
                        }}
                        className="cf-inset p-3 hover:border-amber-500/50"
                      >
                        <p className="text-sm font-bold text-purple-400">🤝 {npc.name}</p>
                        <p className="text-xs text-slate-400">{npc.role || 'NPC'}</p>
                      </a>
                    ))}
                    {connectedQuests.map((q) => (
                      <a
                        key={`quest-${q.id}`}
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
                  <span className="text-muted">Status</span>
                  <span>{statusLabel[location.status]}</span>
                </div>
                <div className="flex justify-between gap-2 text-[13px]">
                  <span className="text-muted">Kind</span>
                  <span>{location.kind || '—'}</span>
                </div>
              </Card>

              <NotesRail campaignId={cid} entityType="location" entityId={id} />
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
              <label className="text-[10px] text-slate-500 font-bold uppercase">Kind</label>
              <TextInput value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} />
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
            <Btn danger className="!min-h-0 !py-1.5 text-xs" disabled={deleting} onClick={() => setConfirmingDelete(true)}>
              {deleting ? 'Deleting…' : 'Delete location'}
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
          title={`Delete ${location?.name}?`}
          body="This cannot be undone."
          confirmLabel={deleting ? 'Deleting…' : 'Delete location'}
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
