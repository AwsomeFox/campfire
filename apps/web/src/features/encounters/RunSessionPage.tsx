/**
 * Run session — live combat tracker. /c/:campaignId/encounters/:encounterId.
 * Mirrors design/claude-design/Campfire.dc.html "Run session" live state
 * (~L1389-1503) and "Encounter" initiative list (~L991-1024): header with
 * status chip + round + DM controls, initiative-sorted combatant rows
 * (current turn = accent left-border + glow), HP −/+ steppers, condition
 * chips, DM add-combatant panel (manual / compendium / party tabs), and a
 * dice log widget (expr input + roll history) per "Dice log" (~L1479-1499).
 *
 * Permissions: DM can edit any combatant, add/remove combatants, and drive
 * turn/round/status. Players may only adjust HP/conditions on the combatant
 * that maps to their own character (via campaign characters' ownerUserId).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  AoeShape,
  AoeTemplate,
  Attachment,
  Character,
  Combatant,
  CombatantKind,
  DifficultyBand,
  EncounterDifficulty,
  EncounterEvent,
  EncounterWithCombatants,
  FogState,
  GridType,
  MapPing,
  Npc,
  RuleEntry,
  RulePack,
  TokenSize,
} from '@campfire/schema';
import { ruleSystemAdapter } from '@campfire/schema';
import { entityTargetProps, entityHref } from '../../lib/entityLinks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API, ApiError } from '../../lib/api';
import { queryKeys, invalidateCampaignCharacters, invalidateEncounter } from '../../lib/query';
import { useCampaignEvents, type CampaignEventsStatus } from '../../lib/useCampaignEvents';
import {
  inlineCharacterSheetsInteractive,
  inlineCharacterSheetsStatusLabel,
  shouldInvalidateInlineCharacters,
} from './inlineCharacterCards';
import { initials as tokenInitials } from '../../lib/avatarText';
import { useAuth } from '../../app/auth';
import { useCampaign } from '../../app/CampaignContext';
import { SharedDiceLog } from '../dice/SharedDiceLog';
import { StatBlock, hasMonsterStatblock } from '../../components/StatBlock';
import { CharacterStatCard } from '../../components/CharacterStatCard';
import { Card, Btn, TextInput, HpBar, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { ImageUpload, MapUploadButton, attachmentFileUrl, uploadAttachment } from '../../components/ImageUpload';
import { GetAMapPanel } from '../../components/GetAMapPanel';
import { NotFoundState } from '../../components/NotFoundState';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useAnnounce } from '../../components/Announcer';
import { useAiDmLiveActivity } from '../ai-dm/useAiDmLiveActivity';
import { AiDmPresenceTag, AiDmToolActivityRow } from '../ai-dm/AiDmActivityChip';
import { resolveToolActivity } from '../ai-dm/toolActivity';
import { GameIcon } from '../../components/GameIcon';
import {
  advanceCombatLogAnnouncements,
  formatCombatLogAnnouncementBatch,
  formatCombatLogEventSummary,
  type CombatLogAnnouncementCursor,
} from './combatLogAccessibility';
import { makeActionError, type ActionErrorState } from './encounterActionError';
import {
  deleteConfirmCopy,
  dmLifecycleActions,
  isLifecycleConfirmValid,
} from './encounterLifecycleActions';
import { ENCOUNTER_LIFECYCLE_STEPS, preparingGuidance } from './postCreateGuidance';

const STATUS_LABEL: Record<string, string> = {
  preparing: 'Preparing',
  running: 'Running',
  ended: 'Ended',
};

const STATUS_TAG_CLASS: Record<string, string> = {
  preparing: 'tag tag-neutral',
  running: 'tag tag-accent',
  ended: 'tag tag-outline',
};

type EncounterGridPatch = Partial<
  Pick<EncounterWithCombatants, 'gridSize' | 'gridScale' | 'gridUnit' | 'gridSnap' | 'gridType'>
>;

/** Stable serialization for suppressing an equivalent encounter PATCH while it is in flight. */
function encounterPatchKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(encounterPatchKey).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${encounterPatchKey(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Defaults shown by the grid panel must become real encounter state once the grid is enabled. */
function missingGridDefaults(encounter: EncounterWithCombatants): EncounterGridPatch | null {
  if (encounter.gridSize == null || encounter.gridSize <= 0) return null;
  const patch: EncounterGridPatch = {};
  if (encounter.gridScale == null) patch.gridScale = 5;
  if (encounter.gridUnit == null) patch.gridUnit = 'ft';
  return Object.keys(patch).length > 0 ? patch : null;
}

function gridDefaultAttemptKey(encounterId: number, patch: EncounterGridPatch): string {
  return `${encounterId}:${Object.keys(patch).sort().join(',')}`;
}

// Band colors live as --cf-difficulty-* tokens in index.css (issue #668) so a
// theme or dark/light swap can reach them; difficulty wants a green→red ramp
// distinct from the accent-colored status chips and from the destructive family.
const DIFFICULTY_STYLE: Record<DifficultyBand, { background: string; color: string }> = {
  trivial: { background: 'var(--cf-difficulty-trivial-bg)', color: 'var(--cf-difficulty-trivial-fg)' },
  easy: { background: 'var(--cf-difficulty-easy-bg)', color: 'var(--cf-difficulty-easy-fg)' },
  medium: { background: 'var(--cf-difficulty-medium-bg)', color: 'var(--cf-difficulty-medium-fg)' },
  hard: { background: 'var(--cf-difficulty-hard-bg)', color: 'var(--cf-difficulty-hard-fg)' },
  deadly: { background: 'var(--cf-difficulty-deadly-bg)', color: 'var(--cf-difficulty-deadly-fg)' },
};
const DIFFICULTY_NEUTRAL_STYLE = {
  background: 'var(--color-neutral-800)',
  color: 'var(--color-neutral-200)',
};

/**
 * Difficulty badge shown in the encounter header (issues #58 + #429). Reads
 * GET /encounters/:id/difficulty. Hidden when there are no monsters. Zero-data
 * fights show the adapter's "Unknown—add XP/CR" label (never a fake Trivial);
 * unsupported rulesets explain the limitation. `title` surfaces XP math + warnings.
 */
function DifficultyBadge({ difficulty }: { difficulty: EncounterDifficulty | null }) {
  if (!difficulty) return null;
  if (difficulty.monsterCount === 0) return null;

  if (difficulty.status === 'unsupported') {
    const title = [...difficulty.warnings, ...difficulty.assumptions].filter(Boolean).join(' ') || difficulty.label;
    return (
      <span className="tag" style={DIFFICULTY_NEUTRAL_STYLE} title={title}>
        <GameIcon slug="crossed-swords" size={12} className="inline align-text-bottom mr-1" />
        {difficulty.label}
      </span>
    );
  }

  if (difficulty.status === 'unknown' || difficulty.band === null) {
    const title = [...difficulty.warnings, ...difficulty.assumptions].filter(Boolean).join(' ') || difficulty.label;
    return (
      <span className="tag" style={DIFFICULTY_NEUTRAL_STYLE} title={title}>
        <GameIcon slug="crossed-swords" size={12} className="inline align-text-bottom mr-1" />
        {difficulty.label}
      </span>
    );
  }

  const breakdown =
    `Adjusted monster XP ${difficulty.adjustedXp.toLocaleString()} ` +
    `(${difficulty.totalMonsterXp.toLocaleString()} × ${difficulty.multiplier}) vs party thresholds — ` +
    `easy ${difficulty.thresholds.easy.toLocaleString()}, medium ${difficulty.thresholds.medium.toLocaleString()}, ` +
    `hard ${difficulty.thresholds.hard.toLocaleString()}, deadly ${difficulty.thresholds.deadly.toLocaleString()}`;
  const title = [breakdown, ...difficulty.warnings, ...difficulty.assumptions].filter(Boolean).join(' · ');
  return (
    <span className="tag" style={DIFFICULTY_STYLE[difficulty.band]} title={title}>
      <GameIcon slug="crossed-swords" size={12} className="inline align-text-bottom mr-1" />
      {difficulty.label}
    </span>
  );
}

type LinkRow = { id: number; name?: string; title?: string; number?: number };
function linkLabel(kind: 'location' | 'quest' | 'session', row: LinkRow): string {
  if (kind === 'session') return row.title || `Session ${row.number ?? row.id}`;
  return row.title ?? row.name ?? `#${row.id}`;
}

/**
 * Encounter location/quest/session links (issue #126). Shows the current attachments as
 * chips; the DM can expand an inline editor to (re)attach or clear each link, persisted
 * via PATCH /encounters/:id. Non-DM members see the chips read-only (nothing at all when
 * an encounter is unlinked, so the header stays clean).
 */
function EncounterLinks({
  campaignId,
  encounter,
  canEdit,
  onSaved,
}: {
  campaignId: number;
  encounter: EncounterWithCombatants;
  canEdit: boolean;
  onSaved: (updated: Partial<EncounterWithCombatants>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [locations, setLocations] = useState<LinkRow[]>([]);
  const [quests, setQuests] = useState<LinkRow[]>([]);
  const [sessions, setSessions] = useState<LinkRow[]>([]);
  const [linkListsLoaded, setLinkListsLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasLink = encounter.locationId != null || encounter.questId != null || encounter.sessionId != null;

  useEffect(() => {
    if ((!editing && !hasLink) || linkListsLoaded) return;
    let cancelled = false;
    void Promise.all([
      api.get<LinkRow[]>(`${API}/campaigns/${campaignId}/locations`).catch(() => []),
      api.get<LinkRow[]>(`${API}/campaigns/${campaignId}/quests`).catch(() => []),
      api.get<LinkRow[]>(`${API}/campaigns/${campaignId}/sessions`).catch(() => []),
    ]).then(([locs, qs, sess]) => {
      if (cancelled) return;
      setLocations(locs);
      setQuests(qs);
      setSessions(sess);
      setLinkListsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [editing, hasLink, campaignId, linkListsLoaded]);

  const locName = locations.find((l) => l.id === encounter.locationId);
  const questName = quests.find((q) => q.id === encounter.questId);
  const sessName = sessions.find((s) => s.id === encounter.sessionId);

  async function save(patch: Record<string, number | null>) {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.patch<EncounterWithCombatants>(`${API}/encounters/${encounter.id}`, patch);
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update links.");
    } finally {
      setSaving(false);
    }
  }

  const showLoc = encounter.locationId != null && (canEdit || locName != null);
  const showQuest = encounter.questId != null && (canEdit || questName != null);
  const showSess = encounter.sessionId != null && (canEdit || sessName != null);
  const hasVisibleLink = showLoc || showQuest || showSess;

  if (!canEdit && !hasVisibleLink) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 'var(--type-meta)' }}>
      {showLoc && (
        locName ? <Link
          to={entityHref(campaignId, { type: 'location', id: encounter.locationId })}
          className="tag tag-outline hover:border-accent"
        >
          <GameIcon slug="treasure-map" size={11} className="inline align-text-bottom mr-1" />
          {linkLabel('location', locName)}
        </Link> : <span className="tag tag-outline text-muted">
          <GameIcon slug="treasure-map" size={11} className="inline align-text-bottom mr-1" />
          Location #{encounter.locationId} (unavailable)
        </span>
      )}
      {showQuest && (
        questName ? <Link
          to={entityHref(campaignId, { type: 'quest', id: encounter.questId })}
          className="tag tag-outline hover:border-accent"
        >
          <GameIcon slug="scroll-unfurled" size={11} className="inline align-text-bottom mr-1" />
          {linkLabel('quest', questName)}
        </Link> : <span className="tag tag-outline text-muted">
          <GameIcon slug="scroll-unfurled" size={11} className="inline align-text-bottom mr-1" />
          Quest #{encounter.questId} (unavailable)
        </span>
      )}
      {showSess && (
        sessName ? <Link
          to={entityHref(campaignId, { type: 'session', id: encounter.sessionId })}
          className="tag tag-outline hover:border-accent"
        >
          <GameIcon slug="book-cover" size={11} className="inline align-text-bottom mr-1" />
          {linkLabel('session', sessName)}
        </Link> : <span className="tag tag-outline text-muted">
          <GameIcon slug="book-cover" size={11} className="inline align-text-bottom mr-1" />
          Session #{encounter.sessionId} (unavailable)
        </span>
      )}
      {!hasLink && canEdit && !editing && <span className="text-muted">No location / quest / session linked.</span>}
      {canEdit && (
        <button type="button" className="btn btn-ghost" style={{ fontSize: 'var(--type-label)' }} onClick={() => setEditing((v) => !v)}>
          {editing ? 'Done' : hasLink ? 'Edit links' : '+ Link'}
        </button>
      )}
      {error && <span className="text-rose-400">{error}</span>}
      {editing && canEdit && (
        <div className="flex gap-2 flex-wrap w-full mt-1">
          <select
            className="cf-select !min-h-0 !py-1.5 text-xs"
            aria-label="Location"
            value={encounter.locationId ?? ''}
            disabled={saving}
            onChange={(e) => void save({ locationId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">— no location —</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {linkLabel('location', l)}
              </option>
            ))}
          </select>
          <select
            className="cf-select !min-h-0 !py-1.5 text-xs"
            aria-label="Quest"
            value={encounter.questId ?? ''}
            disabled={saving}
            onChange={(e) => void save({ questId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">— no quest —</option>
            {quests.map((q) => (
              <option key={q.id} value={q.id}>
                {linkLabel('quest', q)}
              </option>
            ))}
          </select>
          <select
            className="cf-select !min-h-0 !py-1.5 text-xs"
            aria-label="Session"
            value={encounter.sessionId ?? ''}
            disabled={saving}
            onChange={(e) => void save({ sessionId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">— no session —</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {linkLabel('session', s)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

// Non-DM viewers see a monster's HP as a coarse status band, never exact numbers
// (issue #43 — the server redacts hpCurrent/hpMax to null and sends hpBand instead).
const HP_BAND_LABEL: Record<string, string> = {
  healthy: 'Healthy',
  bloodied: 'Bloodied',
  critical: 'Critical',
  down: 'Down',
};
const HP_BAND_PCT: Record<string, number> = { healthy: 100, bloodied: 50, critical: 20, down: 0 };
const HP_BAND_TONE: Record<string, string> = { healthy: '', bloodied: 'low', critical: 'crit', down: 'crit' };

/** Fuzzy HP indicator for redacted monster rows — mirrors HpBar's look off a band. */
function HpBandBar({ band }: { band: string | null }) {
  const pct = band ? (HP_BAND_PCT[band] ?? 0) : 0;
  const tone = band ? (HP_BAND_TONE[band] ?? '') : '';
  return (
    <div className={`cf-hp ${tone}`}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A combatant is "down" when at 0 HP, or (for a redacted monster) banded 'down'. */
function isDown(c: Combatant): boolean {
  return c.hpCurrent != null ? c.hpCurrent <= 0 : c.hpBand === 'down';
}

const DEATH_STATE_LABEL: Record<string, string> = { dying: 'Dying', stable: 'Stable', dead: 'Dead' };

/**
 * 5e death-save tracker (issue #57): three success pips + three failure pips for a
 * character at 0 HP. Clicking a pip sets the count to that position (clicking the
 * highest-lit pip clears it back down), committing via onSet. Read-only unless canEdit.
 *
 * Roll button (issue #619): rolls a d20 and posts `deathSaveRoll` to the server, which
 * applies the 5e crit/fumble rules — nat 1 = two failure pips, nat 20 = revive at 1 HP
 * (saves cleared), 10–19 = one success, 2–9 = one failure. The server's response is the
 * source of truth for the counters + HP; the button just supplies the d20 face.
 */
function DeathSaveTracker({
  successes,
  failures,
  canEdit,
  busy,
  onSet,
  onRoll,
}: {
  successes: number;
  failures: number;
  canEdit: boolean;
  busy: boolean;
  onSet: (patch: { deathSaveSuccesses?: number; deathSaveFailures?: number }) => void;
  onRoll: () => void;
}) {
  function Pips({ kind, count, color }: { kind: 'deathSaveSuccesses' | 'deathSaveFailures'; count: number; color: string }) {
    return (
      <span style={{ display: 'inline-flex', gap: 3 }}>
        {[0, 1, 2].map((i) => {
          const filled = i < count;
          const next = count === i + 1 ? i : i + 1; // click the highest-lit pip to clear it
          return (
            <button
              key={i}
              type="button"
              aria-label={`${kind === 'deathSaveSuccesses' ? 'Success' : 'Failure'} ${i + 1} of 3${filled ? ' (marked)' : ''}`}
              aria-pressed={filled}
              disabled={!canEdit || busy}
              onClick={() => onSet({ [kind]: next })}
              style={{
                width: 13,
                height: 13,
                borderRadius: '50%',
                padding: 0,
                border: `1.5px solid ${color}`,
                background: filled ? color : 'transparent',
                cursor: canEdit && !busy ? 'pointer' : 'default',
              }}
            />
          );
        })}
      </span>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 5, fontSize: 'var(--type-label)', flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
        <span className="text-muted" style={{ letterSpacing: 0.3 }}>Saves</span>
        <Pips kind="deathSaveSuccesses" count={successes} color="var(--color-accent)" />
      </span>
      <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
        <span className="text-muted" style={{ letterSpacing: 0.3 }}>Fails</span>
        <Pips kind="deathSaveFailures" count={failures} color="#e5484d" />
      </span>
      {canEdit && (
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="Roll a death save"
          title="Roll a death save (nat 1 = two fails, nat 20 = revive at 1 HP)"
          disabled={busy}
          onClick={onRoll}
          style={{ fontSize: 'var(--type-label)', minHeight: 20, padding: '1px 8px', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
        >
          Roll
        </button>
      )}
    </div>
  );
}

/**
 * Optimistic HP application (issue #73) — the local guess we write into the query cache
 * the instant an HP stepper is clicked, so a DM spamming ±1 sees each hit land without
 * waiting a round-trip. Mirrors the server's 5e math closely enough for the interim
 * render; `onSettled` invalidates and reconciles against server truth. A redacted monster
 * (exact HP hidden — issue #43) has null HP and gets no optimistic guess.
 */
function applyHpDelta(c: Combatant, delta: number): Combatant {
  if (c.hpCurrent == null || c.hpMax == null) return c;
  if (delta >= 0) {
    return { ...c, hpCurrent: Math.min(c.hpMax, c.hpCurrent + delta) };
  }
  // Damage: temporary HP absorbs first, then real HP, floored at 0.
  const dmg = -delta;
  const temp = c.hpTemp ?? 0;
  const fromTemp = Math.min(temp, dmg);
  const overflow = dmg - fromTemp;
  return { ...c, hpTemp: temp - fromTemp, hpCurrent: Math.max(0, c.hpCurrent - overflow) };
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

export default function RunSessionPage() {
  const { campaignId, encounterId } = useParams<{ campaignId: string; encounterId: string }>();
  const cid = Number(campaignId);
  const eid = Number(encounterId);
  const navigate = useNavigate();
  const { me, roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';
  const campaign = useCampaign(Number.isFinite(cid) ? cid : undefined);
  const announce = useAnnounce();

  // Resolve the rule-system adapter FROM THE ACTIVE CAMPAIGN (issue #234) rather than at
  // module scope with no argument — so a future non-5e adapter's condition vocabulary and
  // statblock mapping actually take effect. Default (5e) is unchanged.
  const ruleSystem = campaign?.ruleSystem ?? null;
  const conditionSuggestions = useMemo(() => [...ruleSystemAdapter(ruleSystem).conditions], [ruleSystem]);

  const queryClient = useQueryClient();

  // AI-DM live-state relay (#344): the presence chip + activity toast read off the
  // single app-wide stream subscription mounted in app/Layout.tsx — this page does
  // NOT open its own /ai-dm/stream connection. The underlying tool/HP/turn data still
  // arrives via the existing encounter SSE channel + refetch above, unchanged; this
  // only adds the "why did this just change" signal for whoever's watching.
  const liveActivity = useAiDmLiveActivity();
  const [aiToasts, setAiToasts] = useState<Array<{ key: number; chip: ReturnType<typeof resolveToolActivity>; at: number }>>([]);
  const lastToastAtRef = useRef<number | null>(null);
  const toastSeq = useRef(0);
  useEffect(() => {
    const activity = liveActivity.encounterActivity;
    if (!activity || activity.at === lastToastAtRef.current) return;
    lastToastAtRef.current = activity.at;
    // Re-resolve with THIS encounter's id so the chip can deep-link back here — tool
    // events are id-only (#338), so the generic app-level resolution above couldn't
    // know it. `lastToolEvent` is set in the same reducer step as `encounterActivity`
    // whenever it was an encounter-resource event, so it's the same underlying event.
    const chip =
      liveActivity.lastToolEvent && Number.isFinite(eid)
        ? resolveToolActivity(liveActivity.lastToolEvent, { campaignId: cid, encounterId: eid })
        : activity.chip;
    const key = ++toastSeq.current;
    setAiToasts((prev) => [...prev, { key, chip, at: activity.at }].slice(-3));
    const timer = setTimeout(() => setAiToasts((prev) => prev.filter((t) => t.key !== key)), 8000);
    return () => clearTimeout(timer);
  }, [liveActivity.encounterActivity, liveActivity.lastToolEvent, cid, eid]);

  // Issue #430: structured so Refresh/dismiss/navigation can clear stale banners
  // without relying solely on the Retry path. Passive SSE/poll must not wipe it.
  const [actionError, setActionError] = useState<ActionErrorState>(null);
  // A damage/heal amount just rolled from a character card, awaiting a one-tap target
  // pick (issue: wire actions → dice → damage). Cleared on apply or dismiss.
  const [pendingApply, setPendingApply] = useState<{ amount: number; label: string } | null>(null);
  // Live battle-map pings (issue #238) — transient markers pushed over SSE, each auto-expires
  // after a short lifetime. A monotonic key disambiguates simultaneous pings at the same spot.
  const [pings, setPings] = useState<Array<{ key: number; x: number; y: number }>>([]);
  const pingSeq = useRef(0);
  const addPing = useCallback((ping: MapPing) => {
    const key = ++pingSeq.current;
    setPings((prev) => [...prev, { key, x: ping.x, y: ping.y }]);
    setTimeout(() => setPings((prev) => prev.filter((p) => p.key !== key)), 2600);
  }, []);
  // Per-combatant in-flight tracking (issue #73) — replaces the single global `busy`
  // flag so one combatant's slower edit (rename, condition, initiative…) disables only
  // that row, never the whole tracker. HP steppers bypass this entirely: they're
  // optimistic and stay live even while a request is in flight.
  const [pendingCombatantIds, setPendingCombatantIds] = useState<ReadonlySet<number>>(() => new Set());
  const markCombatantPending = useCallback((combatantId: number, on: boolean) => {
    setPendingCombatantIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(combatantId);
      else next.delete(combatantId);
      return next;
    });
  }, []);

  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemoveCombatantId, setConfirmRemoveCombatantId] = useState<number | null>(null);

  // Reads via TanStack Query (issue #73). Each is polled while the tab is visible
  // (refetchInterval pauses in the background by default) as a backstop to the SSE
  // push below; SSE remains the fast path (invalidate-on-event), the poll only catches
  // anything a dropped stream missed. The ~5s cadence matches the pre-SSE poll.
  const encounterQuery = useQuery({
    queryKey: queryKeys.encounter(eid),
    queryFn: () => api.get<EncounterWithCombatants>(`${API}/encounters/${eid}`),
    enabled: Number.isFinite(eid),
    refetchInterval: 5_000,
  });
  const encounter = encounterQuery.data ?? null;

  // Difficulty is a separate read-only derivation (issue #58) — never let its failure
  // block the encounter view; the badge just stays hidden (retry off, error ignored).
  const difficultyQuery = useQuery({
    queryKey: queryKeys.encounterDifficulty(eid),
    queryFn: () => api.get<EncounterDifficulty>(`${API}/encounters/${eid}/difficulty`),
    enabled: Number.isFinite(eid),
    refetchInterval: 5_000,
    retry: false,
  });
  const difficulty = difficultyQuery.data ?? null;

  // Persistent combat log (issue #61) — refreshes on every mutation / SSE update.
  const eventsQuery = useQuery({
    queryKey: queryKeys.encounterEvents(eid),
    queryFn: () => api.get<EncounterEvent[]>(`${API}/encounters/${eid}/events`),
    enabled: Number.isFinite(eid),
    refetchInterval: 5_000,
  });
  const events = eventsQuery.data ?? [];

  // Campaign characters — maps a combatant.characterId -> ownerUserId so a player is
  // scoped to only their own character's combatant, and feeds inline CharacterStatCards.
  // Issue #421: invalidate on character.updated SSE; poll is a dropped-stream backstop.
  const charactersQuery = useQuery({
    queryKey: queryKeys.campaignCharacters(cid),
    queryFn: () => api.get<Character[]>(`${API}/campaigns/${cid}/characters`),
    enabled: Number.isFinite(cid),
    refetchInterval: 10_000,
  });
  const characters = useMemo(() => charactersQuery.data ?? [], [charactersQuery.data]);
  const [eventStatus, setEventStatus] = useState<CampaignEventsStatus | null>(null);
  const sheetsInteractive = inlineCharacterSheetsInteractive(eventStatus);
  const sheetsStatusLabel = inlineCharacterSheetsStatusLabel(
    eventStatus,
    charactersQuery.isFetching && !charactersQuery.isLoading,
  );

  // Issue #431: tailor preparing next-steps to whether a monster pack is installed.
  const packsQuery = useQuery({
    queryKey: ['rules', 'packs'],
    queryFn: () => api.get<RulePack[]>(`${API}/rules/packs`),
    enabled: Number.isFinite(cid) && isDm,
    staleTime: 60_000,
  });
  const campaignHasCompendium = (packsQuery.data?.length ?? 0) > 0;

  const notFound = encounterQuery.error instanceof ApiError && encounterQuery.error.status === 404;
  const loadError =
    encounterQuery.error && !notFound
      ? encounterQuery.error instanceof ApiError
        ? encounterQuery.error.message
        : "Couldn't load this encounter."
      : null;
  const refetchEncounter = useCallback(() => invalidateEncounter(queryClient, eid), [queryClient, eid]);
  // Ordinary Refresh clears a stale action banner (#430) — distinct from passive
  // poll/SSE invalidation, which must leave an actionable failure visible.
  const refreshEncounter = useCallback(() => {
    setActionError(null);
    refetchEncounter();
  }, [refetchEncounter]);
  // Drop action errors when navigating to a different encounter.
  useEffect(() => {
    setActionError(null);
  }, [eid]);

  // Live updates over SSE (issue #4) — players waiting for the DM to hit "Start" (or
  // take a turn, adjust HP, …) see it pushed instantly. Rather than a manual reload, an
  // event just invalidates the encounter's reads and Query refetches. On a remote delete,
  // bounce back to the encounters list rather than surfacing a 404.
  // Issue #421: character.updated (and membership.revoked) have no encounterId — handle
  // them BEFORE the encounterId filter so inline sheet cards refresh on sheet edits.
  useCampaignEvents(Number.isFinite(cid) ? cid : undefined, {
    onEvent: useCallback(
      (event) => {
        // Sheet / membership frames have no encounterId — must not fall into the
        // encounterId filter below (that was the #421 bug: character events ignored).
        if (shouldInvalidateInlineCharacters(event)) {
          invalidateCampaignCharacters(queryClient, cid);
          return;
        }
        if (event.type !== 'encounter.updated' && event.type !== 'encounter.deleted' && event.type !== 'encounter.ping') return;
        if (event.encounterId !== eid) return;
        if (event.type === 'encounter.deleted') {
          navigate(`/c/${cid}/encounters`);
          return;
        }
        // A ping is a one-shot transient marker — render it, don't refetch the encounter.
        if (event.type === 'encounter.ping') {
          if (event.ping) addPing(event.ping);
          return;
        }
        invalidateEncounter(queryClient, eid);
      },
      [eid, cid, navigate, queryClient, addPing],
    ),
    // The stream was down for a while — refetch encounter + character sheets.
    onReconnect: useCallback(() => {
      invalidateEncounter(queryClient, eid);
      invalidateCampaignCharacters(queryClient, cid);
    }, [queryClient, eid, cid]),
    // Parser recovery (connection stayed up) — same catch-up refetch.
    onStreamRecovery: useCallback(() => {
      invalidateEncounter(queryClient, eid);
      invalidateCampaignCharacters(queryClient, cid);
    }, [queryClient, eid, cid]),
    onStatusChange: useCallback((status: CampaignEventsStatus) => setEventStatus(status), []),
  });

  // The persisted event stream is the single announcement source for turn, HP,
  // condition, death, note, override, and correction updates. ID-based tracking
  // suppresses duplicate SSE/mutation/poll refetches; initial history is a silent
  // baseline, while reconnect bursts are announced together so no entry is lost.
  const combatLogAnnouncementRef = useRef<{
    encounterId: number;
    cursor: CombatLogAnnouncementCursor;
  } | null>(null);
  useEffect(() => {
    if (!eventsQuery.data) return;

    const previous = combatLogAnnouncementRef.current;
    const cursor = previous?.encounterId === eid ? previous.cursor : null;
    const advanced = advanceCombatLogAnnouncements(eventsQuery.data, cursor);
    combatLogAnnouncementRef.current = { encounterId: eid, cursor: advanced.cursor };

    const message = formatCombatLogAnnouncementBatch(advanced.appendedEvents);
    if (message) {
      // ID-based cursor already skips known events; dedupeKey is a belt-and-braces
      // guard if the same append batch is announced twice after a reconnect race.
      // Compact: count + first/last id (not a joined list of every event id).
      const appended = advanced.appendedEvents;
      const firstId = appended[0]!.id;
      const lastId = appended[appended.length - 1]!.id;
      announce(message, {
        dedupeKey: `combat-log:${eid}:${appended.length}:${firstId}:${lastId}`,
      });
    }
  }, [eid, eventsQuery.data, announce]);

  // Ending an encounter does not currently append a combat-log row. Retain that
  // useful status announcement without restoring the old turn/HP diff path, which
  // would duplicate the persisted-event announcements above.
  const previousEncounterStatusRef = useRef<{ encounterId: number; status: EncounterWithCombatants['status'] } | null>(null);
  useEffect(() => {
    if (!encounter) return;
    const previous = previousEncounterStatusRef.current;
    if (previous?.encounterId === eid && previous.status !== encounter.status && encounter.status === 'ended') {
      announce('Encounter ended');
    }
    previousEncounterStatusRef.current = { encounterId: eid, status: encounter.status };
  }, [eid, encounter, announce]);

  const myUserId = me?.user.id;
  const ownedCharacterIds = useMemo(
    () =>
      new Set(
        characters.filter((c) => c.ownerUserId != null && myUserId != null && c.ownerUserId === String(myUserId)).map((c) => c.id),
      ),
    [characters, myUserId],
  );
  // Precomputed id→character map so the combatant list's per-row card lookup is O(1)
  // rather than a `.find` over all characters on every render (issue: large encounters).
  const charactersById = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);

  function canEditCombatant(c: Combatant): boolean {
    // An ended encounter is immutable server-side (assertMutable, #163): the interactive
    // card + ApplyDamageBar would only fire a PATCH the server always rejects. Gate on
    // status like canSetInitiative so an ended encounter renders read-only (#368).
    if (encounter?.status === 'ended') return false;
    if (isDm) return true;
    if (role !== 'player') return false;
    return c.characterId != null && ownedCharacterIds.has(c.characterId);
  }

  // A character card rolled damage — surface the one-tap "apply to target" bar. A
  // non-positive total (a 0/negative damage expr) has nothing to apply, so clear any
  // prior pending amount rather than leaving a stale bar from an earlier roll.
  const onApplyDamageRolled = useCallback((amount: number, label: string) => {
    setPendingApply(amount > 0 ? { amount, label } : null);
  }, []);

  const reportError = useCallback((err: unknown) => {
    setActionError(makeActionError(err instanceof ApiError ? err.message : 'That action failed.'));
  }, []);
  /** BattleMap / card rollers pass a plain string (or null to clear). */
  const surfaceActionError = useCallback((message: string | null) => {
    setActionError(message ? makeActionError(message) : null);
  }, []);

  // Encounter-level run controls (roll-initiative / start / next-turn / end / reopen).
  // These are mutually exclusive DM header actions, so one shared pending flag gating
  // just the header group is correct — unlike the old global lock, it never touches the
  // combatant rows. Each settles by invalidating the encounter's reads.
  const runControl = useMutation({
    mutationFn: (action: 'roll-initiative' | 'start' | 'next-turn' | 'end' | 'reopen') =>
      api.post(`${API}/encounters/${eid}/${action}`),
    onMutate: () => setActionError(null),
    onError: reportError,
    onSettled: () => invalidateEncounter(queryClient, eid),
  });

  const deleteEncounterMut = useMutation({
    mutationFn: () => api.delete(`${API}/encounters/${eid}`),
    onMutate: () => setActionError(null),
    onError: reportError,
    onSuccess: () => navigate(`/c/${cid}/encounters`),
  });

  // General per-combatant patch (conditions, death saves, initiative, rename, max/temp HP,
  // token position). Non-optimistic but per-combatant: onMutate flags just this row as
  // pending, onSettled clears it and reconciles. Concurrent edits to different combatants
  // don't block each other.
  const combatantPatch = useMutation({
    mutationFn: ({ combatantId, patch }: { combatantId: number; patch: Record<string, unknown> }) =>
      api.patch(`${API}/encounters/${eid}/combatants/${combatantId}`, patch),
    onMutate: ({ combatantId }) => {
      setActionError(null);
      markCombatantPending(combatantId, true);
    },
    onError: reportError,
    onSettled: (_data, _err, { combatantId }) => {
      markCombatantPending(combatantId, false);
      invalidateEncounter(queryClient, eid);
    },
  });

  // Optimistic HP steppers (issue #73) — the headline fix. onMutate writes the guessed HP
  // straight into the query cache so the click lands instantly (no round-trip wait, no
  // disabled control); onError rolls back to the pre-click snapshot; onSettled reconciles
  // against server truth, but only once the *last* of a rapid burst settles so spamming
  // ±1 doesn't trigger a refetch storm.
  const HP_MUTATION_KEY = useMemo(() => ['encounter', eid, 'hpDelta'] as const, [eid]);
  const hpDelta = useMutation({
    mutationKey: HP_MUTATION_KEY,
    mutationFn: ({ combatantId, delta }: { combatantId: number; delta: number }) =>
      api.patch(`${API}/encounters/${eid}/combatants/${combatantId}`, { hpDelta: delta }),
    onMutate: async ({ combatantId, delta }) => {
      setActionError(null);
      await queryClient.cancelQueries({ queryKey: queryKeys.encounter(eid) });
      const previous = queryClient.getQueryData<EncounterWithCombatants>(queryKeys.encounter(eid));
      if (previous) {
        queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(eid), {
          ...previous,
          combatants: previous.combatants.map((c) => (c.id === combatantId ? applyHpDelta(c, delta) : c)),
        });
      }
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKeys.encounter(eid), ctx.previous);
      reportError(err);
    },
    onSettled: () => {
      // Only reconcile after the last in-flight HP write of a burst settles.
      if (queryClient.isMutating({ mutationKey: HP_MUTATION_KEY }) === 1) {
        invalidateEncounter(queryClient, eid);
      }
    },
  });

  const patchCombatant = useCallback(
    (combatantId: number, patch: Record<string, unknown>) => combatantPatch.mutate({ combatantId, patch }),
    [combatantPatch],
  );

  /**
   * Roll a death save (issue #619): roll a d20 client-side, POST it to the campaign's
   * shared dice log so the whole table sees the roll, then PATCH the combatant with
   * `deathSaveRoll`. The SERVER is the source of truth for the outcome (nat 1 = two
   * failures, nat 20 = revive at 1 HP, 10–19 = one success, 2–9 = one failure) — its
   * response drives the pips + HP, and the combatantPatch invalidation re-renders this
   * row immediately. The dice-log post is fire-and-forget for table visibility; if it
   * fails we still apply the roll outcome (the combat-log event records provenance too).
   */
  const rollDeathSave = useCallback(
    (combatant: Combatant) => {
      const face = 1 + Math.floor(Math.random() * 20); // 1–20, uniform
      const label = `${combatant.name} · death save`;
      // Visible in the shared dice tray. A plain 1d20 expr so crit/fumble flavor lights up.
      void api.post(`${API}/campaigns/${cid}/roll`, { expr: '1d20', label }).catch(() => {
        /* table-visibility best-effort; outcome is driven by the combatant PATCH below */
      });
      patchCombatant(combatant.id, { deathSaveRoll: face });
    },
    [cid, patchCombatant],
  );

  const rollInitiative = () => runControl.mutate('roll-initiative');
  const startEncounter = () => runControl.mutate('start');
  const nextTurn = () => runControl.mutate('next-turn');
  // Close the confirm on success *or* failure so a rejected End (e.g. stale
  // preparing status) does not leave the modal parked over the error banner (#420).
  const endEncounter = () =>
    runControl.mutate('end', {
      onSuccess: () => setConfirmEnd(false),
      onError: () => setConfirmEnd(false),
    });
  const reopenEncounter = () =>
    runControl.mutate('reopen', {
      onSuccess: () => setConfirmReopen(false),
      onError: () => setConfirmReopen(false),
    });
  const deleteEncounter = () => deleteEncounterMut.mutate();

  // Issue #702: how many combatants still need an initiative roll. Used to keep the
  // Roll-initiative button honest — disabled (rather than a silent no-op server call)
  // once everyone has a value, and relabeled to "Roll remaining (N)" for a partial
  // roster (e.g. reinforcements landing at null initiative mid-fight).
  const needsInitiativeCount = encounter
    ? encounter.combatants.filter((c) => c.initiative === null || c.initiative === undefined).length
    : 0;

  // Issue #469: the server rejects Start on an empty roster (it would otherwise flip
  // to 'running' with nobody in the turn order). Mirror that here so the DM sees a
  // disabled control with an explanation instead of a round-trip 400.
  const hasNoCombatants = encounter ? encounter.combatants.length === 0 : true;

  // Issue #431: preparing banner tailored to auto-added party / enemies / map / packs.
  const preparingSetupGuidance = useMemo(() => {
    if (!encounter || encounter.status !== 'preparing') return null;
    return preparingGuidance({
      partyCombatantCount: encounter.combatants.filter((c) => c.kind === 'character').length,
      enemyCombatantCount: encounter.combatants.filter((c) => c.kind === 'monster' || c.kind === 'npc').length,
      hasMap: encounter.mapAttachmentId != null,
      campaignHasActiveParty: characters.some((c) => c.status === 'active'),
      campaignHasCompendium,
    });
  }, [encounter, characters, campaignHasCompendium]);

  // Issue #420: drop confirm dialogs that the current status no longer allows
  // (e.g. End left open after a peer/SSE transition out of running).
  const encounterStatus = encounter?.status;
  useEffect(() => {
    if (!encounterStatus) return;
    if (!isLifecycleConfirmValid('end', encounterStatus)) setConfirmEnd(false);
    if (!isLifecycleConfirmValid('reopen', encounterStatus)) setConfirmReopen(false);
    if (!isLifecycleConfirmValid('delete', encounterStatus)) setConfirmDelete(false);
  }, [encounterStatus]);

  const removeCombatant = (combatantId: number) => {
    setActionError(null);
    markCombatantPending(combatantId, true);
    api
      .delete(`${API}/encounters/${eid}/combatants/${combatantId}`)
      .then(() => {
        setConfirmRemoveCombatantId(null);
        invalidateEncounter(queryClient, eid);
      })
      .catch(reportError)
      .finally(() => markCombatantPending(combatantId, false));
  };

  // Battle map (issue #39): attach/clear the encounter's map image (DM only). Also the seam
  // for the VTT grid config + fog of war writes (issue #40) — all DM-only PATCHes to the
  // encounter; the SSE `encounter.updated` signal then propagates them to every other client.
  const pendingEncounterPatchKeys = useRef(new Set<string>());
  const gridDefaultAttempts = useRef(new Set<string>());
  const setMap = useMutation({
    mutationFn: ({ patch }: { patch: Record<string, unknown>; pendingKey: string; defaultAttemptKey?: string }) =>
      api.patch(`${API}/encounters/${eid}`, patch),
    onMutate: () => setActionError(null),
    onError: (error, variables) => {
      if (variables.defaultAttemptKey) gridDefaultAttempts.current.delete(variables.defaultAttemptKey);
      reportError(error);
    },
    onSettled: (_data, error, variables) => {
      pendingEncounterPatchKeys.current.delete(variables.pendingKey);
      // A failed default write keeps its optimistic intent until a poll/SSE refresh supplies
      // server truth. That fresh missing-field snapshot is what permits the next retry, rather
      // than mutation-render churn immediately creating an unbounded failure loop.
      if (!variables.defaultAttemptKey || !error) invalidateEncounter(queryClient, eid);
    },
  });
  const mutateMapRef = useRef(setMap.mutate);
  mutateMapRef.current = setMap.mutate;

  const queueEncounterPatch = useCallback(
    (patch: Record<string, unknown>, defaultAttemptKey?: string): boolean => {
      const pendingKey = `${eid}:${encounterPatchKey(patch)}`;
      if (pendingEncounterPatchKeys.current.has(pendingKey)) return false;
      pendingEncounterPatchKeys.current.add(pendingKey);
      if (defaultAttemptKey) gridDefaultAttempts.current.add(defaultAttemptKey);

      // Record the default intent before dispatch. Strict Mode's second effect pass, mutation
      // renders, and stale polling/SSE responses therefore all see committed-looking defaults;
      // the pending-key guard remains the final backstop if a stale response overwrites them.
      if (defaultAttemptKey) {
        queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(eid), (current) =>
          current ? { ...current, ...patch } : current,
        );
      }

      mutateMapRef.current({ patch, pendingKey, defaultAttemptKey });
      return true;
    },
    [eid, queryClient],
  );

  const setEncounterMap = useCallback(
    (attachmentId: number | null) => queueEncounterPatch({ mapAttachmentId: attachmentId }),
    [queueEncounterPatch],
  );
  // Grid config (issue #40, phase 2) — any subset of gridSize/gridScale/gridUnit/gridSnap.
  const setEncounterGrid = useCallback((patch: EncounterGridPatch) => queueEncounterPatch(patch), [queueEncounterPatch]);
  // Fog of war (issue #40, phase 3) — replace the whole fog state (null clears it).
  const setEncounterFog = useCallback((fog: FogState | null) => queueEncounterPatch({ fog }), [queueEncounterPatch]);
  // Shared AoE templates (issue #238) — replace the whole template list (DM only, server-enforced).
  const setEncounterAoe = useCallback((aoe: AoeTemplate[]) => queueEncounterPatch({ aoe }), [queueEncounterPatch]);

  // Issue #865: normalize placeholder grid defaults once per encounter + missing-field set.
  // This lives beside the mutation/cache boundary instead of inside BattleMap's render tree.
  useEffect(() => {
    if (!isDm || !encounter) return;
    const patch = missingGridDefaults(encounter);
    const encounterPrefix = `${encounter.id}:`;
    if (!patch) {
      for (const key of gridDefaultAttempts.current) {
        if (key.startsWith(encounterPrefix)) gridDefaultAttempts.current.delete(key);
      }
      return;
    }

    const attemptKey = gridDefaultAttemptKey(encounter.id, patch);
    if (gridDefaultAttempts.current.has(attemptKey)) return;
    queueEncounterPatch(patch, attemptKey);
  }, [encounter, isDm, queueEncounterPatch]);

  // Transient battle-map ping (issue #238). Fire-and-forget POST; the server broadcasts an
  // `encounter.ping` SSE signal that every client — including this one — renders and fades, so
  // there's no optimistic local echo to manage. Any writing member may ping (a live gesture).
  const pingMap = useMutation({
    mutationFn: (ping: MapPing) => api.post(`${API}/encounters/${eid}/ping`, ping),
    onError: reportError,
  });
  const sendPing = (x: number, y: number) => pingMap.mutate({ x, y, color: null, label: null });

  // Move a combatant's token on the battle map. The server clamps to 0–100 and gates on
  // role (DM moves any; a player only their own character's token).
  const moveToken = (combatantId: number, x: number, y: number) => patchCombatant(combatantId, { tokenX: x, tokenY: y });
  // Unplace a token (issue #271): clear its position back to null so it returns to the
  // "Unplaced" tray WITHOUT deleting the combatant (its HP/conditions/initiative survive).
  // An explicit null is required — `undefined` would be a no-op patch server-side.
  const unplaceToken = (combatantId: number) => patchCombatant(combatantId, { tokenX: null, tokenY: null });
  // Token size category (issue #40, phase 2) — DM-only, server-enforced.
  const setTokenSize = (combatantId: number, size: TokenSize) => patchCombatant(combatantId, { tokenSize: size });

  // Header run-control group shares one pending flag (see runControl above).
  const headerBusy = runControl.isPending || deleteEncounterMut.isPending;

  if (!Number.isFinite(cid) || !Number.isFinite(eid)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message="Encounter not found." />
      </div>
    );
  }

  if (encounterQuery.isPending && !encounter) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5 space-y-4">
        <Card>
          <Skeleton lines={5} />
        </Card>
      </div>
    );
  }

  if (notFound && !encounter) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <NotFoundState title="Encounter not found" backTo={`/c/${cid}/encounters`} backLabel="← Back to encounters" />
      </div>
    );
  }

  if (loadError && !encounter) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={loadError} onRetry={refetchEncounter} />
      </div>
    );
  }

  if (!encounter) return null;

  // The server returns combatants already in initiative order and names the current
  // actor by id (issue #49) — no client-side re-sort, and no positional
  // `turnIndex % length` guesswork that desyncs the moment a combatant is added or
  // removed mid-fight.
  const orderedCombatants = encounter.combatants;
  const currentCombatantId = encounter.status === 'running' ? (encounter.currentCombatantId ?? undefined) : undefined;
  // Issue #420: DM header actions come from an explicit lifecycle matrix (not
  // ad-hoc status !== 'ended' checks) so Preparing never offers the invalid End.
  const lifecycle = dmLifecycleActions(encounter.status);
  const deleteCopy = deleteConfirmCopy(encounter.status);

  return (
    <div className="reading-surface max-w-4xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10" {...entityTargetProps('encounter', encounter.id)}>
      <div>
        <Btn
          ghost
          className="!min-h-0 !py-1.5 text-xs"
          onClick={() => {
            setActionError(null);
            navigate(`/c/${cid}/encounters`);
          }}
        >
          ← Back
        </Btn>
      </div>

      {(loadError || actionError) && (
        <ErrorNote
          message={actionError?.message ?? loadError ?? ''}
          context={
            actionError
              ? `at ${new Date(actionError.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
              : undefined
          }
          onRetry={() => {
            setActionError(null);
            refetchEncounter();
          }}
          onDismiss={actionError ? () => setActionError(null) : undefined}
        />
      )}

      <div className="flex items-center gap-2.5 flex-wrap">
        <h1 className="text-2xl font-extrabold text-white m-0 min-w-0 break-words">{encounter.name}</h1>
        <span className={STATUS_TAG_CLASS[encounter.status]}>
          {STATUS_LABEL[encounter.status]}
        </span>
        {encounter.status === 'running' && (
          <span className="tag tag-neutral">
            Round {encounter.round}
          </span>
        )}
        <DifficultyBadge difficulty={difficulty} />
        {/* AI-DM presence chip (#344) — the seat is in Driver mode, so it may act on
            this encounter from the Table page without anyone here having it open. */}
        {liveActivity.mode === 'driver' && <AiDmPresenceTag turnActive={liveActivity.turnActive} />}
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 11.5 }}
          onClick={refreshEncounter}
          title="Refresh"
        >
          ↻ Refresh
        </button>
        <div className="flex-1" />
        {isDm && (
          <div className="flex gap-2 flex-wrap">
            {/* Cast the secret-free player display to the table (issue #60). */}
            <Btn
              ghost
              className="!min-h-0 !py-1.5 text-xs"
              onClick={() => navigate(`/c/${cid}/screen`)}
              title="Open the player display — initiative + revealed info, no secrets"
            >
              <GameIcon slug="tv" size={13} className="inline align-text-bottom mr-1" />Cast
            </Btn>
            {lifecycle.rollInitiative && lifecycle.start && (
              <>
                {/* Issue #702: the server treats a fully-rolled roster as a no-op (no
                    write, no audit), so the button must reflect that — disabled when
                    nobody needs initiative, and labeled "Roll remaining (N)" when the
                    roster is partial (e.g. a manually-set combatant alongside unrolled
                    ones). Hidden entirely rather than dead weight once Start is live. */}
                <Btn
                  ghost
                  disabled={headerBusy || needsInitiativeCount === 0}
                  onClick={rollInitiative}
                  title={needsInitiativeCount === 0 ? 'All combatants already have initiative' : undefined}
                >
                  {needsInitiativeCount > 0 ? `Roll remaining (${needsInitiativeCount})` : 'Roll initiative'}
                </Btn>
                <div className="flex flex-col gap-0.5 items-stretch">
                  <Btn
                    disabled={headerBusy || hasNoCombatants}
                    onClick={startEncounter}
                    aria-describedby={hasNoCombatants ? 'start-empty-roster-hint' : undefined}
                  >
                    Start
                  </Btn>
                  {hasNoCombatants && (
                    <p id="start-empty-roster-hint" className="text-muted text-xs m-0 max-w-[14rem]">
                      Add at least one combatant before starting
                    </p>
                  )}
                </div>
              </>
            )}
            {lifecycle.rollInitiative && lifecycle.nextTurn && (
              <>
                {/* Reinforcements added mid-fight land at null initiative and sort last —
                    keep Roll initiative reachable so the DM can fill them (issue #54).
                    Already-set initiatives are left untouched server-side. Once every
                    combatant has a value, disable the control rather than firing a no-op
                    roll (issue #702), and surface how many still need rolling. */}
                <Btn
                  ghost
                  disabled={headerBusy || needsInitiativeCount === 0}
                  onClick={rollInitiative}
                  title={needsInitiativeCount === 0 ? 'All combatants already have initiative' : undefined}
                >
                  {needsInitiativeCount > 0 ? `Roll remaining (${needsInitiativeCount})` : 'Roll initiative'}
                </Btn>
                <Btn disabled={headerBusy} onClick={nextTurn}>
                  Next turn →
                </Btn>
              </>
            )}
            {lifecycle.end && (
              <Btn ghost danger disabled={headerBusy} onClick={() => setConfirmEnd(true)}>
                End
              </Btn>
            )}
            {lifecycle.reopen && (
              <Btn ghost disabled={headerBusy} onClick={() => setConfirmReopen(true)}>
                Reopen
              </Btn>
            )}
            {lifecycle.delete && (
              <Btn ghost danger disabled={headerBusy} onClick={() => setConfirmDelete(true)}>
                {encounter.status === 'preparing' ? 'Cancel' : 'Delete'}
              </Btn>
            )}
          </div>
        )}
      </div>

      {/* Transient "the AI just acted on this encounter" row(s) (#344 point 2) — sourced
          from `tool` stream events filtered to the encounter resource; the combatant/HP/
          turn data itself already arrived via the encounter SSE refetch above. */}
      {aiToasts.length > 0 && (
        <div className="flex flex-col gap-1" style={{ paddingLeft: 2 }}>
          {aiToasts.map((toast) => (
            <AiDmToolActivityRow key={toast.key} chip={toast.chip} at={toast.at} />
          ))}
        </div>
      )}

      {encounter.status === 'ended' && <EndedSummary encounter={encounter} />}
      {isDm && encounter.status === 'ended' && (
        <EncounterNextSteps campaignId={cid} sessionId={encounter.sessionId} />
      )}

      <EncounterLinks
        campaignId={cid}
        encounter={encounter}
        canEdit={isDm}
        onSaved={(updated) =>
          queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(eid), (prev) =>
            prev ? { ...prev, ...updated } : prev,
          )
        }
      />

      {isDm && preparingSetupGuidance && (
        <div
          data-testid="encounter-preparing-guidance"
          className="text-muted"
          style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          <p style={{ margin: 0 }}>{preparingSetupGuidance.lead}</p>
          <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {preparingSetupGuidance.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <ol
            aria-label="Encounter lifecycle"
            data-testid="encounter-lifecycle-checklist"
            style={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
            }}
          >
            {ENCOUNTER_LIFECYCLE_STEPS.map((step, i) => (
              <li key={step.id} className="tag tag-neutral" style={{ fontSize: 10 }} title={step.detail}>
                {i + 1}. {step.label}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Optional battle map (issue #39) — a DM-uploaded image with draggable combatant
          tokens. Shown to the DM always (so they can attach one), and to players only once
          a map exists. Encounters without a map are unchanged. */}
      {(isDm || encounter.mapAttachmentId != null) && (
        <BattleMap
          encounter={encounter}
          campaignId={cid}
          isDm={isDm}
          busy={setMap.isPending}
          canMoveToken={canEditCombatant}
          onSetMap={setEncounterMap}
          onMoveToken={moveToken}
          onUnplaceToken={unplaceToken}
          onSetGrid={setEncounterGrid}
          onSetFog={setEncounterFog}
          onSetAoe={setEncounterAoe}
          onPing={sendPing}
          pings={pings}
          onError={surfaceActionError}
        />
      )}

      {pendingApply && (
        <ApplyDamageBar
          amount={pendingApply.amount}
          label={pendingApply.label}
          targets={orderedCombatants.filter((c) => canEditCombatant(c) && c.hpCurrent != null)}
          onApply={(combatantId, delta) => {
            hpDelta.mutate({ combatantId, delta });
            setPendingApply(null);
          }}
          onDismiss={() => setPendingApply(null)}
        />
      )}

      <div className="card elev-sm" style={{ padding: '6px 0', gap: 0 }}>
        {sheetsStatusLabel && (
          <p
            className="text-muted"
            data-testid="inline-character-sheets-status"
            style={{ fontSize: 11, margin: 0, padding: '8px 14px 0' }}
            role="status"
            aria-live="polite"
          >
            {sheetsStatusLabel}
          </p>
        )}
        {orderedCombatants.length === 0 ? (
          <div style={{ padding: 16 }}>
            <EmptyState
              icon="crossed-swords"
              title="No combatants yet"
              hint={
                isDm
                  ? characters.some((c) => c.status === 'active')
                    ? 'Add the party from the Party tab, then enemies.'
                    : 'Add combatants below — this campaign has no active party to auto-add.'
                  : 'Waiting on the DM.'
              }
            />
          </div>
        ) : (
          orderedCombatants.map((c) => (
            <CombatantRow
              key={c.id}
              combatant={c}
              isCurrentTurn={c.id === currentCombatantId}
              canEdit={canEditCombatant(c)}
              canEditIdentity={isDm && encounter.status !== 'ended'}
              canViewStatblock={isDm}
              canRemove={isDm}
              canSetInitiative={isDm && encounter.status !== 'ended'}
              running={encounter.status === 'running'}
              character={c.characterId != null ? charactersById.get(c.characterId) ?? null : null}
              openCardByDefault={c.characterId != null && ownedCharacterIds.has(c.characterId)}
              // Omit campaignId while sheets are stale so click-to-roll cannot use obsolete mods (#421).
              campaignId={sheetsInteractive ? cid : undefined}
              onRollError={surfaceActionError}
              onApplyDamage={onApplyDamageRolled}
              busy={pendingCombatantIds.has(c.id)}
              conditionSuggestions={conditionSuggestions}
              ruleSystem={ruleSystem}
              onHpDelta={(delta) => hpDelta.mutate({ combatantId: c.id, delta })}
              onSetTempHp={(value) => patchCombatant(c.id, { hpTemp: value })}
              onSetDeathSaves={(patch) => patchCombatant(c.id, patch)}
              onRollDeathSave={() => rollDeathSave(c)}
              onSetInitiative={(value) => patchCombatant(c.id, { initiative: value })}
              onClearInitiative={() => patchCombatant(c.id, { initiative: null })}
              onAddCondition={(cond) => patchCombatant(c.id, { addConditions: [cond] })}
              onRemoveCondition={(cond) => patchCombatant(c.id, { removeConditions: [cond] })}
              onRename={(name) => patchCombatant(c.id, { name })}
              onSetHpMax={(value) => patchCombatant(c.id, { hpMax: value })}
              onSetTokenSize={(size) => setTokenSize(c.id, size)}
              onRemove={() => setConfirmRemoveCombatantId(c.id)}
            />
          ))
        )}
      </div>

      {isDm && encounter.status !== 'ended' && (
        <AddCombatantPanel
          encounterId={eid}
          campaignId={cid}
          characters={characters}
          existingCombatantCharacterIds={new Set(encounter.combatants.map((c) => c.characterId).filter((id): id is number => id != null))}
          rulePack={campaign?.ruleSystem || ''}
          onAdded={() => queryClient.invalidateQueries({ queryKey: queryKeys.encounter(eid) })}
        />
      )}

      <CombatLog events={events} />

      <SharedDiceLog campaignId={cid} />

      {confirmEnd && (
        <ConfirmDialog
          title="End this encounter?"
          body="Ends the fight and writes each character combatant's HP, temp HP, and death state back to their sheets. You can Reopen later to resume where combat left off. If sheets change after this End, ending again after a Reopen can overwrite those intervening changes."
          confirmLabel={runControl.isPending ? 'Ending…' : 'End encounter'}
          busy={runControl.isPending}
          onConfirm={endEncounter}
          onCancel={() => setConfirmEnd(false)}
        />
      )}
      {confirmReopen && (
        <ConfirmDialog
          title="Reopen this encounter?"
          body="It returns to Running where combat left off. HP was written back to character sheets when it ended. Healing, rest, or other sheet HP changes you make before the next End will be silently overwritten — that End writes combatant HP back onto the sheets again (resync direction tracked in #466)."
          confirmLabel={runControl.isPending ? 'Reopening…' : 'Reopen encounter'}
          busy={runControl.isPending}
          onConfirm={reopenEncounter}
          onCancel={() => setConfirmReopen(false)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={deleteCopy.title}
          body={deleteCopy.body}
          confirmLabel={
            deleteEncounterMut.isPending
              ? encounter.status === 'preparing'
                ? 'Canceling…'
                : 'Deleting…'
              : encounter.status === 'preparing'
                ? 'Cancel preparation'
                : 'Delete encounter'
          }
          busy={deleteEncounterMut.isPending}
          onConfirm={deleteEncounter}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {confirmRemoveCombatantId != null && (
        <ConfirmDialog
          title="Remove this combatant from the encounter?"
          confirmLabel={pendingCombatantIds.has(confirmRemoveCombatantId) ? 'Removing…' : 'Remove'}
          busy={pendingCombatantIds.has(confirmRemoveCombatantId)}
          onConfirm={() => removeCombatant(confirmRemoveCombatantId)}
          onCancel={() => setConfirmRemoveCombatantId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

// `tokenInitials` is the shared grapheme-aware helper (issue #631): two-letter
// token labels from a combatant name ("Ashen cultist" -> "AC", "Goblin 1" -> "G1").

// Token footprint multipliers (issue #40, phase 2) — a Medium creature is 1×1; a token's
// rendered diameter scales by these against a 32px base (min ~18px so tiny stays tappable).
const TOKEN_SIZE_SCALE: Record<TokenSize, number> = {
  tiny: 0.6,
  small: 0.8,
  medium: 1,
  large: 1.6,
  huge: 2.2,
  gargantuan: 3,
};
const TOKEN_SIZE_OPTIONS: TokenSize[] = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'];
const BASE_TOKEN_PX = 32;

/** Measure an element's rendered pixel box, tracking resizes — used for square grid cells + the ruler. */
function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Normalize two drag corners (percent) into a positive-size {x,y,w,h} rectangle. */
function rectFromCorners(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number; w: number; h: number } {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

type MapTool = 'move' | 'measure' | 'reveal' | 'ping';

// AoE token-footprint scale is defined near the tokens; AoE template geometry lives here.
const BASE_AOE_LENGTH_MULT = 3; // default cone/line length = 3 cells; circle radius = 2 cells.

/** Stable-ish short id for a new AoE template (crypto.randomUUID when available). */
function newAoeId(): string {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return uuid.slice(0, 40);
}

/**
 * Pointy-top hexagon centres + vertices tiling the surface (issue #238). Returned as SVG
 * `points` strings in pixel space so the overlay can draw them directly. `cellPx` is treated as
 * the hex width; a cap keeps a pathologically fine grid from emitting tens of thousands of nodes.
 */
function hexPolygons(surfaceW: number, surfaceH: number, cellPx: number): string[] {
  if (cellPx <= 2 || surfaceW <= 0 || surfaceH <= 0) return [];
  const w = cellPx;
  const s = w / Math.sqrt(3); // hex side / circumradius for a pointy-top hex of width w
  const rowH = 1.5 * s;
  const cols = Math.ceil(surfaceW / w) + 1;
  const rows = Math.ceil(surfaceH / rowH) + 1;
  if (cols * rows > 3000) return []; // too fine to draw as discrete polygons — skip the overlay
  const out: string[] = [];
  for (let r = 0; r <= rows; r++) {
    const offset = r % 2 ? w / 2 : 0;
    for (let c = 0; c <= cols; c++) {
      const cx = c * w + offset;
      const cy = r * rowH;
      out.push(
        [
          [cx, cy - s],
          [cx + w / 2, cy - s / 2],
          [cx + w / 2, cy + s / 2],
          [cx, cy + s],
          [cx - w / 2, cy + s / 2],
          [cx - w / 2, cy - s / 2],
        ]
          .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`)
          .join(' '),
      );
    }
  }
  return out;
}

/**
 * Pixel-space SVG `points` for one AoE template (issue #238). Circle callers use radius instead;
 * this builds the cone (5e quadrant-style triangle, far edge ≈ length) and line (a rectangle of
 * one grid-cell width) polygons. `ox/oy` is the origin in px, `lengthPx` the reach, `angleRad`
 * the aim, `widthPx` the line thickness.
 */
function aoePolygonPoints(
  shape: AoeShape,
  ox: number,
  oy: number,
  lengthPx: number,
  angleRad: number,
  widthPx: number,
): string {
  const dx = Math.cos(angleRad);
  const dy = Math.sin(angleRad);
  const px = -dy; // unit perpendicular
  const py = dx;
  if (shape === 'cone') {
    const fx = ox + dx * lengthPx;
    const fy = oy + dy * lengthPx;
    const half = lengthPx / 2;
    const a = [fx + px * half, fy + py * half];
    const b = [fx - px * half, fy - py * half];
    return `${ox.toFixed(1)},${oy.toFixed(1)} ${a[0].toFixed(1)},${a[1].toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`;
  }
  // line: a rectangle of width widthPx running from the origin along the aim
  const half = widthPx / 2;
  const fx = ox + dx * lengthPx;
  const fy = oy + dy * lengthPx;
  const p1 = [ox + px * half, oy + py * half];
  const p2 = [fx + px * half, fy + py * half];
  const p3 = [fx - px * half, fy - py * half];
  const p4 = [ox - px * half, oy - py * half];
  return [p1, p2, p3, p4].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

/**
 * Battle map (issue #39 + VTT phases 2–3, issue #40): a DM-uploaded image rendered as the
 * encounter background with combatant tokens overlaid at combatant.tokenX/tokenY (0–100
 * percent). On top of the #39 token drag it adds:
 *  - a configurable square grid overlay (DM sets cell size / scale / unit / snap),
 *  - a click-drag measurement ruler that reads out distance in squares + feet,
 *  - per-token size footprints (tiny→gargantuan) via combatant.tokenSize,
 *  - a square OR hex grid overlay (issue #238, gridType),
 *  - fog of war: the DM reveals rectangular regions; players see only revealed area, and
 *    the server additionally withholds token positions in the dark (redaction-safe),
 *  - shared circle/cone/line AoE templates (issue #238) persisted on the encounter so every
 *    client sees the same shapes (the old circle was client-local),
 *  - transient click-to-ping markers broadcast to the whole table over SSE (issue #238).
 * Grid config, fog, and AoE are DM-only PATCHes to the encounter; every change rides the existing
 * SSE `encounter.updated` signal so other clients update live (the poll is the backstop). Pings
 * ride a dedicated one-shot `encounter.ping` signal. DM may move any token; a player only their
 * own character's (canMoveToken), but any member may ping.
 */
function BattleMap({
  encounter,
  campaignId,
  isDm,
  busy,
  canMoveToken,
  onSetMap,
  onMoveToken,
  onUnplaceToken,
  onSetGrid,
  onSetFog,
  onSetAoe,
  onPing,
  pings,
  onError,
}: {
  encounter: EncounterWithCombatants;
  campaignId: number;
  isDm: boolean;
  busy: boolean;
  canMoveToken: (c: Combatant) => boolean;
  onSetMap: (attachmentId: number | null) => void;
  onMoveToken: (combatantId: number, x: number, y: number) => void;
  onUnplaceToken: (combatantId: number) => void;
  onSetGrid: (patch: EncounterGridPatch) => void;
  onSetFog: (fog: FogState | null) => void;
  onSetAoe: (aoe: AoeTemplate[]) => void;
  onPing: (x: number, y: number) => void;
  pings: ReadonlyArray<{ key: number; x: number; y: number }>;
  onError: (message: string) => void;
}) {
  type MapPoint = { x: number; y: number };
  type ActiveMapGesture =
    | { kind: 'token'; pointerId: number; captureTarget: Element; tokenId: number; point: MapPoint | null }
    | { kind: 'aoe'; pointerId: number; captureTarget: Element; templateId: string; point: MapPoint }
    | { kind: 'fog'; pointerId: number; captureTarget: Element; start: MapPoint; end: MapPoint }
    | { kind: 'measure'; pointerId: number; captureTarget: Element; start: MapPoint; end: MapPoint };

  const [uploading, setUploading] = useState(false);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<MapTool>('move');
  const [ruler, setRuler] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  const [revealCorners, setRevealCorners] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  const [gridPanelOpen, setGridPanelOpen] = useState(false);
  // Shared AoE templates (issue #238) live in encounter state; `selectedAoeId` is the DM's local
  // editing selection and `aoeDrag` a live drag override (committed to the encounter on release).
  const [selectedAoeId, setSelectedAoeId] = useState<string | null>(null);
  const [aoeDrag, setAoeDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  // Natural pixel size of the loaded map image, used to compute its letterboxed
  // (object-contain) rendered rect so the grid overlay can be clipped to it (issue #273b).
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const activeGestureRef = useRef<ActiveMapGesture | null>(null);
  // A successful pointerup normally causes lostpointercapture immediately afterwards. Keep the
  // released id long enough to identify that expected notification; any earlier capture loss is
  // an interruption and must roll the gesture back without persisting it.
  const successfulPointerUpRef = useRef<number | null>(null);
  const { w: surfaceW, h: surfaceH } = useElementSize(surfaceRef);

  const clearGesturePreview = useCallback((kind: ActiveMapGesture['kind']) => {
    if (kind === 'token') {
      setDraggingId(null);
      setDragPos(null);
    } else if (kind === 'aoe') {
      setAoeDrag(null);
    } else if (kind === 'fog') {
      setRevealCorners(null);
    } else {
      setRuler(null);
    }
  }, []);

  const cancelActiveGesture = useCallback(
    (pointerId?: number, clearPreview = true) => {
      const gesture = activeGestureRef.current;
      if (!gesture || (pointerId != null && gesture.pointerId !== pointerId)) return;

      // Clear ownership before releasing capture because releasePointerCapture may synchronously
      // dispatch lostpointercapture. That follow-up must observe an already-cancelled gesture.
      activeGestureRef.current = null;
      successfulPointerUpRef.current = null;
      if (clearPreview) clearGesturePreview(gesture.kind);
      try {
        if (gesture.captureTarget.hasPointerCapture?.(gesture.pointerId)) {
          gesture.captureTarget.releasePointerCapture?.(gesture.pointerId);
        }
      } catch {
        // The browser may already have dropped capture while backgrounding or unmounting.
      }
    },
    [clearGesturePreview],
  );

  useEffect(() => {
    const cancelWhenHidden = () => {
      if (document.visibilityState === 'hidden') cancelActiveGesture();
    };
    const cancelForPageExit = () => cancelActiveGesture();
    const cancelForRotation = () => cancelActiveGesture();
    const orientation = globalThis.screen?.orientation;

    document.addEventListener('visibilitychange', cancelWhenHidden);
    window.addEventListener('pagehide', cancelForPageExit);
    window.addEventListener('orientationchange', cancelForRotation);
    orientation?.addEventListener?.('change', cancelForRotation);
    return () => {
      document.removeEventListener('visibilitychange', cancelWhenHidden);
      window.removeEventListener('pagehide', cancelForPageExit);
      window.removeEventListener('orientationchange', cancelForRotation);
      orientation?.removeEventListener?.('change', cancelForRotation);
      // Component teardown already removes every preview from the DOM. Drop ownership and capture
      // without scheduling state updates; in particular, never turn unmount into a commit.
      cancelActiveGesture(undefined, false);
    };
  }, [cancelActiveGesture]);

  const mapImageUrl = encounter.mapAttachmentId != null ? attachmentFileUrl(encounter.mapAttachmentId) : null;
  const placed = encounter.combatants.filter((c) => c.tokenX != null && c.tokenY != null);
  const unplaced = encounter.combatants.filter((c) => c.tokenX == null || c.tokenY == null);

  const gridSize = encounter.gridSize; // cell edge as % of width; null = no grid
  const gridScale = encounter.gridScale;
  const gridUnit = encounter.gridUnit || 'ft';
  const gridType: GridType = encounter.gridType ?? 'square';
  const gridOn = gridSize != null && gridSize > 0;
  // One cell in rendered pixels — cells are square in pixels regardless of the 16:9 surface.
  const cellPx = gridOn && surfaceW > 0 ? (gridSize! / 100) * surfaceW : 0;
  // Distance readout needs both a cell size (px) and a real-world scale.
  const canMeasure = gridOn && gridScale != null && gridScale > 0 && cellPx > 0;
  const canAoe = canMeasure; // AoE sizes are expressed in feet, so they need the scale too.

  // A new map starts with unknown natural size until its <img> fires onLoad.
  useEffect(() => {
    setImgNatural(null);
  }, [mapImageUrl]);

  // Rendered rect of the map image inside the 16:9 surface. `object-contain` letterboxes a
  // non-16:9 image, leaving dark bands the grid must not draw over (issue #273b). Until the
  // natural size is known we fall back to the full surface (no clipping regression).
  const mapRect = useMemo(() => {
    if (surfaceW <= 0 || surfaceH <= 0) return null;
    if (!imgNatural || imgNatural.w <= 0 || imgNatural.h <= 0) {
      return { left: 0, top: 0, width: surfaceW, height: surfaceH };
    }
    const scale = Math.min(surfaceW / imgNatural.w, surfaceH / imgNatural.h);
    const width = imgNatural.w * scale;
    const height = imgNatural.h * scale;
    return { left: (surfaceW - width) / 2, top: (surfaceH - height) / 2, width, height };
  }, [surfaceW, surfaceH, imgNatural]);

  const aoeTemplates = encounter.aoe ?? [];
  const fog = encounter.fog;
  const fogOn = !!fog?.enabled;
  // A non-DM whose token would be hidden by fog simply never receives its position from the
  // server (it lands in `unplaced`), so the client never has to trust itself to hide it.

  const clampPct = (v: number) => Math.max(0, Math.min(100, v));

  async function uploadMapFile(file: File) {
    setUploading(true);
    try {
      const attachment: Attachment = await uploadAttachment(campaignId, 'map', file);
      onSetMap(attachment.id);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't upload the map.");
    } finally {
      setUploading(false);
    }
  }

  function pointerToPercent(e: ReactPointerEvent): MapPoint | null {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    return { x: clampPct(x), y: clampPct(y) };
  }

  /** Snap a drop point to the nearest cell centre when the grid + snap are on (issue #40). */
  function snapPoint(pt: MapPoint): MapPoint {
    if (!gridOn || !encounter.gridSnap || cellPx <= 0 || surfaceW === 0 || surfaceH === 0) return pt;
    const px = (pt.x / 100) * surfaceW;
    const py = (pt.y / 100) * surfaceH;
    const sx = (Math.floor(px / cellPx) + 0.5) * cellPx;
    const sy = (Math.floor(py / cellPx) + 0.5) * cellPx;
    return { x: clampPct((sx / surfaceW) * 100), y: clampPct((sy / surfaceH) * 100) };
  }

  function onTokenPointerDown(e: ReactPointerEvent<HTMLDivElement>, c: Combatant) {
    if (!e.isPrimary || activeGestureRef.current || tool !== 'move' || !mapImageUrl || !canMoveToken(c)) return;
    e.preventDefault();
    e.stopPropagation();
    const point = pointerToPercent(e);
    const captureTarget = e.currentTarget;
    captureTarget.setPointerCapture?.(e.pointerId);
    successfulPointerUpRef.current = null;
    activeGestureRef.current = { kind: 'token', pointerId: e.pointerId, captureTarget, tokenId: c.id, point };
    setDraggingId(c.id);
    setDragPos(point);
  }

  function onSurfacePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!e.isPrimary || activeGestureRef.current) return;
    const pct = pointerToPercent(e);
    if (!pct) return;
    if (tool === 'ping') {
      // A ping is a one-shot gesture — broadcast immediately on press, no drag.
      onPing(pct.x, pct.y);
      return;
    }
    if (tool === 'measure' && canMeasure) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      successfulPointerUpRef.current = null;
      activeGestureRef.current = { kind: 'measure', pointerId: e.pointerId, captureTarget: e.currentTarget, start: pct, end: pct };
      setRuler({ start: pct, end: pct });
    } else if (tool === 'reveal' && isDm) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      successfulPointerUpRef.current = null;
      activeGestureRef.current = { kind: 'fog', pointerId: e.pointerId, captureTarget: e.currentTarget, start: pct, end: pct };
      setRevealCorners({ start: pct, end: pct });
    } else if (tool === 'move') {
      // Click on empty map in move mode clears any AoE selection (deselect).
      setSelectedAoeId(null);
    }
  }

  function onSurfacePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const gesture = activeGestureRef.current;
    if (!e.isPrimary || !gesture || gesture.pointerId !== e.pointerId) return;
    const pct = pointerToPercent(e);
    if (!pct) return;

    if (gesture.kind === 'token') {
      gesture.point = pct;
      setDragPos(pct);
    } else if (gesture.kind === 'aoe') {
      gesture.point = pct;
      setAoeDrag({ id: gesture.templateId, ...pct });
    } else {
      gesture.end = pct;
      if (gesture.kind === 'measure') setRuler({ start: gesture.start, end: pct });
      else setRevealCorners({ start: gesture.start, end: pct });
    }
  }

  // Only the owning primary pointer's normal release may commit. Ownership is cleared before the
  // mutation callback, making duplicate pointerup/lostcapture delivery exactly-once by design.
  function onSurfacePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const gesture = activeGestureRef.current;
    if (!e.isPrimary || !gesture || gesture.pointerId !== e.pointerId) return;
    const finalPoint = pointerToPercent(e);
    successfulPointerUpRef.current = e.pointerId;
    activeGestureRef.current = null;
    // Pointer capture is normally released implicitly after pointerup, but doing it explicitly
    // makes the lifecycle deterministic across mouse, pen, and touch implementations. Ownership
    // is already cleared, so a synchronous lostpointercapture can only acknowledge this success.
    try {
      if (gesture.captureTarget.hasPointerCapture?.(gesture.pointerId)) {
        gesture.captureTarget.releasePointerCapture?.(gesture.pointerId);
      }
    } catch {
      // The browser may already have released capture as part of pointerup dispatch.
    }
    // Completed measurements intentionally remain visible for reading. The three persistent
    // gesture classes clear their transient overrides before invoking their mutation callbacks.
    if (gesture.kind !== 'measure') clearGesturePreview(gesture.kind);

    if (gesture.kind === 'token') {
      const raw = finalPoint ?? gesture.point;
      if (raw) {
        const pt = snapPoint(raw);
        onMoveToken(gesture.tokenId, pt.x, pt.y);
      }
      return;
    }
    if (gesture.kind === 'aoe') {
      const point = finalPoint ?? gesture.point;
      onSetAoe(aoeTemplates.map((t) => (t.id === gesture.templateId ? { ...t, x: point.x, y: point.y } : t)));
      return;
    }
    if (gesture.kind === 'fog') {
      const rect = rectFromCorners(gesture.start, finalPoint ?? gesture.end);
      // Ignore an accidental micro-drag (a click) — a real reveal has some area.
      if (rect.w >= 1 && rect.h >= 1) {
        const next: FogState = { enabled: true, revealed: [...(fog?.revealed ?? []), rect].slice(-500) };
        onSetFog(next);
      }
      return;
    }
    // A ruler stays on screen after release so the readout can be read; it clears when the
    // next measurement starts, the tool changes, or move mode is re-entered.
    setRuler({ start: gesture.start, end: finalPoint ?? gesture.end });
  }

  function onSurfacePointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    cancelActiveGesture(e.pointerId);
  }

  function onSurfaceLostPointerCapture(e: ReactPointerEvent<HTMLDivElement>) {
    if (successfulPointerUpRef.current === e.pointerId) {
      successfulPointerUpRef.current = null;
      return;
    }
    cancelActiveGesture(e.pointerId);
  }

  function onAoeHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>, t: AoeTemplate) {
    if (!e.isPrimary || activeGestureRef.current || !isDm) return;
    e.preventDefault();
    e.stopPropagation();
    const pct = pointerToPercent(e);
    const point = pct ?? { x: t.x, y: t.y };
    const captureTarget = e.currentTarget;
    captureTarget.setPointerCapture?.(e.pointerId);
    successfulPointerUpRef.current = null;
    activeGestureRef.current = { kind: 'aoe', pointerId: e.pointerId, captureTarget, templateId: t.id, point };
    setSelectedAoeId(t.id);
    setAoeDrag({ id: t.id, ...point });
  }

  // AoE template CRUD (issue #238) — all DM-only PATCHes of the whole template list.
  function addAoe(shape: AoeShape) {
    const sizeFt = shape === 'circle' ? (gridScale ?? 5) * 2 : (gridScale ?? 5) * BASE_AOE_LENGTH_MULT;
    const t: AoeTemplate = { id: newAoeId(), shape, x: 50, y: 50, sizeFt, angleDeg: 0, color: null };
    setSelectedAoeId(t.id);
    onSetAoe([...aoeTemplates, t]);
  }
  function updateAoe(id: string, patch: Partial<AoeTemplate>) {
    onSetAoe(aoeTemplates.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }
  function removeAoe(id: string) {
    if (selectedAoeId === id) setSelectedAoeId(null);
    onSetAoe(aoeTemplates.filter((t) => t.id !== id));
  }

  // Measurement readout (5e: distance counts whole squares along the longer axis is common,
  // but a straight-line ruler is more intuitive — show fractional squares + rounded feet).
  const rulerReadout = (() => {
    if (!ruler || !canMeasure) return null;
    const dpxX = ((ruler.end.x - ruler.start.x) / 100) * surfaceW;
    const dpxY = ((ruler.end.y - ruler.start.y) / 100) * surfaceH;
    const cells = Math.hypot(dpxX, dpxY) / cellPx;
    const feet = Math.round(cells) * (gridScale ?? 0);
    return { cells, feet };
  })();

  const revealPreview = revealCorners ? rectFromCorners(revealCorners.start, revealCorners.end) : null;
  const selectedAoe = aoeTemplates.find((t) => t.id === selectedAoeId) ?? null;

  // Hex overlay polygons (issue #238). Memoized on the geometry inputs so a token/AoE drag —
  // which changes none of them — never recomputes the (potentially hundreds of) hexes.
  const hexCells = useMemo(
    () => (gridOn && gridType === 'hex' ? hexPolygons(surfaceW, surfaceH, cellPx) : []),
    [gridOn, gridType, surfaceW, surfaceH, cellPx],
  );

  function changeTool(next: MapTool) {
    setTool(next);
    setRuler(null);
    setRevealCorners(null);
  }

  const modeBtn = (value: MapTool, label: string, disabled = false, hint?: string) => (
    <button
      type="button"
      className="cf-chip"
      disabled={disabled}
      title={hint}
      onClick={() => changeTool(value)}
      style={{
        cursor: disabled ? 'default' : 'pointer',
        borderColor: tool === value ? 'var(--color-accent)' : 'var(--color-divider)',
        color: tool === value ? 'var(--color-accent)' : undefined,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="card elev-sm reading-exempt" data-testid="battle-map" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px 0', flexWrap: 'wrap' }}>
        <span className="card-kicker">Battle map</span>
        <div style={{ flex: 1 }} />
        {isDm && mapImageUrl && (
          <MapUploadButton
            campaignId={campaignId}
            hasMap
            uploading={uploading || busy}
            onPick={(file) => void uploadMapFile(file)}
            onRemove={() => onSetMap(null)}
          />
        )}
      </div>

      {isDm && !mapImageUrl && (
        <div style={{ padding: '8px 14px' }}>
          <ImageUpload
            campaignId={campaignId}
            kind="map"
            shape="rect"
            label="Drop a battle map image, or click to choose"
            onUploaded={(a) => onSetMap(a.id)}
            onError={onError}
          />
          {/* Open, license-clean map sources (issue #303): generator links + One Page Dungeon
              (CC-BY-SA) import. Complements the built-in procedural generator (#306). */}
          <GetAMapPanel campaignId={campaignId} onImported={(id) => onSetMap(id)} onError={onError} />
        </div>
      )}

      {mapImageUrl && (
        <>
          {/* Toolbar: interaction mode + ping + (DM) AoE templates + grid & fog controls. */}
          <div className="flex flex-wrap gap-2 items-center" style={{ padding: '8px 14px 0' }}>
            {modeBtn('move', 'Move')}
            {modeBtn('measure', 'Measure', !canMeasure, canMeasure ? 'Click-drag to measure' : 'Set a grid scale first')}
            {modeBtn('ping', 'Ping', false, 'Click the map to ping a spot for everyone')}
            {isDm && modeBtn('reveal', 'Reveal', undefined, 'Click-drag to reveal a fog region')}
            {isDm && canAoe && (
              <>
                <span className="text-muted" style={{ fontSize: 11, marginLeft: 4 }}>AoE:</span>
                <button type="button" className="cf-chip" style={{ cursor: 'pointer' }} title="Add a circular burst" onClick={() => addAoe('circle')}>+ Circle</button>
                <button type="button" className="cf-chip" style={{ cursor: 'pointer' }} title="Add a cone" onClick={() => addAoe('cone')}>+ Cone</button>
                <button type="button" className="cf-chip" style={{ cursor: 'pointer' }} title="Add a line" onClick={() => addAoe('line')}>+ Line</button>
              </>
            )}
            <div style={{ flex: 1 }} />
            {isDm && (
              <button
                type="button"
                className="cf-chip"
                onClick={() => setGridPanelOpen((v) => !v)}
                title="Grid & fog settings"
                style={{ cursor: 'pointer', borderColor: gridPanelOpen ? 'var(--color-accent)' : 'var(--color-divider)' }}
              >
                Grid &amp; fog
              </button>
            )}
          </div>

          {/* Selected AoE template editor (DM) — size / rotation / remove for the picked shape. */}
          {isDm && selectedAoe && canAoe && (
            <div className="flex flex-wrap gap-3 items-center" style={{ padding: '8px 14px 0', fontSize: 11 }}>
              <span className="text-muted" style={{ textTransform: 'capitalize' }}>{selectedAoe.shape}</span>
              <label className="flex items-center gap-1 text-muted">
                {selectedAoe.shape === 'circle' ? 'radius' : 'length'}
                <input
                  type="number"
                  min={0}
                  step={gridScale ?? 5}
                  value={selectedAoe.sizeFt}
                  onChange={(e) => updateAoe(selectedAoe.id, { sizeFt: Math.max(1, Number(e.target.value) || 1) })}
                  style={{ width: 56 }}
                />
                {gridUnit}
              </label>
              {selectedAoe.shape !== 'circle' && (
                <label className="flex items-center gap-1 text-muted">
                  angle°
                  <input
                    type="number"
                    step={15}
                    value={selectedAoe.angleDeg}
                    onChange={(e) => updateAoe(selectedAoe.id, { angleDeg: Number(e.target.value) || 0 })}
                    style={{ width: 56 }}
                  />
                </label>
              )}
              <button type="button" className="cf-chip" style={{ cursor: 'pointer', color: 'var(--color-danger, #ef4444)' }} onClick={() => removeAoe(selectedAoe.id)}>Remove</button>
            </div>
          )}

          {isDm && gridPanelOpen && (
            <div
              className="flex flex-wrap gap-3 items-center"
              style={{ padding: '10px 14px', margin: '8px 14px 0', border: '1px solid var(--color-divider)', borderRadius: 8, fontSize: 12 }}
            >
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={gridOn}
                  onChange={(e) =>
                    onSetGrid(
                      e.target.checked
                        ? // Enabling the grid commits real scale/unit alongside the size so the
                          // shown defaults are never phantom and Measure is usable (issue #273a).
                          { gridSize: gridSize ?? 8, gridScale: gridScale ?? 5, gridUnit }
                        : { gridSize: null },
                    )
                  }
                />
                Grid
              </label>
              <label className="flex items-center gap-1 text-muted">
                cell %w
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={0.5}
                  disabled={!gridOn}
                  value={gridSize ?? 8}
                  onChange={(e) => onSetGrid({ gridSize: Math.min(100, Math.max(1, Number(e.target.value) || 8)) })}
                  style={{ width: 60 }}
                />
              </label>
              <label className="flex items-center gap-1 text-muted">
                scale
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={gridScale ?? 5}
                  onChange={(e) => onSetGrid({ gridScale: Math.max(0.5, Number(e.target.value) || 5) })}
                  style={{ width: 56 }}
                />
              </label>
              <label className="flex items-center gap-1 text-muted">
                unit
                <input
                  type="text"
                  maxLength={12}
                  value={gridUnit}
                  onChange={(e) => onSetGrid({ gridUnit: e.target.value })}
                  style={{ width: 48 }}
                />
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={encounter.gridSnap} onChange={(e) => onSetGrid({ gridSnap: e.target.checked })} />
                Snap
              </label>
              <label className="flex items-center gap-1 text-muted">
                type
                <select
                  value={gridType}
                  disabled={!gridOn}
                  onChange={(e) => onSetGrid({ gridType: e.target.value as GridType })}
                  style={{ fontSize: 12 }}
                >
                  <option value="square">square</option>
                  <option value="hex">hex</option>
                </select>
              </label>
              <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--color-divider)' }} />
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={fogOn}
                  onChange={(e) => onSetFog(e.target.checked ? { enabled: true, revealed: fog?.revealed ?? [] } : null)}
                />
                Fog
              </label>
              <button
                type="button"
                className="cf-chip"
                disabled={!fogOn}
                onClick={() => onSetFog({ enabled: true, revealed: [{ x: 0, y: 0, w: 100, h: 100 }] })}
                style={{ cursor: fogOn ? 'pointer' : 'default', opacity: fogOn ? 1 : 0.5 }}
              >
                Reveal all
              </button>
              <button
                type="button"
                className="cf-chip"
                disabled={!fogOn || (fog?.revealed.length ?? 0) === 0}
                onClick={() => onSetFog({ enabled: true, revealed: [] })}
                style={{ cursor: fogOn && (fog?.revealed.length ?? 0) > 0 ? 'pointer' : 'default', opacity: fogOn && (fog?.revealed.length ?? 0) > 0 ? 1 : 0.5 }}
              >
                Hide all
              </button>
            </div>
          )}

          <div
            ref={surfaceRef}
            data-testid="battle-map-surface"
            className="relative overflow-hidden"
            style={{
              margin: '8px 14px',
              aspectRatio: '16 / 9',
              touchAction: tool !== 'move' || draggingId != null || aoeDrag != null ? 'none' : undefined,
              cursor: tool === 'measure' ? 'crosshair' : tool === 'reveal' ? 'cell' : tool === 'ping' ? 'pointer' : undefined,
            }}
            onPointerDown={onSurfacePointerDown}
            onPointerMove={onSurfacePointerMove}
            onPointerUp={onSurfacePointerUp}
            onPointerCancel={onSurfacePointerCancel}
            onLostPointerCapture={onSurfaceLostPointerCapture}
          >
            <img
              src={mapImageUrl}
              alt="Battle map"
              className="absolute inset-0 w-full h-full object-contain"
              style={{ background: 'rgba(15,23,42,.4)' }}
              onLoad={(e) => setImgNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            />

            {/* Grid overlay (issue #40 / #238) — a square CSS grid, or a pointy-top hex SVG.
                Both are clipped to the map image's letterboxed rendered rect (issue #273b) so the
                grid never bleeds onto the dark object-contain bands. The inner layer stays anchored
                to the surface origin (offset by -mapRect) so grid lines keep aligning with token
                snapping, which works in surface coordinates. */}
            {gridOn && gridType === 'square' && cellPx > 1 && mapRect && (
              <div
                className="absolute"
                style={{ pointerEvents: 'none', overflow: 'hidden', left: mapRect.left, top: mapRect.top, width: mapRect.width, height: mapRect.height }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: -mapRect.left,
                    top: -mapRect.top,
                    width: surfaceW,
                    height: surfaceH,
                    backgroundImage:
                      `repeating-linear-gradient(to right, rgba(148,163,184,.35) 0 1px, transparent 1px ${cellPx}px),` +
                      `repeating-linear-gradient(to bottom, rgba(148,163,184,.35) 0 1px, transparent 1px ${cellPx}px)`,
                  }}
                />
              </div>
            )}
            {gridOn && gridType === 'hex' && hexCells.length > 0 && mapRect && (
              <div
                className="absolute"
                style={{ pointerEvents: 'none', overflow: 'hidden', left: mapRect.left, top: mapRect.top, width: mapRect.width, height: mapRect.height }}
              >
                <svg style={{ position: 'absolute', left: -mapRect.left, top: -mapRect.top }} width={surfaceW} height={surfaceH}>
                  {hexCells.map((pts, i) => (
                    <polygon key={i} points={pts} fill="none" stroke="rgba(148,163,184,.35)" strokeWidth={1} />
                  ))}
                </svg>
              </div>
            )}

            {placed.map((c) => {
              const isDragging = draggingId === c.id && dragPos != null;
              const left = isDragging ? dragPos!.x : (c.tokenX ?? 0);
              const top = isDragging ? dragPos!.y : (c.tokenY ?? 0);
              const movable = tool === 'move' && canMoveToken(c);
              const isCharacter = c.kind === 'character';
              const sizePx = Math.max(18, Math.round(BASE_TOKEN_PX * (TOKEN_SIZE_SCALE[c.tokenSize] ?? 1)));
              return (
                <div
                  key={c.id}
                  data-testid={`map-token-${c.id}`}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${left}%`,
                    top: `${top}%`,
                    // In measure/reveal mode tokens must not eat the surface drag.
                    pointerEvents: tool === 'move' ? 'auto' : 'none',
                    touchAction: 'none',
                    cursor: movable ? 'grab' : 'default',
                    opacity: isDragging ? 0.85 : 1,
                    zIndex: isDragging ? 10 : 2,
                  }}
                  onPointerDown={(e) => onTokenPointerDown(e, c)}
                  title={`${c.name}${c.tokenSize !== 'medium' ? ` (${c.tokenSize})` : ''}`}
                >
                  <span
                    style={{
                      display: 'grid',
                      placeItems: 'center',
                      width: sizePx,
                      height: sizePx,
                      borderRadius: '50%',
                      fontSize: Math.max(9, Math.round(sizePx * 0.34)),
                      fontWeight: 700,
                      color: '#fff',
                      background: isCharacter ? 'var(--color-accent)' : 'var(--color-neutral-600)',
                      border: '2px solid rgba(15,23,42,.85)',
                      boxShadow: '0 1px 3px rgba(0,0,0,.5)',
                    }}
                  >
                    {tokenInitials(c.name)}
                  </span>
                  {/* Unplace control (issue #271): remove the token from the board without
                      deleting the combatant. Only offered to whoever may move this token, and
                      only in move mode. stopPropagation on pointer-down so tapping it never
                      starts a token drag. */}
                  {movable && (
                    <button
                      type="button"
                      aria-label={`Remove ${c.name} from the map`}
                      title="Remove from map"
                      disabled={busy}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onUnplaceToken(c.id);
                      }}
                      style={{
                        position: 'absolute',
                        top: -6,
                        right: -6,
                        width: 16,
                        height: 16,
                        display: 'grid',
                        placeItems: 'center',
                        padding: 0,
                        borderRadius: '50%',
                        border: '1px solid rgba(15,23,42,.85)',
                        background: 'var(--color-danger, #b91c1c)',
                        color: '#fff',
                        fontSize: 11,
                        lineHeight: 1,
                        cursor: busy ? 'default' : 'pointer',
                        zIndex: 3,
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}

            {/* Shared AoE templates (issue #238) — circle/cone/line drawn in pixel space so every
                client sees the same shapes. Drawn under an SVG (pointer-inert); the DM gets a
                draggable origin handle per template (move mode only, so it never eats a drag). */}
            {canAoe && aoeTemplates.length > 0 && (
              <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: 'none', zIndex: 6 }} width={surfaceW} height={surfaceH}>
                {aoeTemplates.map((t) => {
                  const drag = aoeDrag && aoeDrag.id === t.id ? aoeDrag : null;
                  const ox = ((drag ? drag.x : t.x) / 100) * surfaceW;
                  const oy = ((drag ? drag.y : t.y) / 100) * surfaceH;
                  const lengthPx = (t.sizeFt / gridScale!) * cellPx;
                  if (lengthPx <= 0) return null;
                  const selected = t.id === selectedAoeId;
                  const stroke = selected ? 'rgba(56,189,248,.95)' : 'rgba(239,68,68,.8)';
                  const fill = selected ? 'rgba(56,189,248,.18)' : 'rgba(239,68,68,.20)';
                  if (t.shape === 'circle') {
                    return <circle key={t.id} cx={ox} cy={oy} r={lengthPx} fill={fill} stroke={stroke} strokeWidth={2} />;
                  }
                  const pts = aoePolygonPoints(t.shape, ox, oy, lengthPx, (t.angleDeg * Math.PI) / 180, cellPx);
                  return <polygon key={t.id} points={pts} fill={fill} stroke={stroke} strokeWidth={2} />;
                })}
              </svg>
            )}
            {isDm && canAoe &&
              aoeTemplates.map((t) => {
                const drag = aoeDrag && aoeDrag.id === t.id ? aoeDrag : null;
                const x = drag ? drag.x : t.x;
                const y = drag ? drag.y : t.y;
                return (
                  <div
                    key={t.id}
                    data-testid={`map-aoe-${t.id}`}
                    className="absolute -translate-x-1/2 -translate-y-1/2"
                    style={{
                      left: `${x}%`,
                      top: `${y}%`,
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      background: t.id === selectedAoeId ? 'var(--color-accent)' : 'rgba(239,68,68,.9)',
                      border: '2px solid rgba(15,23,42,.85)',
                      // Only grab the pointer in move mode, so reveal/measure drags pass through.
                      pointerEvents: tool === 'move' ? 'auto' : 'none',
                      cursor: 'grab',
                      touchAction: 'none',
                      zIndex: 7,
                    }}
                    onPointerDown={(e) => onAoeHandlePointerDown(e, t)}
                    title={`${t.shape} · ${t.sizeFt} ${gridUnit}${t.shape !== 'circle' ? ` · ${t.angleDeg}°` : ''} — drag to move, click to edit`}
                  />
                );
              })}

            {/* Fog of war (issue #40). A dark overlay with the revealed rectangles punched out.
                DM sees through it (semi-transparent) to prep; players see it solid. Coordinates
                are 0–100, so a viewBox of 0 0 100 100 with no aspect preservation maps directly. */}
            {fogOn && (
              <svg
                className="absolute inset-0 w-full h-full"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                style={{ pointerEvents: 'none', zIndex: 4 }}
              >
                <defs>
                  <mask id={`fogmask-${encounter.id}`}>
                    <rect x={0} y={0} width={100} height={100} fill="#fff" />
                    {(fog?.revealed ?? []).map((r, i) => (
                      <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="#000" />
                    ))}
                  </mask>
                </defs>
                <rect x={0} y={0} width={100} height={100} fill="#0b1120" opacity={isDm ? 0.45 : 0.97} mask={`url(#fogmask-${encounter.id})`} />
              </svg>
            )}

            {/* In-progress reveal rectangle (DM). */}
            {revealPreview && (
              <div
                className="absolute"
                data-testid="map-fog-preview"
                style={{
                  left: `${revealPreview.x}%`,
                  top: `${revealPreview.y}%`,
                  width: `${revealPreview.w}%`,
                  height: `${revealPreview.h}%`,
                  border: '2px dashed var(--color-accent)',
                  background: 'rgba(56,189,248,.12)',
                  pointerEvents: 'none',
                  zIndex: 8,
                }}
              />
            )}

            {/* Measurement ruler (issue #40). */}
            {ruler && canMeasure && (
              <>
                <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: 'none', zIndex: 7 }}>
                  <line
                    data-testid="map-ruler-line"
                    x1={`${ruler.start.x}%`}
                    y1={`${ruler.start.y}%`}
                    x2={`${ruler.end.x}%`}
                    y2={`${ruler.end.y}%`}
                    stroke="var(--color-accent)"
                    strokeWidth={2}
                    strokeDasharray="5 4"
                  />
                </svg>
                {rulerReadout && (
                  <div
                    className="absolute"
                    style={{
                      left: `${ruler.end.x}%`,
                      top: `${ruler.end.y}%`,
                      transform: 'translate(8px, 8px)',
                      background: 'rgba(15,23,42,.9)',
                      color: '#fff',
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '2px 6px',
                      borderRadius: 4,
                      pointerEvents: 'none',
                      whiteSpace: 'nowrap',
                      zIndex: 9,
                    }}
                  >
                    {rulerReadout.cells.toFixed(1)} sq · {rulerReadout.feet} {gridUnit}
                  </div>
                )}
              </>
            )}

            {/* Live pings (issue #238) — a short expanding pulse everyone at the table sees. */}
            {pings.map((p) => (
              <div
                key={p.key}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{
                  left: `${p.x}%`,
                  top: `${p.y}%`,
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  border: '3px solid var(--color-accent)',
                  pointerEvents: 'none',
                  zIndex: 10,
                  animation: 'cfPing 2.4s ease-out forwards',
                }}
              />
            ))}
            <style>{'@keyframes cfPing{0%{transform:translate(-50%,-50%) scale(.4);opacity:.9}70%{opacity:.55}100%{transform:translate(-50%,-50%) scale(3);opacity:0}}'}</style>
          </div>

          {unplaced.length > 0 && (
            <div className="flex flex-wrap gap-2 items-center" style={{ padding: '0 14px 10px' }}>
              <span className="text-muted" style={{ fontSize: 11 }}>Unplaced:</span>
              {unplaced.map((c) => {
                const movable = canMoveToken(c);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className="cf-chip"
                    disabled={!movable || busy}
                    onClick={() => onMoveToken(c.id, 50, 50)}
                    title={movable ? 'Place token at center' : 'You can only move your own token'}
                    style={{ cursor: movable && !busy ? 'pointer' : 'default', border: '1px dashed var(--color-divider)' }}
                  >
                    {tokenInitials(c.name)} · {c.name}
                  </button>
                );
              })}
            </div>
          )}

          <div
            className="text-muted"
            style={{ padding: '8px 14px', borderTop: '1px solid var(--color-divider)', fontSize: 11 }}
          >
            {tool === 'measure'
              ? 'Click-drag on the map to measure distance.'
              : tool === 'reveal'
                ? 'Click-drag to reveal a region of the map to players.'
                : tool === 'ping'
                  ? 'Click anywhere on the map to ping that spot for everyone.'
                  : isDm
                    ? 'Drag a token to move it. Drag an AoE handle to move a template, click it to edit.'
                    : 'Drag your own token to move it.'}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * One-tap "apply rolled damage" bar (issue: wire actions → dice → damage). Appears
 * when a character card rolls damage; the user picks Damage/Heal and taps a target
 * combatant to apply it via the same HP path as the ± steppers. Targets are limited
 * to combatants the viewer can edit (the DM: everyone; a player: their own character),
 * so it never lets a player edit HP the server would reject anyway.
 */
function ApplyDamageBar({
  amount,
  label,
  targets,
  onApply,
  onDismiss,
}: {
  amount: number;
  label: string;
  targets: Combatant[];
  onApply: (combatantId: number, delta: number) => void;
  onDismiss: () => void;
}) {
  const [mode, setMode] = useState<'damage' | 'heal'>('damage');
  const delta = mode === 'heal' ? amount : -amount;
  return (
    <div
      className="cf-inset"
      role="group"
      aria-label={`Apply ${amount} rolled ${label}`}
      style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px' }}
    >
      <span style={{ fontSize: 12.5 }}>
        <span className="text-muted">Rolled </span>
        <span style={{ fontWeight: 700, color: 'var(--color-text)' }}>{amount}</span>
        <span className="text-muted"> — {label}</span>
      </span>
      <div className="seg inline-flex" role="group" aria-label="Apply as">
        {(['damage', 'heal'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              color: mode === m ? 'var(--color-accent)' : 'var(--color-neutral-500)',
              boxShadow: mode === m ? 'inset 0 0 0 1px var(--color-accent)' : 'none',
              minHeight: 30,
            }}
          >
            {m === 'damage' ? 'Damage' : 'Heal'}
          </button>
        ))}
      </div>
      <span className="text-muted" style={{ fontSize: 11.5 }}>
        {mode === 'heal' ? 'Heal' : 'Apply to'}:
      </span>
      {targets.length === 0 ? (
        <span className="text-muted" style={{ fontSize: 11.5 }}>no editable targets</span>
      ) : (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {targets.map((c) => (
            <button
              key={c.id}
              type="button"
              className="btn btn-secondary"
              style={{ minHeight: 30, fontSize: 11.5, padding: '3px 10px' }}
              title={`${mode === 'heal' ? 'Heal' : 'Deal'} ${amount} to ${c.name}`}
              onClick={() => onApply(c.id, delta)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="text-slate-500 hover:text-slate-300"
        style={{ background: 'transparent', border: 0, cursor: 'pointer', fontSize: 14, marginLeft: 'auto' }}
      >
        ✕
      </button>
    </div>
  );
}

function CombatantRow({
  combatant,
  isCurrentTurn,
  canEdit,
  canEditIdentity,
  canViewStatblock,
  canRemove,
  canSetInitiative,
  running,
  character,
  openCardByDefault,
  campaignId,
  onRollError,
  onApplyDamage,
  busy,
  conditionSuggestions,
  ruleSystem,
  onHpDelta,
  onSetTempHp,
  onSetDeathSaves,
  onRollDeathSave,
  onSetInitiative,
  onClearInitiative,
  onAddCondition,
  onRemoveCondition,
  onRename,
  onSetHpMax,
  onSetTokenSize,
  onRemove,
}: {
  combatant: Combatant;
  isCurrentTurn: boolean;
  canEdit: boolean;
  canEditIdentity: boolean;
  canViewStatblock: boolean;
  canRemove: boolean;
  canSetInitiative: boolean;
  /** Encounter is running — clearing initiative re-sorts the live turn order (issue #715). */
  running: boolean;
  /** The linked player character (kind === 'character'), for the in-encounter stat card; null otherwise. */
  character: Character | null;
  /** Start the character card expanded — used for the viewer's own character. */
  openCardByDefault: boolean;
  /**
   * Campaign id — enables click-to-roll on the card for combatants the viewer controls.
   * Undefined while SSE is offline/reconnecting so obsolete modifiers cannot be rolled (#421).
   */
  campaignId: number | undefined;
  onRollError: (msg: string | null) => void;
  /** A damage total rolled from the card, to be applied to a target combatant. */
  onApplyDamage: (amount: number, label: string) => void;
  busy: boolean;
  /** Condition chips offered by the active campaign's rule-system adapter (issue #234). */
  conditionSuggestions: readonly string[];
  /** Active campaign's rule system — selects the statblock adapter (issue #234). */
  ruleSystem: string | null;
  onHpDelta: (delta: number) => void;
  onSetTempHp: (value: number) => void;
  onSetDeathSaves: (patch: { deathSaveSuccesses?: number; deathSaveFailures?: number }) => void;
  /** Roll a death save (issue #619) — rolls d20, posts to the dice log, drives the server outcome. */
  onRollDeathSave: () => void;
  onSetInitiative: (value: number) => void;
  /** Clear initiative back to the unrolled state (issue #715) — sends `initiative: null`. */
  onClearInitiative: () => void;
  onAddCondition: (cond: string) => void;
  onRemoveCondition: (cond: string) => void;
  onRename: (name: string) => void;
  onSetHpMax: (value: number) => void;
  onSetTokenSize: (size: TokenSize) => void;
  onRemove: () => void;
}) {
  const [addingCondition, setAddingCondition] = useState(false);
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [nameDraft, setNameDraft] = useState(combatant.name);
  const [hpMaxDraft, setHpMaxDraft] = useState(combatant.hpMax?.toString() ?? '');
  const [tempDraft, setTempDraft] = useState('');
  useEffect(() => {
    setNameDraft(combatant.name);
    setHpMaxDraft(combatant.hpMax?.toString() ?? '');
  }, [combatant.name, combatant.hpMax]);

  function commitIdentity() {
    const trimmedName = nameDraft.trim();
    if (trimmedName && trimmedName !== combatant.name) onRename(trimmedName);
    const nextHpMax = Number(hpMaxDraft);
    if (Number.isInteger(nextHpMax) && nextHpMax >= 1 && nextHpMax !== combatant.hpMax) onSetHpMax(nextHpMax);
    setEditingIdentity(false);
  }

  function commitTempHp() {
    const trimmed = tempDraft.trim();
    if (trimmed === '') return;
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < 0) return;
    onSetTempHp(value);
    setTempDraft('');
  }
  // Draft of the initiative field (DM only). Kept local so typing doesn't fire a
  // PATCH per keystroke — committed on blur / Enter.
  const [initDraft, setInitDraft] = useState<string>(combatant.initiative?.toString() ?? '');
  useEffect(() => {
    setInitDraft(combatant.initiative?.toString() ?? '');
  }, [combatant.initiative]);

  function commitInitiative() {
    const trimmed = initDraft.trim();
    // Empty input now CLEARS initiative back to the unrolled state (issue #715),
    // instead of silently leaving it as-is. An explicit Clear control is also
    // rendered beside the input for discoverability + keyboard access.
    if (trimmed === '') {
      if (combatant.initiative !== null) onClearInitiative();
      return;
    }
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value === combatant.initiative) return;
    onSetInitiative(value);
  }

  // Clear initiative back to null (issue #715). While combat is running this re-sorts
  // the order — the cleared combatant sinks below every rolled actor — so the title
  // warns the DM. The current-turn pointer is identity-based and stays stable; the
  // server reconciles the positional turnIndex after the write.
  const runningReorderNote =
    'Clear initiative back to unrolled' +
    (running ? ' — re-sorts the turn order while combat is running' : '');

  const edgeColor = isCurrentTurn ? 'var(--color-accent)' : 'transparent';
  const kindTagClass = combatant.kind === 'character' ? 'tag tag-accent' : combatant.kind === 'npc' ? 'tag tag-outline' : 'tag tag-neutral';
  const kindLabel = combatant.kind === 'npc' ? 'NPC' : combatant.kind;
  // Issue #107: a combatant at 0 HP got no visual treatment mid-fight — the row
  // looked identical bar an empty HP bar, so a "dead" creature was invisible in the
  // order (the end-of-combat summary already counted it as Fallen). Dim + desaturate
  // the whole row and skull/strike-through the name. `isDown` works off the HP band
  // too, so a redacted monster (exact HP hidden, band 'down') gets the same treatment.
  const down = isDown(combatant);

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        padding: '9px 14px',
        borderLeft: `2px solid ${edgeColor}`,
        background: isCurrentTurn ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent',
        boxShadow: isCurrentTurn ? '0 0 0 1px color-mix(in srgb, var(--color-accent) 35%, transparent)' : 'none',
        opacity: down ? 0.55 : 1,
        filter: down ? 'grayscale(0.75)' : 'none',
      }}
    >
      {canSetInitiative ? (
        <div className="flex items-center" style={{ gap: 2 }}>
          <input
            type="number"
            aria-label={`Initiative for ${combatant.name}`}
            title="Set initiative"
            value={initDraft}
            disabled={busy}
            placeholder="–"
            onChange={(e) => setInitDraft(e.target.value)}
            onBlur={commitInitiative}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
              // Backspace/Delete on an empty field clears initiative (issue #715) — a
              // keyboard-only path that mirrors the dedicated Clear button below.
              if ((e.key === 'Backspace' || e.key === 'Delete') && initDraft.trim() === '') {
                e.preventDefault();
                if (combatant.initiative !== null) onClearInitiative();
              }
            }}
            style={{
              width: 34,
              height: 30,
              flex: 'none',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-divider)',
              background: 'transparent',
              textAlign: 'center',
              fontSize: 13,
              fontFamily: 'var(--font-heading)',
              color: isCurrentTurn ? 'var(--color-accent)' : 'var(--color-text)',
            }}
          />
          {combatant.initiative !== null && (
            <button
              type="button"
              aria-label={`Clear ${combatant.name} roll order`}
              title={runningReorderNote}
              disabled={busy}
              onClick={() => {
                setInitDraft('');
                onClearInitiative();
              }}
              style={{
                width: 22,
                height: 30,
                flex: 'none',
                padding: 0,
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-divider)',
                background: 'transparent',
                cursor: busy ? 'default' : 'pointer',
                color: 'var(--color-neutral-500)',
                fontSize: 13,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          )}
        </div>
      ) : (
        <span
          style={{
            width: 30,
            height: 30,
            flex: 'none',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-divider)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 13,
            fontFamily: 'var(--font-heading)',
            color: isCurrentTurn ? 'var(--color-accent)' : 'var(--color-text)',
          }}
        >
          {combatant.initiative ?? '–'}
        </span>
      )}
      <div style={{ flex: 1, minWidth: 160 }}>
        {editingIdentity ? (
          <div className="flex gap-2 items-end flex-wrap" style={{ marginBottom: 4 }}>
            <div className="field" style={{ flex: 1, minWidth: 120 }}>
              <label htmlFor={`rename-${combatant.id}`}>Name</label>
              <TextInput
                id={`rename-${combatant.id}`}
                value={nameDraft}
                disabled={busy}
                autoFocus
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitIdentity(); }
                  if (e.key === 'Escape') { setEditingIdentity(false); setNameDraft(combatant.name); }
                }}
              />
            </div>
            <div className="field" style={{ width: 72 }}>
              <label htmlFor={`hpmax-${combatant.id}`}>Max HP</label>
              <TextInput
                id={`hpmax-${combatant.id}`}
                aria-label={`Max HP for ${combatant.name}`}
                value={hpMaxDraft}
                disabled={busy}
                onChange={(e) => setHpMaxDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitIdentity(); }
                  if (e.key === 'Escape') { setEditingIdentity(false); setHpMaxDraft(combatant.hpMax?.toString() ?? ''); }
                }}
              />
            </div>
            <div className="field" style={{ width: 108 }}>
              <label htmlFor={`tokensize-${combatant.id}`}>Token size</label>
              <select
                id={`tokensize-${combatant.id}`}
                aria-label={`Token size for ${combatant.name}`}
                value={combatant.tokenSize}
                disabled={busy}
                onChange={(e) => onSetTokenSize(e.target.value as TokenSize)}
                style={{ height: 32, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-divider)', background: 'transparent', color: 'var(--color-text)', fontSize: 12, padding: '0 6px' }}
              >
                {TOKEN_SIZE_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <Btn onClick={commitIdentity} disabled={busy}>Save</Btn>
            <button className="btn btn-ghost" style={{ fontSize: 'var(--type-label)' }} onClick={() => { setEditingIdentity(false); setNameDraft(combatant.name); setHpMaxDraft(combatant.hpMax?.toString() ?? ''); }}>Cancel</button>
          </div>
        ) : (
          <div style={{ fontSize: 14, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={down ? { textDecoration: 'line-through' } : undefined}>
              {down && <GameIcon slug="death-skull" size={14} className="inline align-text-bottom mr-1.5" />}
              {combatant.name}
            </span>
            <span className={kindTagClass}>
              {kindLabel}
            </span>
            {combatant.deathState !== 'none' && combatant.deathState !== undefined ? (
              <span className="tag tag-outline">
                {DEATH_STATE_LABEL[combatant.deathState] ?? 'Down'}
              </span>
            ) : (
              down && (
                <span className="tag tag-outline">
                  Down
                </span>
              )
            )}
            {canEditIdentity && (
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={`Rename ${combatant.name} or edit its max HP`}
                title="Rename / edit max HP"
                disabled={busy}
                onClick={() => setEditingIdentity(true)}
                style={{ fontSize: 'var(--type-label)', minHeight: 20, padding: '1px 6px' }}
              >
                ✎
              </button>
            )}
          </div>
        )}
        {/* Death-save tracker (issue #57): shown for a character that is dying/stable/dead,
            or any character sitting at 0 HP. Monsters never roll death saves. */}
        {combatant.kind === 'character' &&
          (combatant.deathState === 'dying' ||
            combatant.deathState === 'stable' ||
            combatant.deathState === 'dead' ||
            (combatant.hpCurrent != null && combatant.hpCurrent <= 0)) && (
            <DeathSaveTracker
              successes={combatant.deathSaveSuccesses ?? 0}
              failures={combatant.deathSaveFailures ?? 0}
              canEdit={canEdit}
              busy={busy}
              onSet={onSetDeathSaves}
              onRoll={onRollDeathSave}
            />
          )}
        {combatant.conditions.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            {combatant.conditions.map((cond) => (
              <span key={cond} className="tag tag-outline" style={{ gap: 6 }}>
                {cond}
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`Remove ${cond}`}
                    onClick={() => onRemoveCondition(cond)}
                    disabled={busy}
                    style={{
                      cursor: busy ? 'default' : 'pointer',
                      opacity: 0.7,
                      background: 'transparent',
                      border: 0,
                      padding: 0,
                      font: 'inherit',
                      color: 'inherit',
                    }}
                  >
                    ✕
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        {canEdit && (
          <div style={{ marginTop: 4 }}>
            {addingCondition ? (
              <div className="flex gap-1 flex-wrap">
                {conditionSuggestions.filter((s) => !combatant.conditions.includes(s)).map((s) => (
                  <button
                    key={s}
                    className="btn btn-ghost"
                    style={{ fontSize: 'var(--type-label)', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)', minHeight: 24, padding: '2px 8px' }}
                    onClick={() => {
                      onAddCondition(s);
                      setAddingCondition(false);
                    }}
                  >
                    + {s}
                  </button>
                ))}
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 'var(--type-label)', minHeight: 24, padding: '2px 8px' }}
                  onClick={() => setAddingCondition(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="btn btn-ghost"
                style={{ fontSize: 'var(--type-label)', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)', minHeight: 24, padding: '2px 8px' }}
                onClick={() => setAddingCondition(true)}
              >
                + condition
              </button>
            )}
          </div>
        )}
        {/* Compendium statblock (issue #56): a monster combatant keeps its ruleEntryId —
            surface the linked entry's AC / attacks / ability scores inline so the DM can
            answer "does a 17 hit?" without leaving the tracker. Collapsible so the row
            stays scannable; lazily fetched on first expand. */}
        {canViewStatblock && combatant.ruleEntryId != null && (
          <CombatantStatblock ruleEntryId={combatant.ruleEntryId} ruleSystem={ruleSystem} />
        )}
        {/* Character card (in-encounter sheet): a player sees their own combat stats —
            abilities, saves, skills, actions, spell slots — without leaving the tracker,
            and the DM sees the whole party's. Character data is party-visible (dmSecret is
            stripped server-side and never shown here), so it renders for every viewer. */}
        {combatant.kind === 'character' && character && (
          <CharacterStatCard
            character={character}
            ruleSystem={ruleSystem}
            defaultOpen={openCardByDefault}
            /* Click-to-roll only from a card the viewer controls (their own PC, or any for the DM). */
            campaignId={canEdit ? campaignId : undefined}
            onError={onRollError}
            onApplyDamage={onApplyDamage}
          />
        )}
      </div>
      <div style={{ minWidth: 130, flex: 'none' }}>
        {combatant.hpCurrent != null && combatant.hpMax != null ? (
          <>
            <div style={{ fontSize: 12.5, textAlign: 'right', marginBottom: 3, display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'baseline' }}>
              {combatant.hpTemp != null && combatant.hpTemp > 0 && (
                <span className="tag tag-accent" title="Temporary HP — absorbs damage first">
                  <GameIcon slug="shield" size={10} className="inline align-text-bottom mr-1" />{combatant.hpTemp}
                </span>
              )}
              <span>
                {combatant.hpCurrent} / {combatant.hpMax}
              </span>
            </div>
            <HpBar current={combatant.hpCurrent} max={combatant.hpMax} />
          </>
        ) : (
          <>
            <div style={{ fontSize: 12.5, textAlign: 'right', marginBottom: 3 }} title="Exact HP is hidden for monsters">
              {combatant.hpBand ? HP_BAND_LABEL[combatant.hpBand] : '—'}
            </div>
            <HpBandBar band={combatant.hpBand} />
          </>
        )}
        {/* Temp-HP setter (issue #57) — grant/clear temporary HP. Same edit gate as
            the HP steppers; hidden for redacted monster rows (hpCurrent null). */}
        {canEdit && combatant.hpCurrent != null && (
          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', marginTop: 4 }}>
            <input
              type="number"
              min={0}
              aria-label={`Set temporary HP for ${combatant.name}`}
              placeholder="temp"
              value={tempDraft}
              disabled={busy}
              onChange={(e) => setTempDraft(e.target.value)}
              onBlur={commitTempHp}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
              }}
              style={{
                width: 60,
                height: 26,
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-divider)',
                background: 'transparent',
                textAlign: 'center',
                fontSize: 'var(--type-label)',
                color: 'var(--color-text)',
              }}
            />
          </div>
        )}
      </div>
      {/* HP steppers — only where a concrete number exists to adjust. A redacted
          monster's HP is banded (hpCurrent null) for non-DM viewers (issue #43),
          so we never render steppers pointing at a null value. Mirrors the sheet's
          ±5 / ±1 controls, incl. shift-click ×5 (issue #68). */}
      {canEdit && combatant.hpCurrent != null && (
        <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
          {([-5, -1, 1, 5] as const).map((step) => (
            <button
              key={step}
              className="btn btn-icon btn-secondary"
              style={{ width: 44, height: 44, fontSize: step === 1 || step === -1 ? 16 : 13, fontFamily: 'var(--font-heading)' }}
              /* Optimistic: HP steppers stay live even mid-request (issue #73) — the click
                 lands instantly via setQueryData, so there's no round-trip to wait on. */
              aria-label={`${step < 0 ? 'Reduce' : 'Increase'} ${combatant.name}'s HP by ${Math.abs(step)} (hold Shift for ${Math.abs(step) * 5}; currently ${combatant.hpCurrent} of ${combatant.hpMax})`}
              onClick={(e) => onHpDelta(e.shiftKey ? step * 5 : step)}
            >
              {step > 0 ? `+${step}` : `−${Math.abs(step)}`}
            </button>
          ))}
        </div>
      )}
      {canRemove && (
        <button
          className="btn btn-icon btn-ghost"
          style={{ width: 30, height: 30, fontSize: 12, flex: 'none' }}
          disabled={busy}
          onClick={onRemove}
          title="Remove combatant"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/**
 * Collapsible statblock for a compendium-linked monster combatant (issue #56). The
 * combatant only stores a `ruleEntryId`; the entry's AC / attacks / ability scores live
 * in its `dataJson`, fetched lazily from the existing rules read path on first expand
 * and rendered with the shared StatBlock component (added by #142). Kept collapsed by
 * default so the initiative row stays scannable mid-fight.
 */
function CombatantStatblock({ ruleEntryId, ruleSystem }: { ruleEntryId: number; ruleSystem: string | null }) {
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState<RuleEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && entry === null && !loading) {
      setLoading(true);
      setFailed(false);
      try {
        const e = await api.get<RuleEntry>(`${API}/rules/entries/${ruleEntryId}`);
        setEntry(e);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div style={{ marginTop: 5 }}>
      <button
        type="button"
        className="btn btn-ghost"
        aria-expanded={open}
        onClick={toggle}
        style={{ fontSize: 'var(--type-label)', minHeight: 24, padding: '2px 8px', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
      >
        {open ? '▾' : '▸'} Statblock
      </button>
      {open && (
        <div
          style={{
            marginTop: 6,
            padding: '10px 12px',
            border: '1px solid var(--color-divider)',
            borderRadius: 'var(--radius-md)',
            background: 'color-mix(in srgb, var(--color-accent) 4%, transparent)',
            maxWidth: 460,
          }}
        >
          {loading ? (
            <Skeleton lines={3} />
          ) : failed ? (
            <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
              Couldn&apos;t load the statblock.
            </p>
          ) : entry && hasMonsterStatblock(entry.dataJson, ruleSystem) ? (
            <StatBlock data={entry.dataJson} ruleSystem={ruleSystem} />
          ) : (
            <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
              No statblock details for this entry.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const EVENT_ICON: Record<string, string> = {
  damage: 'crossed-swords',
  heal: 'sparkles',
  condition: 'whirlwind',
  death: 'death-skull',
  turn: 'stopwatch',
  roll: 'rolling-dices',
  note: 'quill-ink',
  override: 'tabletop-players',
  correction: 'quill-ink',
};

/**
 * Persistent per-encounter combat log (issue #61). Renders the server-stored event
 * trail (damage/heal, conditions, deaths, rolls, turns, notes, overrides, and
 * corrections) in chronological order — it survives reload and updates live with
 * the rest of the tracker. Scrollable so a long fight doesn't push the page down.
 */
function CombatLog({ events }: { events: EncounterEvent[] }) {
  const headingId = 'combat-log-heading';
  const logRef = useRef<HTMLDivElement>(null);
  const preservedScrollTopRef = useRef(0);

  // React's list append can invoke browser scroll anchoring around the focused
  // container. Snapshot before the commit and restore in the layout phase so a
  // remote event never moves someone away from the history they were reading.
  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    log.scrollTop = preservedScrollTopRef.current;
    return () => {
      preservedScrollTopRef.current = log.scrollTop;
    };
  }, [events]);

  return (
    <Card className="space-y-2">
      <h2 id={headingId} className="card-kicker" style={{ margin: 0 }}>Combat log</h2>
      <div
        ref={logRef}
        role="log"
        aria-labelledby={headingId}
        aria-live="off"
        tabIndex={0}
        className="reading-supporting"
        style={{ maxHeight: 260, overflowY: 'auto', overflowAnchor: 'none' }}
      >
        {events.length === 0 ? (
          <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
            Nothing yet — damage, healing, conditions, deaths, rolls, turns, notes, overrides and corrections will show here as the fight unfolds.
          </p>
        ) : (
          <ol style={{ display: 'flex', flexDirection: 'column', gap: 4, listStyle: 'none', margin: 0, padding: 0 }}>
            {events.map((ev) => (
              <li key={ev.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, lineHeight: 1.4 }}>
                <span aria-hidden="true" style={{ flex: 'none' }}>
                  {EVENT_ICON[ev.type] ? <GameIcon slug={EVENT_ICON[ev.type]} size={13} /> : '•'}
                </span>
                {ev.round > 0 && (
                  <span className="tag tag-neutral" style={{ fontSize: 9, flex: 'none' }}>
                    R{ev.round}
                  </span>
                )}
                <span style={{ minWidth: 0 }}>{formatCombatLogEventSummary(ev)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

function EndedSummary({ encounter }: { encounter: EncounterWithCombatants }) {
  const fallen = encounter.combatants.filter(isDown);
  const survivors = encounter.combatants.filter((c) => !isDown(c));
  return (
    <Card>
      <span className="card-kicker">Summary</span>
      <div className="flex gap-4 flex-wrap" style={{ fontSize: 13.5 }}>
        <span>
          Rounds: <b>{encounter.round}</b>
        </span>
        <span>
          Fallen: <b>{fallen.length}</b>
          {fallen.length > 0 && <span className="text-muted"> ({fallen.map((c) => c.name).join(', ')})</span>}
        </span>
        <span>
          Survivors: <b>{survivors.length}</b>
        </span>
      </div>
    </Card>
  );
}

/**
 * A deliberately small hand-off into existing post-session surfaces. This is not an
 * aftermath workflow: it stores no state and creates no new domain actions. Links are
 * DM-only because recap authoring and party-wide XP awards are DM capabilities, and a
 * session-specific destination is only rendered when the encounter actually has one.
 */
function EncounterNextSteps({ campaignId, sessionId }: { campaignId: number; sessionId: number | null }) {
  const sessionsPath = `/c/${campaignId}/sessions`;
  const recapPath =
    sessionId == null
      ? `${sessionsPath}?action=new-recap`
      : `${sessionsPath}?session=${sessionId}&action=edit-recap`;

  return (
    <section className="cf-card p-5 space-y-3" aria-labelledby="encounter-next-heading">
      <div className="space-y-1">
        <h2 id="encounter-next-heading" className="text-sm font-bold text-white m-0">
          Next
        </h2>
        <p className="text-xs text-slate-400 m-0">Wrap up the table while the encounter is still fresh.</p>
      </div>
      <nav
        aria-label="Post-encounter next steps"
        className={`grid grid-cols-1 gap-2 ${sessionId == null ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}
      >
        <Link to={recapPath} className="btn btn-primary min-w-0 min-h-11 flex-col !items-start text-left">
          <span className="font-semibold">Write recap</span>
          <span className="text-[11px] text-muted font-normal">
            {sessionId == null ? 'Create a session recap.' : 'Edit the linked session recap.'}
          </span>
        </Link>
        <Link
          to={`/c/${campaignId}/party?action=award-xp`}
          className="btn btn-secondary min-w-0 min-h-11 flex-col !items-start text-left"
        >
          <span className="font-semibold">Award XP</span>
          <span className="text-[11px] text-muted font-normal">Open the party XP form.</span>
        </Link>
        {sessionId != null && (
          <Link
            to={`${sessionsPath}?session=${sessionId}`}
            className="btn btn-secondary min-w-0 min-h-11 flex-col !items-start text-left"
          >
            <span className="font-semibold">Open linked session</span>
            <span className="text-[11px] text-muted font-normal">Review its details and recap.</span>
          </Link>
        )}
      </nav>
    </section>
  );
}

// ---------------------------------------------------------------------------

type AddTab = 'manual' | 'compendium' | 'party' | 'npc';

function AddCombatantPanel({
  encounterId,
  campaignId: cid,
  characters,
  existingCombatantCharacterIds,
  rulePack,
  onAdded,
}: {
  encounterId: number;
  campaignId: number;
  characters: Character[];
  existingCombatantCharacterIds: Set<number>;
  rulePack: string;
  onAdded: () => Promise<void> | void;
}) {
  const [tab, setTab] = useState<AddTab>('manual');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Manual
  const [name, setName] = useState('');
  const [hpMax, setHpMax] = useState('');
  const [initMod, setInitMod] = useState('');
  const [manualCount, setManualCount] = useState('1');

  // Compendium
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 300);
  const [results, setResults] = useState<RuleEntry[]>([]);
  const [searching, setSearching] = useState(false);
  // Quantity + optional name override applied to the next compendium add (issue #114).
  const [compCount, setCompCount] = useState('1');
  const [nameOverride, setNameOverride] = useState('');

  // NPC (issue: NPCs as combatants) — pick a campaign NPC for identity, then give it
  // HP manually or by linking a compendium statblock (the compendium search below).
  const [npcs, setNpcs] = useState<Npc[]>([]);
  const [selectedNpcId, setSelectedNpcId] = useState('');
  const [npcHp, setNpcHp] = useState('');
  const [npcInit, setNpcInit] = useState('');

  /** Clamp a free-text quantity field to a sane 1–50, defaulting to 1. */
  function parseCount(raw: string): number {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(50, n);
  }

  // Campaign NPCs for the NPC tab's picker. Low-churn, fetched once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<Npc[]>(`${API}/campaigns/${cid}/npcs`);
        if (!cancelled) setNpcs(list);
      } catch {
        /* leave empty — the tab shows an empty-state hint */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cid]);

  useEffect(() => {
    if ((tab !== 'compendium' && tab !== 'npc') || !debouncedQuery.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ type: 'monster', q: debouncedQuery.trim() });
        if (rulePack) params.set('pack', rulePack);
        const list = await api.get<RuleEntry[]>(`${API}/rules/search?${params.toString()}`);
        if (!cancelled) setResults(list);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, debouncedQuery, rulePack]);

  async function addManual(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    // A manual combatant has no rule-entry/character to derive HP from, so the server requires
    // hpMax explicitly. Mirror that here with a readable message instead of the round-trip's
    // dev-jargon "Unable to resolve hpMax…" (issue #146).
    if (!hpMax.trim() || !Number.isFinite(Number(hpMax)) || Number(hpMax) < 1) {
      setError('Enter max HP (a number of 1 or more) for a manual combatant.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'monster' as CombatantKind,
        name: name.trim(),
        hpMax: hpMax ? Math.max(1, Number(hpMax)) : undefined,
        initMod: initMod ? Number(initMod) : undefined,
        count: parseCount(manualCount),
      });
      setName('');
      setHpMax('');
      setInitMod('');
      setManualCount('1');
      await onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add combatant.");
    } finally {
      setSaving(false);
    }
  }

  async function addFromCompendium(entry: RuleEntry) {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'monster' as CombatantKind,
        // Optional override lets the DM rename ("Goblin" -> "Goblin archer") at add time;
        // otherwise the statblock name is used. count>1 auto-suffixes 1..N server-side.
        name: nameOverride.trim() || entry.name,
        ruleEntryId: entry.id,
        count: parseCount(compCount),
      });
      setNameOverride('');
      setCompCount('1');
      await onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add combatant.");
    } finally {
      setSaving(false);
    }
  }

  async function addFromParty(character: Character) {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'character' as CombatantKind,
        characterId: character.id,
        name: character.name,
        hpMax: character.hpMax,
      });
      await onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add combatant.");
    } finally {
      setSaving(false);
    }
  }

  // Add the selected NPC as a combatant. With a statblock `entry` it borrows that
  // statblock's HP (like a compendium add); otherwise it uses the manual HP field.
  async function addFromNpc(entry?: RuleEntry) {
    const npcIdNum = Number(selectedNpcId);
    if (!selectedNpcId || !Number.isFinite(npcIdNum)) {
      setError('Pick an NPC to add.');
      return;
    }
    if (!entry && (!npcHp.trim() || !Number.isFinite(Number(npcHp)) || Number(npcHp) < 1)) {
      setError('Enter max HP (1 or more), or pick a statblock, for this NPC.');
      return;
    }
    const npc = npcs.find((n) => n.id === npcIdNum);
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'npc' as CombatantKind,
        npcId: npcIdNum,
        name: npc?.name,
        ruleEntryId: entry?.id,
        hpMax: entry ? undefined : Math.max(1, Number(npcHp)),
        initMod: npcInit ? Number(npcInit) : undefined,
      });
      setNpcHp('');
      setNpcInit('');
      await onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add combatant.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <span className="card-kicker">Add combatant</span>
      <div className="seg self-start inline-flex">
        {(['manual', 'compendium', 'party', 'npc'] as AddTab[]).map((t) => (
          <button
            key={t}
            style={{
              padding: '7px 13px',
              font: 'inherit',
              fontSize: 12,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              color: tab === t ? 'var(--color-accent)' : 'var(--color-text)',
              boxShadow: tab === t ? 'inset 0 0 0 1px var(--color-accent)' : 'none',
              minHeight: 32,
            }}
            onClick={() => setTab(t)}
          >
            {t === 'manual' ? 'Manual' : t === 'compendium' ? 'Compendium' : t === 'party' ? 'Party' : 'NPC'}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}

      {tab === 'manual' && (
        <form onSubmit={addManual} className="flex gap-2 flex-wrap items-end">
          <div className="field" style={{ flex: 1, minWidth: 140 }}>
            <label htmlFor="add-combatant-name">Name</label>
            <TextInput id="add-combatant-name" placeholder="Ashen cultist" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div className="field" style={{ width: 80 }}>
            <label htmlFor="add-combatant-hp">HP</label>
            <TextInput id="add-combatant-hp" aria-label="Max HP" placeholder="22" value={hpMax} onChange={(e) => setHpMax(e.target.value)} />
          </div>
          <div className="field" style={{ width: 80 }}>
            <label htmlFor="add-combatant-init">Init mod</label>
            <TextInput id="add-combatant-init" aria-label="Initiative modifier" placeholder="2" value={initMod} onChange={(e) => setInitMod(e.target.value)} />
          </div>
          <div className="field" style={{ width: 70 }}>
            <label htmlFor="add-combatant-count">Qty</label>
            <TextInput id="add-combatant-count" type="number" min={1} max={50} aria-label="Quantity — adds this many, auto-numbered" value={manualCount} onChange={(e) => setManualCount(e.target.value)} />
          </div>
          <Btn type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Adding…' : 'Add'}
          </Btn>
        </form>
      )}

      {tab === 'compendium' && (
        <div className="space-y-2">
          <TextInput
            aria-label="Search monsters in the compendium"
            placeholder="Search monsters…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {/* Quantity + optional name override for the next pick (issue #114): adding
              N monsters auto-numbers them "Goblin 1".."Goblin N" so they're distinguishable. */}
          <div className="flex gap-2 flex-wrap items-end">
            <div className="field" style={{ width: 70 }}>
              <label htmlFor="comp-count">Qty</label>
              <TextInput id="comp-count" type="number" min={1} max={50} aria-label="Quantity to add" value={compCount} onChange={(e) => setCompCount(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 140 }}>
              <label htmlFor="comp-name-override">Name override (optional)</label>
              <TextInput id="comp-name-override" placeholder="Leave blank to use statblock name" value={nameOverride} onChange={(e) => setNameOverride(e.target.value)} />
            </div>
          </div>
          {searching ? (
            <Skeleton lines={2} />
          ) : results.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 12 }}>
              {query.trim() ? 'No matches.' : 'Start typing to search the compendium.'}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {results.map((entry) => (
                <button
                  key={entry.id}
                  className="card elev-sm"
                  style={{
                    border: 0,
                    font: 'inherit',
                    color: 'var(--color-text)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 12px',
                  }}
                  disabled={saving}
                  onClick={() => addFromCompendium(entry)}
                >
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{entry.name}</span>
                  <span className="tag tag-neutral">
                    monster
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'party' && (
        <div className="space-y-1.5">
          {(() => {
            const available = characters.filter((c) => !existingCombatantCharacterIds.has(c.id));
            if (characters.length === 0) {
              return (
                <p className="text-muted" style={{ fontSize: 12 }}>
                  No characters in this campaign yet.
                </p>
              );
            }
            if (available.length === 0) {
              return (
                <p className="text-muted" style={{ fontSize: 12 }}>
                  The whole party is already in this encounter.
                </p>
              );
            }
            return available.map((c) => (
              <button
                key={c.id}
                className="card elev-sm"
                style={{
                  border: 0,
                  font: 'inherit',
                  color: 'var(--color-text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 12px',
                  width: '100%',
                }}
                disabled={saving}
                onClick={() => addFromParty(c)}
              >
                <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{c.name}</span>
                <span className="text-muted" style={{ fontSize: 'var(--type-meta)' }}>
                  {c.hpCurrent}/{c.hpMax}
                </span>
              </button>
            ));
          })()}
        </div>
      )}

      {tab === 'npc' && (
        <div className="space-y-2">
          {npcs.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 12 }}>
              No NPCs in this campaign yet — create one on the NPCs page.
            </p>
          ) : (
            <>
              <div className="field">
                <label htmlFor="npc-select">NPC</label>
                <select
                  id="npc-select"
                  className="cf-select"
                  value={selectedNpcId}
                  onChange={(e) => setSelectedNpcId(e.target.value)}
                >
                  <option value="">Choose an NPC…</option>
                  {npcs.map((n) => (
                    <option key={n.id} value={String(n.id)}>
                      {n.name}
                      {n.role ? ` — ${n.role}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <form onSubmit={(e) => { e.preventDefault(); void addFromNpc(); }} className="flex gap-2 flex-wrap items-end">
                <div className="field" style={{ width: 80 }}>
                  <label htmlFor="npc-hp">HP</label>
                  <TextInput id="npc-hp" aria-label="Max HP" placeholder="22" value={npcHp} onChange={(e) => setNpcHp(e.target.value)} />
                </div>
                <div className="field" style={{ width: 80 }}>
                  <label htmlFor="npc-init">Init mod</label>
                  <TextInput id="npc-init" aria-label="Initiative modifier" placeholder="2" value={npcInit} onChange={(e) => setNpcInit(e.target.value)} />
                </div>
                <Btn type="submit" disabled={saving || !selectedNpcId}>
                  {saving ? 'Adding…' : 'Add NPC'}
                </Btn>
              </form>
              <div className="hr" style={{ margin: '4px 0' }} />
              <p className="text-muted reading-supporting">
                …or give it a statblock — search the compendium and pick one (its HP is used):
              </p>
              <TextInput
                aria-label="Search monster statblocks for this NPC"
                placeholder="Search statblocks…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {searching ? (
                <Skeleton lines={2} />
              ) : results.length === 0 ? (
                <p className="text-muted" style={{ fontSize: 12 }}>
                  {query.trim() ? 'No matches.' : 'Optional — leave blank to add with manual HP above.'}
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {results.map((entry) => (
                    <button
                      key={entry.id}
                      className="card elev-sm"
                      style={{
                        border: 0,
                        font: 'inherit',
                        color: 'var(--color-text)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                      }}
                      disabled={saving || !selectedNpcId}
                      title={!selectedNpcId ? 'Choose an NPC first' : `Add ${entry.name}'s statblock to the selected NPC`}
                      onClick={() => void addFromNpc(entry)}
                    >
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{entry.name}</span>
                      <span className="tag tag-neutral">
                        statblock
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// DiceLog moved to features/dice/SharedDiceLog — rolls are now persisted
// server-side and shared by the whole table (issue #35).
