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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  StoryArcWithBeats,
  StoryBeatWithBranches,
  StoryBranch,
  ArcStatus,
  BeatStatus,
} from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { Markdown } from '../../components/Markdown';

/** Minimal shapes for the play-record link-picker option lists (issue #264). */
type NamedRow = { id: number; name?: string; title?: string; number?: number };
type LinkOptions = { sessions: NamedRow[]; quests: NamedRow[]; encounters: NamedRow[] };
const EMPTY_LINK_OPTIONS: LinkOptions = { sessions: [], quests: [], encounters: [] };

function sessionLabel(s: NamedRow): string {
  return s.title || `Session ${s.number ?? s.id}`;
}

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

  const [arcs, setArcs] = useState<StoryArcWithBeats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [newArcTitle, setNewArcTitle] = useState('');
  const [busy, setBusy] = useState(false);
  // Play-record link options (issue #264) — the sessions/quests/encounters a beat can
  // link to. Fetched once; empty lists just leave the pickers showing "— none —".
  const [linkOptions, setLinkOptions] = useState<LinkOptions>(EMPTY_LINK_OPTIONS);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const list = await api.get<StoryArcWithBeats[]>(`${API}/campaigns/${cid}/arcs`);
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

  // Load the play-record link options once the campaign is known (issue #264). The whole
  // page is DM-only, so these DM-scoped lists are always available here. Failures degrade
  // gracefully to empty pickers rather than blocking the arc/beat view.
  useEffect(() => {
    if (!Number.isFinite(cid)) return;
    let cancelled = false;
    void Promise.all([
      api.get<NamedRow[]>(`${API}/campaigns/${cid}/sessions`).catch(() => [] as NamedRow[]),
      api.get<NamedRow[]>(`${API}/campaigns/${cid}/quests`).catch(() => [] as NamedRow[]),
      api.get<NamedRow[]>(`${API}/campaigns/${cid}/encounters`).catch(() => [] as NamedRow[]),
    ]).then(([sessions, quests, encounters]) => {
      if (cancelled) return;
      setLinkOptions({ sessions, quests, encounters });
    });
    return () => {
      cancelled = true;
    };
  }, [cid]);

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
    setBusy(true);
    try {
      await api.post(`${API}/campaigns/${cid}/arcs`, { title });
      setNewArcTitle('');
      await load();
    } catch {
      setError("Couldn't create the arc.");
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
      </div>

      <p className="text-muted" style={{ margin: '-6px 0 0', fontSize: 12 }}>
        Plan future beats with branching options. Arcs group ordered beats; each beat can branch to next beats via
        labelled triggers.
      </p>

      {isDm && (
        <div className="card elev-sm" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder="New arc title…"
            value={newArcTitle}
            maxLength={200}
            onChange={(e) => setNewArcTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createArc();
            }}
            style={{ flex: 1, minWidth: 180 }}
          />
          <button className="btn btn-primary" style={{ fontSize: 13 }} disabled={busy || !newArcTitle.trim()} onClick={() => void createArc()}>
            + New arc
          </button>
        </div>
      )}

      {error && <ErrorNote message={error} onRetry={load} />}

      {loading && !arcs.length ? (
        <div className="card elev-sm">
          <Skeleton lines={5} />
        </div>
      ) : arcs.length === 0 ? (
        <EmptyState icon="oak-leaf" title="No storylines yet" hint={isDm ? 'Create an arc to start planning.' : undefined} />
      ) : (
        arcs.map((arc) => (
          <ArcCard key={arc.id} arc={arc} cid={cid} isDm={isDm} allBeats={allBeats} linkOptions={linkOptions} onChange={load} />
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
  onChange,
}: {
  arc: StoryArcWithBeats;
  cid: number;
  isDm: boolean;
  allBeats: Map<number, { title: string; arcTitle: string }>;
  linkOptions: LinkOptions;
  onChange: () => Promise<void>;
}) {
  const [newBeatTitle, setNewBeatTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const setArcStatus = async (status: ArcStatus) => {
    setBusy(true);
    try {
      await api.post(`${API}/arcs/${arc.id}/status`, { status });
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const addBeat = async () => {
    const title = newBeatTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await api.post(`${API}/arcs/${arc.id}/beats`, { title });
      setNewBeatTitle('');
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const removeArc = async () => {
    if (!window.confirm(`Delete arc "${arc.title}" and all of its beats? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.delete(`${API}/arcs/${arc.id}`);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card elev-sm" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            fontFamily: 'var(--font-heading)',
            fontWeight: 500,
            fontSize: 17,
            opacity: arc.status === 'resolved' || arc.status === 'abandoned' ? 0.7 : 1,
          }}
        >
          {arc.title}
        </span>
        {isDm ? (
          <select
            className="input"
            value={arc.status}
            disabled={busy}
            onChange={(e) => void setArcStatus(e.target.value as ArcStatus)}
            style={{ fontSize: 11, padding: '2px 6px', width: 'auto' }}
            aria-label="Arc status"
          >
            {ARC_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <span className={ARC_TAG_CLASS[arc.status]} style={{ fontSize: 10 }}>
            {arc.status}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {isDm && (
          <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={() => void removeArc()}>
            Delete
          </button>
        )}
      </div>

      {arc.summary && <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>{arc.summary}</p>}

      {arc.beats.length === 0 ? (
        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>No beats yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {arc.beats.map((beat) => (
            <BeatRow key={beat.id} beat={beat} cid={cid} isDm={isDm} allBeats={allBeats} linkOptions={linkOptions} onChange={onChange} />
          ))}
        </div>
      )}

      {isDm && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder="Add a beat…"
            value={newBeatTitle}
            onChange={(e) => setNewBeatTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addBeat();
            }}
            style={{ flex: 1, minWidth: 160, fontSize: 13 }}
          />
          <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy || !newBeatTitle.trim()} onClick={() => void addBeat()}>
            + Beat
          </button>
        </div>
      )}
    </div>
  );
}

function BeatRow({
  beat,
  cid,
  isDm,
  allBeats,
  linkOptions,
  onChange,
}: {
  beat: StoryBeatWithBranches;
  cid: number;
  isDm: boolean;
  allBeats: Map<number, { title: string; arcTitle: string }>;
  linkOptions: LinkOptions;
  onChange: () => Promise<void>;
}) {
  const [addingBranch, setAddingBranch] = useState(false);
  const [branchLabel, setBranchLabel] = useState('');
  const [branchTarget, setBranchTarget] = useState<string>('');
  const [editingLinks, setEditingLinks] = useState(false);
  const [busy, setBusy] = useState(false);

  // The play-record this beat corresponds to (issue #264): resolve each linked id to a
  // display label + deep-link, so a done beat shows where it landed.
  const linkedSession = beat.sessionId != null ? linkOptions.sessions.find((s) => s.id === beat.sessionId) : undefined;
  const linkedQuest = beat.questId != null ? linkOptions.quests.find((q) => q.id === beat.questId) : undefined;
  const linkedEncounter = beat.encounterId != null ? linkOptions.encounters.find((e) => e.id === beat.encounterId) : undefined;
  const hasLinks = beat.sessionId != null || beat.questId != null || beat.encounterId != null;

  const saveLinks = async (patch: { sessionId?: number | null; questId?: number | null; encounterId?: number | null }) => {
    setBusy(true);
    try {
      await api.patch(`${API}/beats/${beat.id}`, patch);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: BeatStatus) => {
    setBusy(true);
    try {
      await api.post(`${API}/beats/${beat.id}/status`, { status });
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const removeBeat = async () => {
    if (!window.confirm(`Delete beat "${beat.title}"?`)) return;
    setBusy(true);
    try {
      await api.delete(`${API}/beats/${beat.id}`);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const addBranch = async () => {
    const label = branchLabel.trim();
    if (!label || busy) return;
    setBusy(true);
    try {
      await api.post(`${API}/beats/${beat.id}/branches`, {
        label,
        ...(branchTarget ? { toBeatId: Number(branchTarget) } : {}),
      });
      setBranchLabel('');
      setBranchTarget('');
      setAddingBranch(false);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const removeBranch = async (branch: StoryBranch) => {
    setBusy(true);
    try {
      await api.delete(`${API}/beats/${beat.id}/branches/${branch.id}`);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ borderLeft: '2px solid var(--color-border)', paddingLeft: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ width: 14, textAlign: 'center' }}>{BEAT_GLYPH[beat.status]}</span>
        <span style={{ fontWeight: 500, fontSize: 14 }}>{beat.title}</span>
        {isDm ? (
          <select
            className="input"
            value={beat.status}
            disabled={busy}
            onChange={(e) => void setStatus(e.target.value as BeatStatus)}
            style={{ fontSize: 11, padding: '1px 5px', width: 'auto' }}
            aria-label="Beat status"
          >
            {BEAT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <span className="tag tag-neutral" style={{ fontSize: 10 }}>
            {beat.status}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {isDm && (
          <button className="btn btn-ghost" style={{ fontSize: 11 }} disabled={busy} onClick={() => void removeBeat()}>
            ✕
          </button>
        )}
      </div>

      {beat.body && (
        <div style={{ marginLeft: 22 }}>
          <Markdown className="text-muted !text-[12px]">{beat.body}</Markdown>
        </div>
      )}

      {/* Play-record links (issue #264): where this planned beat landed in play. */}
      {hasLinks && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 22, flexWrap: 'wrap', fontSize: 12 }}>
          {beat.sessionId != null && (
            <Link className="tag tag-neutral" style={{ fontSize: 10, textDecoration: 'none' }} to={`/c/${cid}/sessions?session=${beat.sessionId}`}>
              <GameIcon slug="book-cover" size={11} className="inline align-text-bottom mr-1" />{linkedSession ? sessionLabel(linkedSession) : `Session #${beat.sessionId}`}
            </Link>
          )}
          {beat.questId != null && (
            <Link className="tag tag-neutral" style={{ fontSize: 10, textDecoration: 'none' }} to={`/c/${cid}/quests/${beat.questId}`}>
              <GameIcon slug="scroll-unfurled" size={11} className="inline align-text-bottom mr-1" />{linkedQuest?.title ?? `Quest #${beat.questId}`}
            </Link>
          )}
          {beat.encounterId != null && (
            <Link className="tag tag-neutral" style={{ fontSize: 10, textDecoration: 'none' }} to={`/c/${cid}/encounters/${beat.encounterId}`}>
              <GameIcon slug="crossed-swords" size={11} className="inline align-text-bottom mr-1" />{linkedEncounter?.name ?? `Encounter #${beat.encounterId}`}
            </Link>
          )}
        </div>
      )}

      {isDm &&
        (editingLinks ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 22, flexWrap: 'wrap' }}>
            <select
              className="input"
              value={beat.sessionId != null ? String(beat.sessionId) : ''}
              disabled={busy}
              onChange={(e) => void saveLinks({ sessionId: e.target.value ? Number(e.target.value) : null })}
              style={{ fontSize: 12, width: 'auto' }}
              aria-label="Linked session"
            >
              <option value="">— no session —</option>
              {linkOptions.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {sessionLabel(s)}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={beat.questId != null ? String(beat.questId) : ''}
              disabled={busy}
              onChange={(e) => void saveLinks({ questId: e.target.value ? Number(e.target.value) : null })}
              style={{ fontSize: 12, width: 'auto' }}
              aria-label="Linked quest"
            >
              <option value="">— no quest —</option>
              {linkOptions.quests.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.title ?? `#${q.id}`}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={beat.encounterId != null ? String(beat.encounterId) : ''}
              disabled={busy}
              onChange={(e) => void saveLinks({ encounterId: e.target.value ? Number(e.target.value) : null })}
              style={{ fontSize: 12, width: 'auto' }}
              aria-label="Linked encounter"
            >
              <option value="">— no encounter —</option>
              {linkOptions.encounters.map((en) => (
                <option key={en.id} value={en.id}>
                  {en.name ?? `#${en.id}`}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} disabled={busy} onClick={() => setEditingLinks(false)}>
              Done
            </button>
          </div>
        ) : (
          <button
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
        return (
          <div key={branch.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 22, fontSize: 12.5 }}>
            <span className="text-muted">↳</span>
            <span className="tag tag-outline" style={{ fontSize: 10 }}>{branch.label}</span>
            <span className="text-muted">
              {target ? `→ ${target.title}` : branch.toBeatId != null ? '→ (unknown beat)' : '→ (open)'}
            </span>
            {isDm && (
              <button className="btn btn-ghost" style={{ fontSize: 10, padding: '0 4px' }} disabled={busy} onClick={() => void removeBranch(branch)}>
                ✕
              </button>
            )}
          </div>
        );
      })}

      {isDm &&
        (addingBranch ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 22, flexWrap: 'wrap' }}>
            <input
              className="input"
              placeholder="Trigger label (e.g. if they flee)"
              value={branchLabel}
              onChange={(e) => setBranchLabel(e.target.value)}
              style={{ fontSize: 12, minWidth: 160 }}
            />
            <select
              className="input"
              value={branchTarget}
              onChange={(e) => setBranchTarget(e.target.value)}
              style={{ fontSize: 12, width: 'auto' }}
              aria-label="Branch target beat"
            >
              <option value="">(no target)</option>
              {[...allBeats.entries()]
                .filter(([id]) => id !== beat.id)
                .map(([id, info]) => (
                  <option key={id} value={id}>
                    {info.arcTitle} · {info.title}
                  </option>
                ))}
            </select>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} disabled={busy || !branchLabel.trim()} onClick={() => void addBranch()}>
              Add
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11 }}
              disabled={busy}
              onClick={() => {
                setAddingBranch(false);
                setBranchLabel('');
                setBranchTarget('');
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="btn btn-ghost"
            style={{ fontSize: 11, marginLeft: 22, alignSelf: 'flex-start' }}
            disabled={busy}
            onClick={() => setAddingBranch(true)}
          >
            + Branch
          </button>
        ))}
    </div>
  );
}
