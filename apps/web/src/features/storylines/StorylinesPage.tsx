/**
 * Storylines — DM-only branching story/arc planner (issue #27).
 *
 * A place for the DM to plan FUTURE beats with branching options: Arcs group
 * ordered Beats, and each Beat carries ordered Branches (a trigger label + an
 * optional target beat). The whole surface is DM-only; players never see it.
 *
 * Route (wired in app/router.tsx):
 *   /c/:campaignId/storylines  →  features/storylines/StorylinesPage.tsx (default export)
 *
 * Data: GET/POST /api/v1/campaigns/:campaignId/arcs, plus /arcs/:id and /beats/:id routes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  StoryArc,
  StoryArcWithBeats,
  StoryBeat,
  StoryBeatWithBranches,
  StoryBranch,
  ArcStatus,
  BeatStatus,
} from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import {
  compositionSafeFormSubmit,
  createCompositionSubmitGate,
} from '../../lib/compositionSafeSubmit';
import { useAuth } from '../../app/auth';
import { Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { useAnnounce } from '../../components/Announcer';
import { GameIcon } from '../../components/GameIcon';
import { entityDomId, entityTargetProps, entityHref } from '../../lib/entityLinks';
import { Markdown } from '../../components/Markdown';
import { DraftWithAiButton } from '../ai-dm/DraftWithAiButton';

/** Minimal shapes for the play-record link-picker option lists (issue #264). */
type NamedRow = { id: number; name?: string; title?: string; number?: number };
type LinkOptions = { sessions: NamedRow[]; quests: NamedRow[]; encounters: NamedRow[] };
const EMPTY_LINK_OPTIONS: LinkOptions = { sessions: [], quests: [], encounters: [] };

/**
 * Issue #688: the link-options set, plus per-list load failure flags. Components read
 * each flag to swap that picker's "— none —" placeholder for "— couldn't load —" and to
 * know a retry is available; the form stays usable either way (the author can still
 * save a beat with no link or retry the load). Granular per-list tracking means a
 * sessions-only outage degrades only the sessions picker, not the quest/encounter ones.
 */
type LinkOptionFailures = { sessions: boolean; quests: boolean; encounters: boolean };
const NO_LINK_FAILURES: LinkOptionFailures = { sessions: false, quests: false, encounters: false };
type LinkOptionState = {
  options: LinkOptions;
  failed: LinkOptionFailures;
  loading: boolean;
  onRetry: () => void;
};

function sessionLabel(s: NamedRow): string {
  return s.title || `Session ${s.number ?? s.id}`;
}

/** Issue #688: true when any link-options list failed to load (so a degraded note should show). */
function anyLinkOptionFailed(failures: LinkOptionFailures): boolean {
  return failures.sessions || failures.quests || failures.encounters;
}

function branchDomId(id: number): string {
  return `storyline-branch-${id}`;
}

type RefreshStorylines = (focusId?: string) => Promise<void>;

const ARC_STATUSES: ArcStatus[] = ['planned', 'active', 'resolved', 'abandoned'];
const BEAT_STATUSES: BeatStatus[] = ['planned', 'active', 'done', 'skipped'];

const ARC_TAG_CLASS: Record<ArcStatus, string> = {
  planned: 'tag tag-outline',
  active: 'tag tag-accent',
  resolved: 'tag tag-neutral',
  abandoned: 'tag tag-neutral',
};

const BEAT_GLYPH: Record<BeatStatus, string> = {
  planned: '○',
  active: '◐',
  done: '✓',
  skipped: '✕',
};

