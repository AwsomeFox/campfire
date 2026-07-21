/**
 * Location detail — mirrors design/claude-design/Campfire.dc.html "Location detail" (~670-698).
 * Layout: back link, name + status chip + DM discover action, then a two-column body —
 * body copy (+ pin map, DM-secret panel) on the left, Facts + Notes cards on the right.
 * DM: edit (name/kind/body), status cycle (POST /discover, incl. 'current' promotion),
 * move pin (numeric X/Y -> PATCH), dmSecret panel, delete.
 * Everyone: header, mini pin map, markdown body, here & connected, notes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Campaign, Location, Npc, Quest } from '@campfire/schema';
import { LocationStatus } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, TextArea, Skeleton, ErrorNote, DmPanel, EmptyState, statusVariant } from '../../components/ui';
import { NotFoundState } from '../../components/NotFoundState';
import { Markdown } from '../../components/Markdown';
import { NotesRail } from '../../components/NotesRail';
import { attachmentFileUrl } from '../../components/ImageUpload';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoSnackbar } from '../../components/UndoSnackbar';

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
  const [allLocations, setAllLocations] = useState<Location[]>([]);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [npcs, setNpcs] = useState<Npc[]>([]);
  const [quests, setQuests] = useState<Quest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [editing, setEditing] = useState(false);
  // Propose mode (issue #240): a non-DM member editing this location submits the change
  // to the DM's proposal queue (PATCH ?proposed=true) instead of writing canon directly.
  const [proposeMode, setProposeMode] = useState(false);
  const [proposeDone, setProposeDone] = useState(false);
  const [form, setForm] = useState({ name: '', kind: '', body: '', dmSecret: '', parentId: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pendingUndo, setPendingUndo] = useState(false);

  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);

  const [movingPin, setMovingPin] = useState(false);
  const [pinX, setPinX] = useState('50');
  const [pinY, setPinY] = useState('50');
  const [pinSaving, setPinSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const [locData, allLocData, npcsData, questsData, campaignData] = await Promise.all([
        api.get<Location>(`${API}/locations/${id}`),
        api.get<Location[]>(`${API}/campaigns/${cid}/locations`),
        api.get<Npc[]>(`${API}/campaigns/${cid}/npcs`),
        api.get<Quest[]>(`${API}/campaigns/${cid}/quests`),
        api.get<Campaign>(`${API}/campaigns/${cid}`),
      ]);
      setLocation(locData);
      setAllLocations(allLocData);
      setNpcs(npcsData);
      setQuests(questsData);
      setCampaign(campaignData);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't load this location.");
      }
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

  const locById = useMemo(() => new Map(allLocations.map((l) => [l.id, l])), [allLocations]);

  /** Ancestor chain from outermost to the direct parent, for the breadcrumb (#99). */
  const ancestors = useMemo(() => {
    const chain: Location[] = [];
    const seen = new Set<number>([id]);
    let cursor = location?.parentId ?? null;
    while (cursor != null && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = locById.get(cursor);
      if (!parent) break;
      chain.unshift(parent);
      cursor = parent.parentId ?? null;
    }
    return chain;
  }, [location, locById, id]);

  const children = useMemo(() => allLocations.filter((l) => l.parentId === id), [allLocations, id]);

  /**
   * Candidate parents for the DM's move control: any location that isn't this one and
   * isn't one of its descendants (which would create a cycle the API rejects anyway).
   */
  const parentOptions = useMemo(() => {
    const descendants = new Set<number>([id]);
    let added = true;
    while (added) {
      added = false;
      for (const l of allLocations) {
        if (l.parentId != null && descendants.has(l.parentId) && !descendants.has(l.id)) {
          descendants.add(l.id);
          added = true;
        }
      }
    }
    return allLocations.filter((l) => !descendants.has(l.id));
  }, [allLocations, id]);

  function fillForm() {
    if (!location) return;
    setForm({
      name: location.name,
      kind: location.kind,
      body: location.body,
      dmSecret: location.dmSecret,
      parentId: location.parentId != null ? String(location.parentId) : '',
    });
    setSaveError(null);
  }

  function startEdit() {
    fillForm();
    setProposeMode(false);
    setEditing(true);
  }

  // Non-DM members suggest an edit (issue #240): same form, minus the DM secret,
  // and Save routes the change through the proposal queue.
  function startPropose() {
    fillForm();
    setProposeDone(false);
    setProposeMode(true);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setProposeMode(false);
  }

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (proposeMode) {
        // Route through the proposal queue — omit the DM-only dmSecret field.
        await api.patch(`${API}/locations/${id}?proposed=true`, {
          name: form.name.trim(),
          kind: form.kind.trim(),
          body: form.body,
          parentId: form.parentId ? Number(form.parentId) : null,
        });
        setEditing(false);
        setProposeMode(false);
        setProposeDone(true);
      } else {
        const updated = await api.patch<Location>(`${API}/locations/${id}`, {
          name: form.name.trim(),
          kind: form.kind.trim(),
          body: form.body,
          dmSecret: form.dmSecret,
          parentId: form.parentId ? Number(form.parentId) : null,
        });
        setLocation(updated);
        setAllLocations((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
        setEditing(false);
      }
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
      await api.delete(`${API}/locations/${id}`);
      setConfirmingDelete(false);
      setPendingUndo(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this location.");
    } finally {
      setDeleting(false);
    }
  }

  async function undoDelete() {
    await api.post(`${API}/locations/${id}/restore`);
    setPendingUndo(false);
    await load();
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

  if (notFound && !location) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <NotFoundState title="Location not found" backTo={`/c/${cid}/locations`} backLabel="← Back to locations" />
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

      {proposeDone && !editing && (
        <div className="cf-card p-3 flex items-center justify-between gap-3 border border-[var(--color-accent-700)] text-sm">
          <span className="text-slate-200">✅ Suggestion sent to the DM — it's waiting for approval.</span>
          <Link to={`/c/${cid}/proposals`} className="text-purple-400 hover:underline shrink-0">
            View my proposals
          </Link>
        </div>
      )}

      {!editing && (
        <>
          {ancestors.length > 0 && (
            <nav aria-label="Location breadcrumb" className="flex items-center gap-1.5 flex-wrap text-xs text-slate-400 -mb-1">
              {ancestors.map((a) => (
                <span key={a.id} className="flex items-center gap-1.5">
                  <a
                    href={`/c/${cid}/locations/${a.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/c/${cid}/locations/${a.id}`);
                    }}
                    className="hover:text-amber-400"
                  >
                    {a.name}
                  </a>
                  <span className="text-slate-600" aria-hidden>›</span>
                </span>
              ))}
              <span className="text-slate-500">{location.name}</span>
            </nav>
          )}
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-extrabold text-white min-w-0 break-words">{location.name}</h1>
            <Chip variant={statusVariant(location.status)}>{statusLabel[location.status]}</Chip>
            {isDm && location.status === 'unexplored' && (
              <Chip variant="failed" className="!ml-0">🙈 Hidden from players</Chip>
            )}
            {isDm && nextStatus && (
              <Btn
                className="!min-h-0 !py-1.5 text-xs"
                disabled={statusSaving}
                onClick={() => setStatus(nextStatus)}
                title={location.status === 'unexplored' ? 'Reveal to players (mark explored)' : NEXT_STATUS_LABEL[location.status]}
              >
                {NEXT_STATUS_LABEL[location.status]}
              </Btn>
            )}
            {!isDm && role !== null && (
              <div className="flex gap-2 shrink-0 ml-auto">
                <Btn
                  ghost
                  className="!min-h-0 !py-1.5 text-xs"
                  onClick={startPropose}
                  title="Suggest a change to the DM for approval"
                >
                  ✎ Suggest an edit
                </Btn>
              </div>
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

              {children.length > 0 && (
                <Card className="space-y-3">
                  <h2 className="font-bold text-white text-sm">Contains</h2>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {children.map((child) => (
                      <a
                        key={child.id}
                        href={`/c/${cid}/locations/${child.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`/c/${cid}/locations/${child.id}`);
                        }}
                        className="cf-inset p-3 hover:border-amber-500/50"
                      >
                        <p className="text-sm font-bold text-amber-400">🗺 {child.name}</p>
                        <p className="text-xs text-slate-400">{child.kind || 'Location'}</p>
                      </a>
                    ))}
                  </div>
                </Card>
              )}
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
                <div className="flex justify-between gap-2 text-[13px]">
                  <span className="text-muted">Within</span>
                  <span>{ancestors.length > 0 ? ancestors[ancestors.length - 1].name : '—'}</span>
                </div>
              </Card>

              <NotesRail campaignId={cid} entityType="location" entityId={id} />
            </div>
          </div>
        </>
      )}

      {editing && (
        <Card className="space-y-3">
          {proposeMode && (
            <p className="text-xs text-slate-400 m-0 rounded-[var(--radius-md)] bg-[var(--color-accent)]/10 border border-[var(--color-accent-700)] px-3 py-2">
              💡 You're suggesting an edit. Your changes go to the DM as a proposal — nothing changes until they approve it.
            </p>
          )}
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
            <label className="text-[10px] text-slate-500 font-bold uppercase">Parent location</label>
            <select
              aria-label="Parent location"
              className="cf-input text-sm w-full"
              value={form.parentId}
              onChange={(e) => setForm({ ...form, parentId: e.target.value })}
            >
              <option value="">No parent (top level)</option>
              {parentOptions.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  Inside: {loc.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-slate-500 font-bold uppercase">Description (markdown)</label>
            <TextArea style={{ minHeight: 140 }} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </div>
          {!proposeMode && (
            <div className="space-y-1">
              <label className="text-[10px] text-amber-500 font-bold uppercase">🔒 DM secret</label>
              <TextArea style={{ minHeight: 90 }} value={form.dmSecret} onChange={(e) => setForm({ ...form, dmSecret: e.target.value })} />
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            {!proposeMode ? (
              <Btn danger className="!min-h-0 !py-1.5 text-xs" disabled={deleting} onClick={() => setConfirmingDelete(true)}>
                {deleting ? 'Deleting…' : 'Delete location'}
              </Btn>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={cancelEdit}>
                Cancel
              </Btn>
              <Btn className="!min-h-0 !py-1.5 text-xs" disabled={saving || !form.name.trim()} onClick={save}>
                {proposeMode ? (saving ? 'Suggesting…' : 'Suggest to the DM') : saving ? 'Saving…' : 'Save'}
              </Btn>
            </div>
          </div>
        </Card>
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete ${location?.name}?`}
          body="This moves the location to the Trash — you can undo it, or restore it from the campaign Trash."
          confirmLabel={deleting ? 'Deleting…' : 'Delete location'}
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
      {pendingUndo && (
        <UndoSnackbar
          message="Location moved to Trash."
          onUndo={undoDelete}
          onExpire={() => navigate(`/c/${cid}/locations`)}
        />
      )}
    </div>
  );
}
