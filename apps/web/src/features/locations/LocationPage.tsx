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
import { usePanelData } from '../../lib/usePanelData';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, TextArea, Skeleton, ErrorNote, DmPanel, EmptyState, statusVariant } from '../../components/ui';
import { LocationStatusLabel, LOCATION_STATUS_LABEL } from '../../components/LocationStatusLabel';
import { NotFoundState } from '../../components/NotFoundState';
import { Markdown } from '../../components/Markdown';
import { NotesRail } from '../../components/NotesRail';
import { attachmentFileUrl } from '../../components/ImageUpload';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { RevisionHistoryPanel } from '../../components/RevisionHistoryPanel';
import { GameIcon } from '../../components/GameIcon';
import { QuestStatusBadge } from '../../components/EntitySemanticBadges';
import { StatusMenuButton } from '../../components/StatusMenuButton';
import { useAnnounce } from '../../components/Announcer';
import { entityTargetProps } from '../../lib/entityLinks';


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
  // Gate the auxiliary panels (and the core fetch) on finite ids so a route with a
  // missing/garbage param doesn't fire `/campaigns/NaN/...` on mount. Mirrors the
  // `Number.isFinite` guard the core `load()` already applies (issue #697 review).
  const idReady = Number.isFinite(cid) && Number.isFinite(id);
  const navigate = useNavigate();
  const { roleIn } = useAuth();
  const announce = useAnnounce();
  const role = roleIn(cid);
  const isDm = role === 'dm';

  const [location, setLocation] = useState<Location | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Auxiliary panels (issue #697): the full location list (breadcrumb/children/
  // parent-picker), the NPC roster (the "Here" card), the quest list (connected
  // quests), and the campaign (the map background) all load independently. A
  // failure in any of these degrades only its own card/control with an inline
  // retry — it can NEVER set the page-level `error`/`notFound` reserved for the
  // core location fetch below.
  const locationsPanel = usePanelData<Location[]>(
    useCallback(() => api.get<Location[]>(`${API}/campaigns/${cid}/locations`), [cid]),
    idReady,
    "Couldn't load the location list.",
  );
  const npcsPanel = usePanelData<Npc[]>(
    useCallback(() => api.get<Npc[]>(`${API}/campaigns/${cid}/npcs`), [cid]),
    idReady,
    "Couldn't load NPCs for this location.",
  );
  const questsPanel = usePanelData<Quest[]>(
    useCallback(() => api.get<Quest[]>(`${API}/campaigns/${cid}/quests`), [cid]),
    idReady,
    "Couldn't load connected quests.",
  );
  const campaignPanel = usePanelData<Campaign>(
    useCallback(() => api.get<Campaign>(`${API}/campaigns/${cid}`), [cid]),
    idReady,
    "Couldn't load the campaign map.",
  );
  const allLocations = locationsPanel.data ?? [];
  const npcs = npcsPanel.data ?? [];
  const campaign = campaignPanel.data;

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
  // Optimistic-concurrency guard (#157/#233): a stale save 409s instead of clobbering a
  // co-DM's or a connected AI's interleaved edit. `conflict` shows a Reload-latest
  // affordance; `historyNonce` refetches the edit-history panel after each save.
  const [conflict, setConflict] = useState(false);
  const [historyNonce, setHistoryNonce] = useState(0);

  const [statusSaving, setStatusSaving] = useState(false);

  const [movingPin, setMovingPin] = useState(false);
  const [pinX, setPinX] = useState('50');
  const [pinY, setPinY] = useState('50');
  const [pinSaving, setPinSaving] = useState(false);

  // Core fetch: ONLY the location can set the page-level error/not-found state.
  // The auxiliary panels above own their own error/retry and never reach here (#697).
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const locData = await api.get<Location>(`${API}/locations/${id}`);
      setLocation(locData);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't load this location.");
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (Number.isFinite(cid) && Number.isFinite(id)) void load();
  }, [cid, id, load]);

  const hereNpcs = useMemo(() => npcs.filter((n) => n.locationId === id), [npcs, id]);
  const hereNpcIds = useMemo(() => new Set(hereNpcs.map((n) => n.id)), [hereNpcs]);
  const connectedQuests = useMemo(
    () => (questsPanel.data ?? []).filter((q) => q.giverNpcId != null && hereNpcIds.has(q.giverNpcId)),
    [questsPanel.data, hereNpcIds],
  );

  // "Here & connected" empty-state guard (#697 review): the combined list is empty
  // both while the panels are still loading AND after they fail (a failed panel
  // yields null data -> empty filtered list). Without distinguishing those from a
  // genuine "nothing is connected" we'd show the cheerful empty state over a load
  // failure. Only treat it as truly empty once both panels have settled
  // successfully with no results.
  const panelsLoading = (npcsPanel.loading && !npcsPanel.data) || (questsPanel.loading && !questsPanel.data);
  const panelsFailed = (!!npcsPanel.error && !npcsPanel.data) || (!!questsPanel.error && !questsPanel.data);
  const nothingConnected = hereNpcs.length === 0 && connectedQuests.length === 0;

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
    setConflict(false);
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
          // Echo back the updatedAt we loaded so a concurrent edit 409s (#157/#233) instead
          // of silently overwriting the other author's work.
          ...(location?.updatedAt ? { expectedUpdatedAt: location.updatedAt } : {}),
        });
        setLocation(updated);
        // Fold the saved edit into the auxiliary locations panel's cache so the
        // breadcrumb/children/parent-picker reflect it without a full reload.
        locationsPanel.setData((prev) => (prev ?? []).map((l) => (l.id === updated.id ? updated : l)));
        setEditing(false);
        setHistoryNonce((n) => n + 1);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Someone saved between our load and this save — keep the draft, block the
        // clobber, and prompt a reload of the latest before saving again.
        setConflict(true);
        setSaveError(err.message || "This location changed since you opened it — reload the latest before saving so you don't erase the other edit.");
      } else {
        setSaveError(err instanceof ApiError ? err.message : "Couldn't save changes.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    if (!location) return;
    setSaveError(null);
    setConflict(false);
    try {
      const fresh = await api.get<Location>(`${API}/locations/${id}`);
      setLocation(fresh);
      setForm((f) => ({ ...f, body: fresh.body, dmSecret: fresh.dmSecret }));
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Couldn't reload the latest location.");
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
    try {
      const updated = await api.post<Location>(`${API}/locations/${id}/discover`, { status });
      setLocation(updated);
      announce(`Location status set to ${LOCATION_STATUS_LABEL[status]}.`);
    } catch {
      // Selection is preserved (location.status is unchanged). Surface the
      // failure both visually (page-level ErrorNote) and to the screen reader
      // so the user learns the save did not stick. Use the stable generic
      // message so the assertion holds regardless of the server's response.
      setError("Couldn't update status.");
      throw new Error('status save failed');
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
    const clampedX = Math.max(0, Math.min(100, x));
    const clampedY = Math.max(0, Math.min(100, y));
    // Keep the form in sync with the clamped values that will be submitted.
    setPinX(String(clampedX));
    setPinY(String(clampedY));
    setPinSaving(true);
    try {
      const updated = await api.patch<Location>(`${API}/locations/${id}`, { mapX: clampedX, mapY: clampedY });
      setLocation(updated);
      setMovingPin(false);
      announce(`Pin saved at ${clampedX}% horizontal, ${clampedY}% vertical.`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Couldn't move the pin.";
      setError(msg);
      announce(`Failed to save pin position: ${msg}`, { assertive: true });
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
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10" {...entityTargetProps('location', location.id)}>
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
            <Chip variant={statusVariant(location.status)}><LocationStatusLabel status={location.status} /></Chip>
            {isDm && location.status === 'unexplored' && (
              <Chip variant="failed" className="!ml-0"><span className="inline-flex items-center gap-1"><GameIcon slug="sight-disabled" size={12} /> Hidden from players</span></Chip>
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
              <div className="flex gap-2 shrink-0 ml-auto">
                <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={startEdit}>
                  ✎ Edit
                </Btn>
                <StatusMenuButton
                  className="cf-btn cf-btn-ghost !min-h-0 !py-1.5 text-xs"
                  triggerLabel={`Location status: ${LOCATION_STATUS_LABEL[location.status]}`}
                  triggerDescription="DM: set status directly"
                  value={location.status}
                  options={(LocationStatus.options as Location['status'][]).map((s) => ({
                    value: s,
                    label: <LocationStatusLabel status={s} />,
                  }))}
                  disabled={statusSaving}
                  triggerText="Status ▾"
                  onSelect={(s) => setStatus(s)}
                  announceFailure={announce}
                  failureMessage="Couldn't update status."
                />
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
                    <div className="absolute bottom-2 right-2 cf-card p-2 flex flex-col gap-1.5" role="group" aria-labelledby="pin-position-heading">
                      <span id="pin-position-heading" className="text-[9px] text-slate-400 font-bold uppercase">
                        Move {location.name} pin
                      </span>
                      <div className="flex items-end gap-2">
                        <div className="space-y-0.5">
                          <label htmlFor="pin-x-input" className="text-[9px] text-slate-500 font-bold uppercase">
                            Horizontal position (%)
                          </label>
                          <input
                            id="pin-x-input"
                            type="number"
                            min={0}
                            max={100}
                            className="cf-input !min-h-0 !py-1 !w-16 text-xs"
                            value={pinX}
                            onChange={(e) => setPinX(e.target.value)}
                            aria-describedby="pin-position-help"
                          />
                        </div>
                        <div className="space-y-0.5">
                          <label htmlFor="pin-y-input" className="text-[9px] text-slate-500 font-bold uppercase">
                            Vertical position (%)
                          </label>
                          <input
                            id="pin-y-input"
                            type="number"
                            min={0}
                            max={100}
                            className="cf-input !min-h-0 !py-1 !w-16 text-xs"
                            value={pinY}
                            onChange={(e) => setPinY(e.target.value)}
                            aria-describedby="pin-position-help"
                          />
                        </div>
                        <Btn ghost className="!min-h-0 !py-1 text-[10px]" onClick={() => setMovingPin(false)}>
                          Cancel
                        </Btn>
                        <Btn className="!min-h-0 !py-1 text-[10px]" disabled={pinSaving} onClick={savePin}>
                          {pinSaving ? '…' : 'Save'}
                        </Btn>
                      </div>
                      <p id="pin-position-help" className="text-[9px] text-slate-500 m-0">
                        0% = left/top edge, 100% = right/bottom edge
                      </p>
                    </div>
                  )}
                </div>

                {location.body ? <Markdown>{location.body}</Markdown> : <p className="text-sm text-slate-500 italic">No description yet.</p>}
              </Card>

              {isDm && location.dmSecret && <DmPanel>{location.dmSecret}</DmPanel>}

              {/* Body revision history + restore (#157/#233) — DM-only, so a clobbered or
                  regretted edit is recoverable. Refetches after each save. */}
              {isDm && (
                <RevisionHistoryPanel
                  entityType="location"
                  entityId={id}
                  currentSnapshot={{ body: location.body }}
                  reloadNonce={historyNonce}
                  onRestored={() => {
                    setHistoryNonce((n) => n + 1);
                    void reloadLatest();
                  }}
                />
              )}

              <Card className="space-y-3">
                <h2 className="font-bold text-white text-sm">Here &amp; connected</h2>
                {/* NPCs + quests are auxiliary (#697): a failure degrades only this card
                    with an inline retry — the location above stays fully rendered. */}
                {npcsPanel.error && !npcsPanel.data && (
                  <ErrorNote message={npcsPanel.error} onRetry={npcsPanel.retry} />
                )}
                {questsPanel.error && !questsPanel.data && (
                  <ErrorNote message={questsPanel.error} onRetry={questsPanel.retry} />
                )}
                {/* Distinguish "still loading", "failed to load", and "genuinely empty"
                    (#697 review): previously the empty state rendered whenever the
                    combined list was empty, which is also true mid-load and post-failure.
                    Now the empty state only shows once both panels settled successfully
                    with no results. A failure shows just the inline alerts above (no
                    misleading "Nothing connected here yet"); a pending load shows a
                    skeleton. */}
                {nothingConnected && panelsFailed ? null : nothingConnected && panelsLoading ? (
                  <Skeleton lines={2} />
                ) : nothingConnected ? (
                  <EmptyState icon="shaking-hands" title="Nothing connected here yet" />
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
                        className="cf-inset cf-card-hover p-3"
                      >
                        <p className="flex items-center gap-1.5 text-sm font-bold text-purple-400"><GameIcon slug="hooded-figure" size={13} /> {npc.name}</p>
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
                        className="cf-inset cf-card-hover p-3"
                      >
                        <p className="flex items-center gap-1.5 text-sm font-bold text-amber-400"><GameIcon slug="scroll-unfurled" size={13} /> {q.title}</p>
                        <QuestStatusBadge status={q.status} className="mt-1" />
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
                        className="cf-inset cf-card-hover p-3"
                      >
                        <p className="flex items-center gap-1.5 text-sm font-bold text-amber-400"><GameIcon slug="treasure-map" size={13} /> {child.name}</p>
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
                  <LocationStatusLabel status={location.status} />
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
              <GameIcon slug="light-bulb" size={12} className="inline align-text-bottom mr-1" />You're suggesting an edit. Your changes go to the DM as a proposal — nothing changes until they approve it.
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
              <label className="flex items-center gap-1 text-[10px] text-amber-500 font-bold uppercase"><GameIcon slug="padlock" size={11} /> DM secret</label>
              <TextArea style={{ minHeight: 90 }} value={form.dmSecret} onChange={(e) => setForm({ ...form, dmSecret: e.target.value })} />
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            {!proposeMode ? (
              <Btn danger className="!min-h-0 !py-1.5 text-xs" busy={deleting} onClick={() => setConfirmingDelete(true)}>
                {deleting ? 'Deleting…' : 'Delete location'}
              </Btn>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              {conflict && (
                <Btn ghost className="!min-h-0 !py-1.5 text-xs" disabled={saving} onClick={reloadLatest}>
                  Reload latest
                </Btn>
              )}
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