export default function StorylinesPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { roleIn } = useAuth();
  const isDm = roleIn(cid) === 'dm';
  const announce = useAnnounce();

  const [arcs, setArcs] = useState<StoryArcWithBeats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [newArcTitle, setNewArcTitle] = useState('');
  const [arcCreateError, setArcCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const newArcTitleRef = useRef<HTMLInputElement>(null);
  // Issue #854: Enter confirming IME composition must not create an arc.
  const arcCompositionGateRef = useRef<ReturnType<typeof createCompositionSubmitGate> | null>(null);
  if (arcCompositionGateRef.current === null) {
    arcCompositionGateRef.current = createCompositionSubmitGate();
  }
  const arcCompositionGate = arcCompositionGateRef.current;
  const pendingFocusIdRef = useRef<string | null>(null);
  // Play-record link options (issue #264) — the sessions/quests/encounters a beat can
  // link to. Fetched once; empty lists just leave the pickers showing "— none —".
  const [linkOptions, setLinkOptions] = useState<LinkOptions>(EMPTY_LINK_OPTIONS);
  // Issue #688: distinguish "couldn't load options" from "no options exist." A failed
  // load degrades the affected beat link-picker (each shows a couldn't-load placeholder
  // and the form stays usable) instead of silently collapsing into empty lists. Tracked
  // per-list so a sessions outage doesn't disable the quest/encounter pickers.
  const [linkOptionsError, setLinkOptionsError] = useState<LinkOptionFailures>(NO_LINK_FAILURES);
  const [linkOptionsLoading, setLinkOptionsLoading] = useState(false);

  const load = useCallback(async (focusId?: string) => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const list = await api.get<StoryArcWithBeats[]>(`${API}/campaigns/${cid}/arcs`);
      pendingFocusIdRef.current = focusId ?? null;
      setArcs(list);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setError("Couldn't load storylines.");
      }
    } finally {
      setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

  // Creation waits for the refreshed collection, then this commit-driven handoff
  // focuses the exact new record. It avoids racing React's render with an arbitrary
  // timer while preserving the existing entity focus targets used by deep links.
  useEffect(() => {
    const focusId = pendingFocusIdRef.current;
    if (!focusId) return;
    const target = document.getElementById(focusId);
    if (!target) return;
    pendingFocusIdRef.current = null;
    target.focus();
  }, [arcs]);

  // Load the play-record link options once the campaign is known (issue #264). The whole
  // page is DM-only, so these DM-scoped lists are always available here. Issue #688: a
  // failure no longer collapses into silent empty lists — we flag it so the beat link-
  // pickers can render a "couldn't load" placeholder (the form stays fully usable), and
  // we offer an explicit retry. No-options vs. could-not-load is now distinguishable.
  const loadLinkOptions = useCallback(async () => {
    if (!Number.isFinite(cid)) return;
    setLinkOptionsLoading(true);
    // Resolve each list independently; a rejection degrades only that list's picker and
    // never rejects the whole promise, so the page never hard-fails.
    const [sessionsR, questsR, encountersR] = await Promise.allSettled([
      api.get<NamedRow[]>(`${API}/campaigns/${cid}/sessions`),
      api.get<NamedRow[]>(`${API}/campaigns/${cid}/quests`),
      api.get<NamedRow[]>(`${API}/campaigns/${cid}/encounters`),
    ]);
    const failures: LinkOptionFailures = {
      sessions: sessionsR.status === 'rejected',
      quests: questsR.status === 'rejected',
      encounters: encountersR.status === 'rejected',
    };
    setLinkOptionsError(failures);
    // For each list that resolved, refresh it; for each that failed, keep the prior value
    // (empty on first load) so a transient outage doesn't wipe a working picker.
    setLinkOptions((prev) => ({
      sessions: sessionsR.status === 'fulfilled' ? sessionsR.value : prev.sessions,
      quests: questsR.status === 'fulfilled' ? questsR.value : prev.quests,
      encounters: encountersR.status === 'fulfilled' ? encountersR.value : prev.encounters,
    }));
    setLinkOptionsLoading(false);
  }, [cid]);

  useEffect(() => {
    void loadLinkOptions();
  }, [loadLinkOptions]);

  // Every beat across all arcs, so a branch's target (which may live in another arc)
  // can be shown by title and offered in the "link to beat" picker.
  const allBeats = useMemo(() => {
    const map = new Map<number, { title: string; arcTitle: string }>();
    for (const arc of arcs) {
      for (const beat of arc.beats) map.set(beat.id, { title: beat.title, arcTitle: arc.title });
    }
    return map;
  }, [arcs]);

  const createArc = async () => {
    const title = newArcTitle.trim();
    if (!title || busy) return;
    setArcCreateError(null);
    setBusy(true);
    try {
      const created = await api.post<StoryArc>(`${API}/campaigns/${cid}/arcs`, { title });
      setNewArcTitle('');
      await load(entityDomId('arc', created.id));
      announce(`Created arc ${created.title}.`);
    } catch {
      setArcCreateError("Couldn't create the arc. Your title has been kept. Try again.");
      requestAnimationFrame(() => newArcTitleRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <EmptyState icon="padlock" title="Storylines are DM-only" hint="Only the DM can plan story arcs." />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 pb-20 md:pb-10" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: '4px 0 0' }}>Storylines</h3>
        <span className="tag tag-outline" style={{ fontSize: 10 }} title="Visible only to the DM">
          DM only
        </span>
        <div style={{ flex: 1 }} />
        {/*
          Issue #639: beats are a Storylines entity, so "Draft a beat with AI" lives
          here — on the surface that owns the content type — not on Quests. The button
          self-gates (DM + AI-DM seat enabled, co_dm/driver mode), so it renders for the
          only audience that can ever use it on this DM-only page.
        */}
        <DraftWithAiButton campaignId={cid} target="beat" label="Draft a beat with AI" />
      </div>

      <p className="text-muted" style={{ margin: '-6px 0 0', fontSize: 12 }}>
        Plan future beats with branching options. Arcs group ordered beats; each beat can branch to next beats via
        labelled triggers.
      </p>

      {isDm && (
        <form
          className="card elev-sm"
          style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
          onSubmit={compositionSafeFormSubmit(arcCompositionGate, () => {
            void createArc();
          })}
        >
          <div className="field" style={{ flex: '1 1 180px', minWidth: 0 }}>
            <label htmlFor="storyline-new-arc-title">New arc title</label>
            <input
              ref={newArcTitleRef}
              id="storyline-new-arc-title"
              className="input"
              placeholder="For example, The Broken Crown"
              value={newArcTitle}
              maxLength={200}
              required
              aria-invalid={arcCreateError ? true : undefined}
              aria-describedby={arcCreateError ? 'storyline-new-arc-error' : undefined}
              onChange={(event) => {
                setNewArcTitle(event.target.value);
                setArcCreateError(null);
              }}
              {...arcCompositionGate.inputProps}
            />
          </div>
          <button type="submit" className="btn btn-primary" style={{ fontSize: 13 }} disabled={busy || !newArcTitle.trim()}>
            + New arc
          </button>
          {arcCreateError && (
            <div id="storyline-new-arc-error" style={{ flexBasis: '100%' }}>
              <ErrorNote message={arcCreateError} />
            </div>
          )}
        </form>
      )}

      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      {loading && !arcs.length ? (
        <div className="card elev-sm">
          <Skeleton lines={5} />
        </div>
      ) : arcs.length === 0 ? (
        <EmptyState icon="oak-leaf" title="No storylines yet" hint={isDm ? 'Create an arc to start planning.' : undefined} />
      ) : (
        arcs.map((arc) => (
          <ArcCard
            key={arc.id}
            arc={arc}
            cid={cid}
            isDm={isDm}
            allBeats={allBeats}
            linkOptions={linkOptions}
            linkOptionState={{ options: linkOptions, failed: linkOptionsError, loading: linkOptionsLoading, onRetry: () => void loadLinkOptions() }}
            onChange={load}
          />
        ))
      )}
    </div>
  );
}

function ArcCard({
  arc,
  cid,
  isDm,
  allBeats,
  linkOptions,
  linkOptionState,
  onChange,
}: {
  arc: StoryArcWithBeats;
  cid: number;
  isDm: boolean;
  allBeats: Map<number, { title: string; arcTitle: string }>;
  linkOptions: LinkOptions;
  linkOptionState: LinkOptionState;
  onChange: RefreshStorylines;
}) {
  const [newBeatTitle, setNewBeatTitle] = useState('');
  const [beatCreateError, setBeatCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Issue #688: surface a failed status/delete inline next to the arc's controls so the
  // author knows their change didn't save — without resetting the select to a value that
  // hides the failure. The select's displayed value reflects server truth (refreshed on
  // success); on failure it snaps back to the last-known server value via `arc.status`.
  const [statusError, setStatusError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const newBeatTitleRef = useRef<HTMLInputElement>(null);
  // Issue #854: Enter confirming IME composition must not create a beat.
  const beatCompositionGateRef = useRef<ReturnType<typeof createCompositionSubmitGate> | null>(null);
  if (beatCompositionGateRef.current === null) {
    beatCompositionGateRef.current = createCompositionSubmitGate();
  }
  const beatCompositionGate = beatCompositionGateRef.current;
  const announce = useAnnounce();
  const arcTitleId = `storyline-arc-${arc.id}-title`;
  const arcStatusId = `storyline-arc-${arc.id}-status`;
  const newBeatTitleId = `storyline-new-beat-${arc.id}-title`;
  const newBeatErrorId = `storyline-new-beat-${arc.id}-error`;
  const arcStatusErrorId = `storyline-arc-${arc.id}-status-error`;
  const arcDeleteErrorId = `storyline-arc-${arc.id}-delete-error`;

  const setArcStatus = async (status: ArcStatus) => {
    if (busy) return;
    setStatusError(null);
    setBusy(true);
    try {
      await api.post(`${API}/arcs/${arc.id}/status`, { status });
      await onChange();
    } catch {
      // The select is controlled by `arc.status` (server truth). On failure we skip the
      // refresh, so React re-renders the select at its prior value — the author sees their
      // pick snap back and this inline note explains why. There's no pending value to retry
      // from, so the author simply re-selects to retry; we never discard any other input.
      setStatusError("Couldn't save the arc status. It wasn't changed — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const addBeat = async () => {
    const title = newBeatTitle.trim();
    if (!title || busy) return;
    setBeatCreateError(null);
    setBusy(true);
    try {
      const created = await api.post<StoryBeat>(`${API}/arcs/${arc.id}/beats`, { title });
      setNewBeatTitle('');
      await onChange(entityDomId('beat', created.id));
      announce(`Created beat ${created.title} in ${arc.title}.`);
    } catch {
      setBeatCreateError("Couldn't create the beat. Your title has been kept. Try again.");
      requestAnimationFrame(() => newBeatTitleRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const removeArc = async () => {
    if (deleteError) {
      // The arc is still here (the prior delete failed), so the confirm is moot on retry.
      // Fall through to re-attempt the same idempotent DELETE.
    } else if (!window.confirm(`Delete arc "${arc.title}" and all of its beats? This cannot be undone.`)) {
      return;
    }
    setDeleteError(null);
    setBusy(true);
    try {
      await api.delete(`${API}/arcs/${arc.id}`);
      await onChange();
    } catch {
      // Issue #688: the arc wasn't deleted. Keep it on the page and surface a targeted
      // retry so the author isn't left to guess whether the confirm "took."
      setDeleteError("Couldn't delete the arc. It's still here — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="card elev-sm"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
      aria-labelledby={arcTitleId}
      {...entityTargetProps('arc', arc.id)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h4
          id={arcTitleId}
          style={{
            fontFamily: 'var(--font-heading)',
            fontWeight: 500,
            fontSize: 17,
            opacity: arc.status === 'resolved' || arc.status === 'abandoned' ? 0.7 : 1,
            flex: '1 1 180px',
            minWidth: 0,
            margin: 0,
            overflowWrap: 'anywhere',
          }}
        >
          {arc.title}
        </h4>
        {isDm ? (
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="sr-only" htmlFor={arcStatusId}>Status for arc {arc.title}</label>
            <select
              id={arcStatusId}
              className="input"
              value={arc.status}
              disabled={busy}
              aria-invalid={statusError ? true : undefined}
              aria-describedby={statusError ? arcStatusErrorId : undefined}
              onChange={(e) => void setArcStatus(e.target.value as ArcStatus)}
              style={{ fontSize: 11, padding: '2px 6px', width: 'auto', maxWidth: '100%' }}
            >
              {ARC_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <span className={ARC_TAG_CLASS[arc.status]} style={{ fontSize: 10 }}>
            {arc.status}
          </span>
        )}
        {isDm && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12 }}
            disabled={busy}
            aria-label={`Delete arc ${arc.title}`}
            onClick={() => void removeArc()}
          >
            Delete
          </button>
        )}
      </div>

      {statusError && (
        <div id={arcStatusErrorId} style={{ marginTop: -2 }}>
          <ErrorNote message={statusError} />
        </div>
      )}
      {deleteError && (
        <div id={arcDeleteErrorId} style={{ marginTop: -2 }}>
          <ErrorNote message={deleteError} onRetry={() => void removeArc()} />
        </div>
      )}

      {arc.summary && <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>{arc.summary}</p>}

      {arc.beats.length === 0 ? (
        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>No beats yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {arc.beats.map((beat) => (
            <BeatRow
              key={beat.id}
              beat={beat}
              cid={cid}
              isDm={isDm}
              allBeats={allBeats}
              linkOptions={linkOptions}
              linkOptionState={linkOptionState}
              onChange={onChange}
            />
          ))}
        </div>
      )}

      {isDm && (
        <form
          style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', minWidth: 0 }}
          onSubmit={compositionSafeFormSubmit(beatCompositionGate, () => {
            void addBeat();
          })}
        >
          <div className="field" style={{ flex: '1 1 160px', minWidth: 0 }}>
            <label htmlFor={newBeatTitleId} style={{ overflowWrap: 'anywhere' }}>New beat in {arc.title}</label>
            <input
              ref={newBeatTitleRef}
              id={newBeatTitleId}
              className="input"
              placeholder="For example, The party reaches the gate"
              value={newBeatTitle}
              maxLength={200}
              required
              aria-invalid={beatCreateError ? true : undefined}
              aria-describedby={beatCreateError ? newBeatErrorId : undefined}
              onChange={(event) => {
                setNewBeatTitle(event.target.value);
                setBeatCreateError(null);
              }}
              style={{ fontSize: 13 }}
              {...beatCompositionGate.inputProps}
            />
          </div>
          <button type="submit" className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy || !newBeatTitle.trim()}>
            + Beat
          </button>
          {beatCreateError && (
            <div id={newBeatErrorId} style={{ flexBasis: '100%' }}>
              <ErrorNote message={beatCreateError} />
            </div>
          )}
        </form>
      )}
    </section>
  );
}

function BeatRow({
  beat,
  cid,
  isDm,
  allBeats,
  linkOptions,
  linkOptionState,
  onChange,
}: {
  beat: StoryBeatWithBranches;
  cid: number;
  isDm: boolean;
  allBeats: Map<number, { title: string; arcTitle: string }>;
  linkOptions: LinkOptions;
  linkOptionState: LinkOptionState;
  onChange: RefreshStorylines;
}) {
  const [addingBranch, setAddingBranch] = useState(false);
  const [branchLabel, setBranchLabel] = useState('');
  const [branchTarget, setBranchTarget] = useState<string>('');
  const [branchCreateError, setBranchCreateError] = useState<string | null>(null);
  const [editingLinks, setEditingLinks] = useState(false);
  const [busy, setBusy] = useState(false);
  // Issue #688: per-mutation error surfaces. Each keeps the beat on the page with its
  // data intact and offers a targeted retry; nothing is silently discarded.
  const [statusError, setStatusError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  // The pending link patch from a failed save — preserved so Retry re-sends exactly what
  // the author picked (the select snaps back to server truth, but the intent is held here).
  const [pendingLinkPatch, setPendingLinkPatch] = useState<{
    sessionId?: number | null;
    questId?: number | null;
    encounterId?: number | null;
  } | null>(null);
  const [branchDeleteError, setBranchDeleteError] = useState<{ id: number; message: string } | null>(null);
  const branchLabelRef = useRef<HTMLInputElement>(null);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  // Issue #854: Enter confirming IME composition must not create a branch.
  const branchCompositionGateRef = useRef<ReturnType<typeof createCompositionSubmitGate> | null>(null);
  if (branchCompositionGateRef.current === null) {
    branchCompositionGateRef.current = createCompositionSubmitGate();
  }
  const branchCompositionGate = branchCompositionGateRef.current;
  const announce = useAnnounce();
  const beatTitleId = `storyline-beat-${beat.id}-title`;
  const beatStatusId = `storyline-beat-${beat.id}-status`;
  const branchFormId = `storyline-new-branch-${beat.id}`;
  const branchTriggerId = `${branchFormId}-trigger`;
  const branchTargetId = `${branchFormId}-target`;
  const branchErrorId = `${branchFormId}-error`;
  const beatStatusErrorId = `storyline-beat-${beat.id}-status-error`;
  const beatDeleteErrorId = `storyline-beat-${beat.id}-delete-error`;
  const beatLinkErrorId = `storyline-beat-${beat.id}-link-error`;

  // The play-record this beat corresponds to (issue #264): resolve each linked id to a
  // display label + deep-link, so a done beat shows where it landed.
  const linkedSession = beat.sessionId != null ? linkOptions.sessions.find((s) => s.id === beat.sessionId) : undefined;
  const linkedQuest = beat.questId != null ? linkOptions.quests.find((q) => q.id === beat.questId) : undefined;
  const linkedEncounter = beat.encounterId != null ? linkOptions.encounters.find((e) => e.id === beat.encounterId) : undefined;
  const hasLinks = beat.sessionId != null || beat.questId != null || beat.encounterId != null;

  const saveLinks = async (patch: { sessionId?: number | null; questId?: number | null; encounterId?: number | null }) => {
    if (busy) return;
    setLinkError(null);
    setPendingLinkPatch(null);
    setBusy(true);
    try {
      await api.patch(`${API}/beats/${beat.id}`, patch);
      await onChange();
    } catch {
      // Issue #688: the link didn't save. The beat keeps its server-known links (the select
      // is controlled by beat.<field>, which only changes on a successful refresh), and we
      // hold the attempted patch so Retry re-sends exactly the author's intent.
      setPendingLinkPatch(patch);
      setLinkError("Couldn't save that link. The beat's links are unchanged — try again.");
    } finally {
      setBusy(false);
    }
  };

  const retrySaveLinks = () => {
    if (!pendingLinkPatch) return;
    void saveLinks(pendingLinkPatch);
  };

  const setStatus = async (status: BeatStatus) => {
    if (busy) return;
    setStatusError(null);
    setBusy(true);
    try {
      await api.post(`${API}/beats/${beat.id}/status`, { status });
      await onChange();
    } catch {
      // See ArcCard.setArcStatus: the select reverts to server truth (beat.status), and
      // this note tells the author the change didn't take. Re-selecting is the retry.
      setStatusError("Couldn't save the beat status. It wasn't changed — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const removeBeat = async () => {
    if (deleteError) {
      // Retry path: the beat is still on the page from the failed delete, so skip the
      // confirm and re-attempt the idempotent DELETE.
    } else if (!window.confirm(`Delete beat "${beat.title}"?`)) {
      return;
    }
    setDeleteError(null);
    setBusy(true);
    try {
      await api.delete(`${API}/beats/${beat.id}`);
      await onChange();
    } catch {
      setDeleteError("Couldn't delete the beat. It's still here — try again.");
    } finally {
      setBusy(false);
    }
  };

  const addBranch = async () => {
    const label = branchLabel.trim();
    if (!label || busy) return;
    setBranchCreateError(null);
    setBusy(true);
    try {
      const created = await api.post<StoryBranch>(`${API}/beats/${beat.id}/branches`, {
        label,
        ...(branchTarget ? { toBeatId: Number(branchTarget) } : {}),
      });
      setBranchLabel('');
      setBranchTarget('');
      setAddingBranch(false);
      await onChange(branchDomId(created.id));
      announce(`Created branch ${created.label} from ${beat.title}.`);
    } catch {
      setBranchCreateError("Couldn't create the branch. Your trigger and target have been kept. Try again.");
      requestAnimationFrame(() => branchLabelRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const removeBranch = async (branch: StoryBranch) => {
    if (busy) return;
    setBranchDeleteError(null);
    setBusy(true);
    try {
      await api.delete(`${API}/beats/${beat.id}/branches/${branch.id}`);
      await onChange();
    } catch {
      // Issue #688: keep the branch on the page with a targeted retry so the author
      // isn't left wondering if the click registered.
      setBranchDeleteError({ id: branch.id, message: "Couldn't delete that branch. It's still here — try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      style={{ borderLeft: '2px solid var(--color-divider, rgba(255,255,255,0.08))', paddingLeft: 10, display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}
      aria-labelledby={beatTitleId}
      {...entityTargetProps('beat', beat.id)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span aria-hidden="true" style={{ width: 14, flex: 'none', textAlign: 'center' }}>{BEAT_GLYPH[beat.status]}</span>
        <h5
          id={beatTitleId}
          style={{ fontWeight: 500, fontSize: 14, flex: '1 1 150px', minWidth: 0, margin: 0, overflowWrap: 'anywhere' }}
        >
          {beat.title}
        </h5>
        {isDm ? (
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="sr-only" htmlFor={beatStatusId}>Status for beat {beat.title}</label>
            <select
              id={beatStatusId}
              className="input"
              value={beat.status}
              disabled={busy}
              aria-invalid={statusError ? true : undefined}
              aria-describedby={statusError ? beatStatusErrorId : undefined}
              onChange={(e) => void setStatus(e.target.value as BeatStatus)}
              style={{ fontSize: 11, padding: '1px 5px', width: 'auto', maxWidth: '100%' }}
            >
              {BEAT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <span className="tag tag-neutral" style={{ fontSize: 10 }}>
            {beat.status}
          </span>
        )}
        {isDm && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 11 }}
            disabled={busy}
            aria-label={`Delete beat ${beat.title}`}
            onClick={() => void removeBeat()}
          >
            ✕
          </button>
        )}
      </div>

      {statusError && (
        <div id={beatStatusErrorId} style={{ marginLeft: 22 }}>
          <ErrorNote message={statusError} />
        </div>
      )}
      {deleteError && (
        <div id={beatDeleteErrorId} style={{ marginLeft: 22 }}>
          <ErrorNote message={deleteError} onRetry={() => void removeBeat()} />
        </div>
      )}

      {beat.body && (
        <div style={{ marginLeft: 22 }}>
          <Markdown className="text-muted !text-[12px]">{beat.body}</Markdown>
        </div>
      )}

      {/* Play-record links (issue #264): where this planned beat landed in play. */}
      {hasLinks && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 22, flexWrap: 'wrap', fontSize: 12 }}>
          {beat.sessionId != null && (
            <Link className="tag tag-neutral" style={{ fontSize: 10, textDecoration: 'none' }} to={entityHref(cid, { type: 'session', id: beat.sessionId })}>
              <GameIcon slug="book-cover" size={11} className="inline align-text-bottom mr-1" />{linkedSession ? sessionLabel(linkedSession) : `Session #${beat.sessionId}`}
            </Link>
          )}
          {beat.questId != null && (
            <Link className="tag tag-neutral" style={{ fontSize: 10, textDecoration: 'none' }} to={entityHref(cid, { type: 'quest', id: beat.questId })}>
              <GameIcon slug="scroll-unfurled" size={11} className="inline align-text-bottom mr-1" />{linkedQuest?.title ?? `Quest #${beat.questId}`}
            </Link>
          )}
          {beat.encounterId != null && (
            <Link className="tag tag-neutral" style={{ fontSize: 10, textDecoration: 'none' }} to={entityHref(cid, { type: 'encounter', id: beat.encounterId })}>
              <GameIcon slug="crossed-swords" size={11} className="inline align-text-bottom mr-1" />{linkedEncounter?.name ?? `Encounter #${beat.encounterId}`}
            </Link>
          )}
        </div>
      )}

      {isDm &&
        (editingLinks ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginLeft: 22, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                className="input"
                value={beat.sessionId != null ? String(beat.sessionId) : ''}
                disabled={busy || linkOptionState.failed.sessions}
                onChange={(e) => void saveLinks({ sessionId: e.target.value ? Number(e.target.value) : null })}
                style={{ fontSize: 12, width: 'auto' }}
                aria-label={`Linked session for ${beat.title}`}
              >
                <option value="">{linkOptionState.failed.sessions ? "— couldn't load sessions —" : '— no session —'}</option>
                {linkOptions.sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {sessionLabel(s)}
                  </option>
                ))}
              </select>
              <select
                className="input"
                value={beat.questId != null ? String(beat.questId) : ''}
                disabled={busy || linkOptionState.failed.quests}
                onChange={(e) => void saveLinks({ questId: e.target.value ? Number(e.target.value) : null })}
                style={{ fontSize: 12, width: 'auto' }}
                aria-label={`Linked quest for ${beat.title}`}
              >
                <option value="">{linkOptionState.failed.quests ? "— couldn't load quests —" : '— no quest —'}</option>
                {linkOptions.quests.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.title ?? `#${q.id}`}
                  </option>
                ))}
              </select>
              <select
                className="input"
                value={beat.encounterId != null ? String(beat.encounterId) : ''}
                disabled={busy || linkOptionState.failed.encounters}
                onChange={(e) => void saveLinks({ encounterId: e.target.value ? Number(e.target.value) : null })}
                style={{ fontSize: 12, width: 'auto' }}
                aria-label={`Linked encounter for ${beat.title}`}
              >
                <option value="">{linkOptionState.failed.encounters ? "— couldn't load encounters —" : '— no encounter —'}</option>
                {linkOptions.encounters.map((en) => (
                  <option key={en.id} value={en.id}>
                    {en.name ?? `#${en.id}`}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} disabled={busy} onClick={() => setEditingLinks(false)}>
                Done
              </button>
            </div>
            {anyLinkOptionFailed(linkOptionState.failed) && (
              <ErrorNote
                message={linkOptionState.loading ? 'Retrying linking options…' : "Couldn't load some linking options — you can still save without a link."}
                onRetry={linkOptionState.loading ? undefined : linkOptionState.onRetry}
              />
            )}
            {linkError && (
              <div id={beatLinkErrorId}>
                <ErrorNote message={linkError} onRetry={retrySaveLinks} />
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 11, marginLeft: 22, alignSelf: 'flex-start' }}
            disabled={busy}
            onClick={() => setEditingLinks(true)}
          >
            <GameIcon slug="linked-rings" size={11} className="inline align-text-bottom mr-1" />{hasLinks ? 'Edit links' : 'Link to play'}
          </button>
        ))}

      {beat.branches.map((branch) => {
        const target = branch.toBeatId != null ? allBeats.get(branch.toBeatId) : undefined;
        const branchErr = branchDeleteError && branchDeleteError.id === branch.id ? branchDeleteError : null;
        return (
          <div
            key={branch.id}
            id={branchDomId(branch.id)}
            role="group"
            tabIndex={-1}
            aria-label={`Branch ${branch.label} from ${beat.title}`}
            style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 22, minWidth: 0, flexWrap: 'wrap', fontSize: 12.5 }}
          >
            <span aria-hidden="true" className="text-muted">↳</span>
            <span className="tag tag-outline" style={{ fontSize: 10, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{branch.label}</span>
            <span className="text-muted" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {target ? `→ ${target.title}` : branch.toBeatId != null ? '→ (unknown beat)' : '→ (open)'}
            </span>
            {isDm && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 10, padding: '0 4px' }}
                disabled={busy}
                aria-label={`Delete branch ${branch.label} from ${beat.title}`}
                onClick={() => void removeBranch(branch)}
              >
                ✕
              </button>
            )}
            {branchErr && (
              <ErrorNote message={branchErr.message} onRetry={() => void removeBranch(branch)} />
            )}
          </div>
        );
      })}

      {isDm &&
        (addingBranch ? (
          <form
            id={branchFormId}
            style={{ marginLeft: 22, minWidth: 0 }}
            onSubmit={compositionSafeFormSubmit(branchCompositionGate, () => {
              void addBranch();
            })}
          >
            <fieldset style={{ minWidth: 0 }}>
              <legend style={{ marginBottom: 5, fontSize: 12, fontWeight: 600, overflowWrap: 'anywhere' }}>
                New branch from {beat.title}
              </legend>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))',
                  gap: 6,
                  alignItems: 'end',
                  minWidth: 0,
                }}
              >
                <div className="field" style={{ minWidth: 0 }}>
                  <label htmlFor={branchTriggerId}>Trigger</label>
                  <input
                    ref={branchLabelRef}
                    id={branchTriggerId}
                    className="input"
                    placeholder="For example, If the party flees"
                    value={branchLabel}
                    maxLength={200}
                    required
                    aria-invalid={branchCreateError ? true : undefined}
                    aria-describedby={branchCreateError ? branchErrorId : undefined}
                    onChange={(event) => {
                      setBranchLabel(event.target.value);
                      setBranchCreateError(null);
                    }}
                    style={{ fontSize: 12, minWidth: 0 }}
                    {...branchCompositionGate.inputProps}
                  />
                </div>
                <div className="field" style={{ minWidth: 0 }}>
                  <label htmlFor={branchTargetId}>Target beat</label>
                  <select
                    id={branchTargetId}
                    className="input"
                    value={branchTarget}
                    onChange={(e) => {
                      setBranchTarget(e.target.value);
                      setBranchCreateError(null);
                    }}
                    style={{ fontSize: 12, width: '100%', minWidth: 0, maxWidth: '100%' }}
                  >
                    <option value="">No target yet</option>
                    {[...allBeats.entries()]
                      .filter(([id]) => id !== beat.id)
                      .map(([id, info]) => (
                        <option key={id} value={id}>
                          {info.arcTitle} · {info.title}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                <button type="submit" className="btn btn-ghost" style={{ fontSize: 11 }} disabled={busy || !branchLabel.trim()}>
                  Add branch
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 11 }}
                  disabled={busy}
                  onClick={() => {
                    setAddingBranch(false);
                    setBranchLabel('');
                    setBranchTarget('');
                    setBranchCreateError(null);
                    requestAnimationFrame(() => branchTriggerRef.current?.focus());
                  }}
                >
                  Cancel
                </button>
              </div>
              {branchCreateError && (
                <div id={branchErrorId} style={{ marginTop: 6 }}>
                  <ErrorNote message={branchCreateError} />
                </div>
              )}
            </fieldset>
          </form>
        ) : (
          <button
            ref={branchTriggerRef}
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 11, marginLeft: 22, alignSelf: 'flex-start' }}
            disabled={busy}
            aria-expanded="false"
            aria-controls={branchFormId}
            onClick={() => {
              setAddingBranch(true);
              requestAnimationFrame(() => branchLabelRef.current?.focus());
            }}
          >
            + Branch
          </button>
        ))}
    </section>
  );
}
