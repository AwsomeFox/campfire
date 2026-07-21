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
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  Attachment,
  Character,
  Combatant,
  CombatantKind,
  DifficultyBand,
  EncounterDifficulty,
  EncounterEvent,
  EncounterWithCombatants,
  FogState,
  RuleEntry,
  TokenSize,
} from '@campfire/schema';
import { ruleSystemAdapter } from '@campfire/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API, ApiError } from '../../lib/api';
import { queryKeys, invalidateEncounter } from '../../lib/query';
import { useCampaignEvents } from '../../lib/useCampaignEvents';
import { useAuth } from '../../app/auth';
import { useCampaign } from '../../app/CampaignContext';
import { SharedDiceLog } from '../dice/SharedDiceLog';
import { StatBlock, hasMonsterStatblock } from '../../components/StatBlock';
import { Card, Btn, TextInput, HpBar, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { ImageUpload, MapUploadButton, attachmentFileUrl, uploadAttachment } from '../../components/ImageUpload';
import { NotFoundState } from '../../components/NotFoundState';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useAnnounce } from '../../components/Announcer';

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

// 5e difficulty band badge (issue #58) — party XP thresholds vs adjusted monster XP.
const DIFFICULTY_LABEL: Record<DifficultyBand, string> = {
  trivial: 'Trivial',
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  deadly: 'Deadly',
};
// Inline band colors — no `tag-danger` class exists in nocturne.css, and difficulty
// wants a green→red ramp distinct from the accent-colored status chips.
const DIFFICULTY_STYLE: Record<DifficultyBand, { background: string; color: string }> = {
  trivial: { background: 'var(--color-neutral-800)', color: 'var(--color-neutral-100)' },
  easy: { background: '#14532d', color: '#bbf7d0' },
  medium: { background: '#713f12', color: '#fde68a' },
  hard: { background: '#7c2d12', color: '#fed7aa' },
  deadly: { background: '#7f1d1d', color: '#fecaca' },
};

/**
 * Difficulty badge shown in the encounter header (issue #58). Reads the computed
 * Easy/Medium/Hard/Deadly band from GET /encounters/:id/difficulty. Hidden when there
 * are no monsters to score (band trivial + no monster XP) so a prep-only party list
 * doesn't show a misleading "Trivial" chip. `title` surfaces the underlying XP math.
 */
function DifficultyBadge({ difficulty }: { difficulty: EncounterDifficulty | null }) {
  if (!difficulty) return null;
  if (difficulty.monsterCount === 0) return null;
  const title =
    `Adjusted monster XP ${difficulty.adjustedXp.toLocaleString()} ` +
    `(${difficulty.totalMonsterXp.toLocaleString()} × ${difficulty.multiplier}) vs party thresholds — ` +
    `easy ${difficulty.thresholds.easy.toLocaleString()}, medium ${difficulty.thresholds.medium.toLocaleString()}, ` +
    `hard ${difficulty.thresholds.hard.toLocaleString()}, deadly ${difficulty.thresholds.deadly.toLocaleString()}`;
  return (
    <span className="tag" style={{ fontSize: 10, ...DIFFICULTY_STYLE[difficulty.band] }} title={title}>
      ⚔ {DIFFICULTY_LABEL[difficulty.band]}
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing || (locations.length || quests.length || sessions.length)) return;
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
    });
    return () => {
      cancelled = true;
    };
  }, [editing, campaignId, locations.length, quests.length, sessions.length]);

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

  const hasLink = encounter.locationId != null || encounter.questId != null || encounter.sessionId != null;
  if (!canEdit && !hasLink) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 11 }}>
      {encounter.locationId != null && (
        <span className="tag tag-outline" style={{ fontSize: 10 }}>
          🗺 {locName ? linkLabel('location', locName) : `Location #${encounter.locationId}`}
        </span>
      )}
      {encounter.questId != null && (
        <span className="tag tag-outline" style={{ fontSize: 10 }}>
          📜 {questName ? linkLabel('quest', questName) : `Quest #${encounter.questId}`}
        </span>
      )}
      {encounter.sessionId != null && (
        <span className="tag tag-outline" style={{ fontSize: 10 }}>
          📓 {sessName ? linkLabel('session', sessName) : `Session #${encounter.sessionId}`}
        </span>
      )}
      {!hasLink && canEdit && !editing && <span className="text-muted">No location / quest / session linked.</span>}
      {canEdit && (
        <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setEditing((v) => !v)}>
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
            <option value="">🗺 — no location —</option>
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
            <option value="">📜 — no quest —</option>
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
            <option value="">📓 — no session —</option>
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
 */
function DeathSaveTracker({
  successes,
  failures,
  canEdit,
  busy,
  onSet,
}: {
  successes: number;
  failures: number;
  canEdit: boolean;
  busy: boolean;
  onSet: (patch: { deathSaveSuccesses?: number; deathSaveFailures?: number }) => void;
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
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 5, fontSize: 10, flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
        <span className="text-muted" style={{ letterSpacing: 0.3 }}>Saves</span>
        <Pips kind="deathSaveSuccesses" count={successes} color="var(--color-accent)" />
      </span>
      <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
        <span className="text-muted" style={{ letterSpacing: 0.3 }}>Fails</span>
        <Pips kind="deathSaveFailures" count={failures} color="#e5484d" />
      </span>
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

  const [actionError, setActionError] = useState<string | null>(null);
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
  // scoped to only their own character's combatant. Low-churn, so no poll.
  const charactersQuery = useQuery({
    queryKey: queryKeys.campaignCharacters(cid),
    queryFn: () => api.get<Character[]>(`${API}/campaigns/${cid}/characters`),
    enabled: Number.isFinite(cid),
  });
  const characters = useMemo(() => charactersQuery.data ?? [], [charactersQuery.data]);

  const notFound = encounterQuery.error instanceof ApiError && encounterQuery.error.status === 404;
  const loadError =
    encounterQuery.error && !notFound
      ? encounterQuery.error instanceof ApiError
        ? encounterQuery.error.message
        : "Couldn't load this encounter."
      : null;
  const refetchEncounter = useCallback(() => invalidateEncounter(queryClient, eid), [queryClient, eid]);

  // Live updates over SSE (issue #4) — players waiting for the DM to hit "Start" (or
  // take a turn, adjust HP, …) see it pushed instantly. Rather than a manual reload, an
  // event just invalidates the encounter's reads and Query refetches. On a remote delete,
  // bounce back to the encounters list rather than surfacing a 404.
  useCampaignEvents(Number.isFinite(cid) ? cid : undefined, {
    onEvent: useCallback(
      (event) => {
        if (event.encounterId !== eid) return;
        if (event.type === 'encounter.deleted') {
          navigate(`/c/${cid}/encounters`);
          return;
        }
        invalidateEncounter(queryClient, eid);
      },
      [eid, cid, navigate, queryClient],
    ),
    // The stream was down for a while — refetch to catch anything missed.
    onReconnect: useCallback(() => invalidateEncounter(queryClient, eid), [queryClient, eid]),
  });

  // Announce turn/round changes and HP mutations for screen readers (issue #93).
  // Diffing the encounter (rather than hooking each action) covers every source —
  // own edits, other members' edits, and SSE-pushed updates — with one code path.
  const prevAnnounceRef = useRef<{ hp: Map<number, number | null>; turnKey: string } | null>(null);
  useEffect(() => {
    if (!encounter) return;
    const currentId = encounter.status === 'running' ? encounter.currentCombatantId ?? null : null;
    const turnKey =
      encounter.status === 'running' ? `${encounter.round}:${currentId}` : encounter.status;
    const hp = new Map(encounter.combatants.map((c) => [c.id, c.hpCurrent]));
    const prev = prevAnnounceRef.current;

    if (prev) {
      if (turnKey !== prev.turnKey) {
        if (encounter.status === 'running') {
          const current = encounter.combatants.find((c) => c.id === currentId);
          announce(`Round ${encounter.round}${current ? ` — ${current.name}'s turn` : ''}`);
        } else if (encounter.status === 'ended') {
          announce('Encounter ended');
        }
      }
      for (const c of encounter.combatants) {
        const before = prev.hp.get(c.id);
        // Only announce concrete HP changes — skip when either value is null
        // (a monster whose exact HP is redacted from this viewer, issue #43).
        if (before != null && c.hpCurrent != null && before !== c.hpCurrent) {
          announce(`${c.name}: ${c.hpCurrent} of ${c.hpMax} hit points`);
        }
      }
    }
    prevAnnounceRef.current = { hp, turnKey };
  }, [encounter, announce]);

  const myUserId = me?.user.id;
  const ownedCharacterIds = useMemo(
    () =>
      new Set(
        characters.filter((c) => c.ownerUserId != null && myUserId != null && c.ownerUserId === String(myUserId)).map((c) => c.id),
      ),
    [characters, myUserId],
  );

  function canEditCombatant(c: Combatant): boolean {
    if (isDm) return true;
    if (role !== 'player') return false;
    return c.characterId != null && ownedCharacterIds.has(c.characterId);
  }

  const reportError = useCallback(
    (err: unknown) => setActionError(err instanceof ApiError ? err.message : 'That action failed.'),
    [],
  );

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

  const rollInitiative = () => runControl.mutate('roll-initiative');
  const startEncounter = () => runControl.mutate('start');
  const nextTurn = () => runControl.mutate('next-turn');
  const endEncounter = () => runControl.mutate('end', { onSuccess: () => setConfirmEnd(false) });
  const reopenEncounter = () => runControl.mutate('reopen', { onSuccess: () => setConfirmReopen(false) });
  const deleteEncounter = () => deleteEncounterMut.mutate();

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
  const setMap = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`${API}/encounters/${eid}`, patch),
    onMutate: () => setActionError(null),
    onError: reportError,
    onSettled: () => invalidateEncounter(queryClient, eid),
  });
  const setEncounterMap = (attachmentId: number | null) => setMap.mutate({ mapAttachmentId: attachmentId });
  // Grid config (issue #40, phase 2) — any subset of gridSize/gridScale/gridUnit/gridSnap.
  const setEncounterGrid = (patch: Partial<Pick<EncounterWithCombatants, 'gridSize' | 'gridScale' | 'gridUnit' | 'gridSnap'>>) => setMap.mutate(patch);
  // Fog of war (issue #40, phase 3) — replace the whole fog state (null clears it).
  const setEncounterFog = (fog: FogState | null) => setMap.mutate({ fog });

  // Move a combatant's token on the battle map. The server clamps to 0–100 and gates on
  // role (DM moves any; a player only their own character's token).
  const moveToken = (combatantId: number, x: number, y: number) => patchCombatant(combatantId, { tokenX: x, tokenY: y });
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

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <div>
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => navigate(`/c/${cid}/encounters`)}>
          ← Back
        </Btn>
      </div>

      {(loadError || actionError) && (
        <ErrorNote
          message={actionError ?? loadError ?? ''}
          onRetry={() => {
            setActionError(null);
            refetchEncounter();
          }}
        />
      )}

      <div className="flex items-center gap-2.5 flex-wrap">
        <h1 className="text-2xl font-extrabold text-white m-0 min-w-0 break-words">{encounter.name}</h1>
        <span className={STATUS_TAG_CLASS[encounter.status]} style={{ fontSize: 10 }}>
          {STATUS_LABEL[encounter.status]}
        </span>
        {encounter.status === 'running' && (
          <span className="tag tag-neutral" style={{ fontSize: 10 }}>
            Round {encounter.round}
          </span>
        )}
        <DifficultyBadge difficulty={difficulty} />
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 11.5 }}
          onClick={refetchEncounter}
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
              📺 Cast
            </Btn>
            {encounter.status === 'preparing' && (
              <>
                <Btn ghost disabled={headerBusy} onClick={rollInitiative}>
                  Roll initiative
                </Btn>
                <Btn disabled={headerBusy} onClick={startEncounter}>
                  Start
                </Btn>
              </>
            )}
            {encounter.status === 'running' && (
              <>
                {/* Reinforcements added mid-fight land at null initiative and sort last —
                    keep Roll initiative reachable so the DM can fill them (issue #54).
                    Already-set initiatives are left untouched server-side. */}
                <Btn ghost disabled={headerBusy} onClick={rollInitiative}>
                  Roll initiative
                </Btn>
                <Btn disabled={headerBusy} onClick={nextTurn}>
                  Next turn →
                </Btn>
              </>
            )}
            {encounter.status !== 'ended' && (
              <Btn ghost danger disabled={headerBusy} onClick={() => setConfirmEnd(true)}>
                End
              </Btn>
            )}
            {encounter.status === 'ended' && (
              <Btn ghost disabled={headerBusy} onClick={() => setConfirmReopen(true)}>
                Reopen
              </Btn>
            )}
            {(encounter.status === 'ended' || encounter.status === 'preparing') && (
              <Btn ghost danger disabled={headerBusy} onClick={() => setConfirmDelete(true)}>
                Delete
              </Btn>
            )}
          </div>
        )}
      </div>

      {encounter.status === 'ended' && <EndedSummary encounter={encounter} />}

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

      {isDm && encounter.status === 'preparing' && (
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
          Add the party &amp; monsters below, roll initiative, then hit Start.
        </p>
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
          onSetGrid={setEncounterGrid}
          onSetFog={setEncounterFog}
          onError={setActionError}
        />
      )}

      <div className="card elev-sm" style={{ padding: '6px 0', gap: 0 }}>
        {orderedCombatants.length === 0 ? (
          <div style={{ padding: 16 }}>
            <EmptyState icon="⚔️" title="No combatants yet" hint={isDm ? 'Add one below.' : 'Waiting on the DM.'} />
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
              busy={pendingCombatantIds.has(c.id)}
              conditionSuggestions={conditionSuggestions}
              ruleSystem={ruleSystem}
              onHpDelta={(delta) => hpDelta.mutate({ combatantId: c.id, delta })}
              onSetTempHp={(value) => patchCombatant(c.id, { hpTemp: value })}
              onSetDeathSaves={(patch) => patchCombatant(c.id, patch)}
              onSetInitiative={(value) => patchCombatant(c.id, { initiative: value })}
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
          body="HP writes back to character sheets. This cannot be undone."
          confirmLabel={runControl.isPending ? 'Ending…' : 'End encounter'}
          busy={runControl.isPending}
          onConfirm={endEncounter}
          onCancel={() => setConfirmEnd(false)}
        />
      )}
      {confirmReopen && (
        <ConfirmDialog
          title="Reopen this encounter?"
          body="It returns to Running where combat left off. HP was written back to character sheets when it ended; it will write back again the next time you End."
          confirmLabel={runControl.isPending ? 'Reopening…' : 'Reopen encounter'}
          busy={runControl.isPending}
          onConfirm={reopenEncounter}
          onCancel={() => setConfirmReopen(false)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this encounter?"
          body="This cannot be undone."
          confirmLabel={deleteEncounterMut.isPending ? 'Deleting…' : 'Delete encounter'}
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

/** Two-letter token initials from a combatant name ("Ashen cultist" -> "AC", "Goblin 1" -> "G1"). */
function tokenInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

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

type MapTool = 'move' | 'measure' | 'reveal';

/**
 * Battle map (issue #39 + VTT phases 2–3, issue #40): a DM-uploaded image rendered as the
 * encounter background with combatant tokens overlaid at combatant.tokenX/tokenY (0–100
 * percent). On top of the #39 token drag it adds:
 *  - a configurable square grid overlay (DM sets cell size / scale / unit / snap),
 *  - a click-drag measurement ruler that reads out distance in squares + feet,
 *  - per-token size footprints (tiny→gargantuan) via combatant.tokenSize,
 *  - fog of war: the DM reveals rectangular regions; players see only revealed area, and
 *    the server additionally withholds token positions in the dark (redaction-safe),
 *  - a simple, client-only circular AoE template for visualising a spell's radius.
 * Grid config and fog are DM-only PATCHes to the encounter; every change rides the existing
 * SSE `encounter.updated` signal so other clients update live (the poll is the backstop).
 * DM may move any token; a player only their own character's (canMoveToken).
 */
function BattleMap({
  encounter,
  campaignId,
  isDm,
  busy,
  canMoveToken,
  onSetMap,
  onMoveToken,
  onSetGrid,
  onSetFog,
  onError,
}: {
  encounter: EncounterWithCombatants;
  campaignId: number;
  isDm: boolean;
  busy: boolean;
  canMoveToken: (c: Combatant) => boolean;
  onSetMap: (attachmentId: number | null) => void;
  onMoveToken: (combatantId: number, x: number, y: number) => void;
  onSetGrid: (patch: Partial<Pick<EncounterWithCombatants, 'gridSize' | 'gridScale' | 'gridUnit' | 'gridSnap'>>) => void;
  onSetFog: (fog: FogState | null) => void;
  onError: (message: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<MapTool>('move');
  const [ruler, setRuler] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  const [revealCorners, setRevealCorners] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  const [gridPanelOpen, setGridPanelOpen] = useState(false);
  const [aoe, setAoe] = useState<{ x: number; y: number; radiusFt: number } | null>(null);
  const [aoeDragging, setAoeDragging] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { w: surfaceW, h: surfaceH } = useElementSize(surfaceRef);

  const mapImageUrl = encounter.mapAttachmentId != null ? attachmentFileUrl(encounter.mapAttachmentId) : null;
  const placed = encounter.combatants.filter((c) => c.tokenX != null && c.tokenY != null);
  const unplaced = encounter.combatants.filter((c) => c.tokenX == null || c.tokenY == null);

  const gridSize = encounter.gridSize; // cell edge as % of width; null = no grid
  const gridScale = encounter.gridScale;
  const gridUnit = encounter.gridUnit || 'ft';
  const gridOn = gridSize != null && gridSize > 0;
  // One cell in rendered pixels — cells are square in pixels regardless of the 16:9 surface.
  const cellPx = gridOn && surfaceW > 0 ? (gridSize! / 100) * surfaceW : 0;
  // Distance readout needs both a cell size (px) and a real-world scale.
  const canMeasure = gridOn && gridScale != null && gridScale > 0 && cellPx > 0;
  const canAoe = canMeasure; // AoE radius is expressed in feet, so it needs the scale too.

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

  function pointerToPercent(e: ReactPointerEvent): { x: number; y: number } | null {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    return { x: clampPct(x), y: clampPct(y) };
  }

  /** Snap a drop point to the nearest cell centre when the grid + snap are on (issue #40). */
  function snapPoint(pt: { x: number; y: number }): { x: number; y: number } {
    if (!gridOn || !encounter.gridSnap || cellPx <= 0 || surfaceW === 0 || surfaceH === 0) return pt;
    const px = (pt.x / 100) * surfaceW;
    const py = (pt.y / 100) * surfaceH;
    const sx = (Math.floor(px / cellPx) + 0.5) * cellPx;
    const sy = (Math.floor(py / cellPx) + 0.5) * cellPx;
    return { x: clampPct((sx / surfaceW) * 100), y: clampPct((sy / surfaceH) * 100) };
  }

  function onTokenPointerDown(e: ReactPointerEvent<HTMLDivElement>, c: Combatant) {
    if (tool !== 'move' || !mapImageUrl || !canMoveToken(c)) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDraggingId(c.id);
    setDragPos(pointerToPercent(e));
  }

  function onSurfacePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const pct = pointerToPercent(e);
    if (!pct) return;
    if (tool === 'measure' && canMeasure) {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      setRuler({ start: pct, end: pct });
    } else if (tool === 'reveal' && isDm) {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      setRevealCorners({ start: pct, end: pct });
    }
  }

  function onSurfacePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (draggingId != null) {
      const pct = pointerToPercent(e);
      if (pct) setDragPos(pct);
      return;
    }
    if (aoeDragging) {
      const pct = pointerToPercent(e);
      if (pct) setAoe((prev) => (prev ? { ...prev, x: pct.x, y: pct.y } : prev));
      return;
    }
    if (ruler) {
      const pct = pointerToPercent(e);
      if (pct) setRuler((prev) => (prev ? { ...prev, end: pct } : prev));
      return;
    }
    if (revealCorners) {
      const pct = pointerToPercent(e);
      if (pct) setRevealCorners((prev) => (prev ? { ...prev, end: pct } : prev));
    }
  }

  function onSurfacePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (draggingId != null) {
      const raw = pointerToPercent(e) ?? dragPos;
      const id = draggingId;
      setDraggingId(null);
      setDragPos(null);
      if (raw) {
        const pt = snapPoint(raw);
        onMoveToken(id, pt.x, pt.y);
      }
      return;
    }
    if (aoeDragging) {
      setAoeDragging(false);
      return;
    }
    if (revealCorners) {
      const rect = rectFromCorners(revealCorners.start, revealCorners.end);
      setRevealCorners(null);
      // Ignore an accidental micro-drag (a click) — a real reveal has some area.
      if (rect.w >= 1 && rect.h >= 1) {
        const next: FogState = { enabled: true, revealed: [...(fog?.revealed ?? []), rect].slice(-500) };
        onSetFog(next);
      }
      return;
    }
    // A ruler stays on screen after release so the readout can be read; it clears when the
    // next measurement starts, the tool changes, or move mode is re-entered.
  }

  function onAoePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setAoeDragging(true);
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
  const aoeRadiusPx = aoe && canAoe ? (aoe.radiusFt / gridScale!) * cellPx : 0;

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
    <div className="card elev-sm" style={{ padding: 0, overflow: 'hidden' }}>
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
        </div>
      )}

      {mapImageUrl && (
        <>
          {/* Toolbar: interaction mode + (DM) grid & fog controls + AoE template. */}
          <div className="flex flex-wrap gap-2 items-center" style={{ padding: '8px 14px 0' }}>
            {modeBtn('move', 'Move')}
            {modeBtn('measure', 'Measure', !canMeasure, canMeasure ? 'Click-drag to measure' : 'Set a grid scale first')}
            {isDm && modeBtn('reveal', 'Reveal', undefined, 'Click-drag to reveal a fog region')}
            {canAoe && (
              <button
                type="button"
                className="cf-chip"
                onClick={() => setAoe((prev) => (prev ? null : { x: 50, y: 50, radiusFt: gridScale! * 2 }))}
                title="Toggle a circular AoE template"
                style={{ cursor: 'pointer', borderColor: aoe ? 'var(--color-accent)' : 'var(--color-divider)', color: aoe ? 'var(--color-accent)' : undefined }}
              >
                AoE
              </button>
            )}
            {aoe && canAoe && (
              <label className="flex items-center gap-1 text-muted" style={{ fontSize: 11 }}>
                radius
                <input
                  type="number"
                  min={0}
                  step={gridScale ?? 5}
                  value={aoe.radiusFt}
                  onChange={(e) => setAoe((prev) => (prev ? { ...prev, radiusFt: Math.max(0, Number(e.target.value) || 0) } : prev))}
                  style={{ width: 56 }}
                />
                {gridUnit}
              </label>
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

          {isDm && gridPanelOpen && (
            <div
              className="flex flex-wrap gap-3 items-center"
              style={{ padding: '10px 14px', margin: '8px 14px 0', border: '1px solid var(--color-divider)', borderRadius: 8, fontSize: 12 }}
            >
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={gridOn}
                  onChange={(e) => onSetGrid({ gridSize: e.target.checked ? (gridSize ?? 8) : null })}
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
            className="relative overflow-hidden"
            style={{
              margin: '8px 14px',
              aspectRatio: '16 / 9',
              touchAction: tool !== 'move' || draggingId != null || aoeDragging ? 'none' : undefined,
              cursor: tool === 'measure' ? 'crosshair' : tool === 'reveal' ? 'cell' : undefined,
            }}
            onPointerDown={onSurfacePointerDown}
            onPointerMove={onSurfacePointerMove}
            onPointerUp={onSurfacePointerUp}
          >
            <img src={mapImageUrl} alt="Battle map" className="absolute inset-0 w-full h-full object-contain" style={{ background: 'rgba(15,23,42,.4)' }} />

            {/* Grid overlay (issue #40) — square cells sized in pixels off the measured surface. */}
            {gridOn && cellPx > 1 && (
              <div
                className="absolute inset-0"
                style={{
                  pointerEvents: 'none',
                  backgroundImage:
                    `repeating-linear-gradient(to right, rgba(148,163,184,.35) 0 1px, transparent 1px ${cellPx}px),` +
                    `repeating-linear-gradient(to bottom, rgba(148,163,184,.35) 0 1px, transparent 1px ${cellPx}px)`,
                }}
              />
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
                </div>
              );
            })}

            {/* AoE template (issue #40) — client-only circle for visualising a spell radius. */}
            {aoe && canAoe && aoeRadiusPx > 0 && (
              <div
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{
                  left: `${aoe.x}%`,
                  top: `${aoe.y}%`,
                  width: aoeRadiusPx * 2,
                  height: aoeRadiusPx * 2,
                  borderRadius: '50%',
                  background: 'rgba(239,68,68,.22)',
                  border: '2px solid rgba(239,68,68,.75)',
                  cursor: 'grab',
                  touchAction: 'none',
                  zIndex: 6,
                }}
                onPointerDown={onAoePointerDown}
                title={`AoE · ${aoe.radiusFt} ${gridUnit} radius`}
              />
            )}

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
                : isDm
                  ? 'Drag a token to move it. Click an unplaced token to drop it on the map.'
                  : 'Drag your own token to move it.'}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CombatantRow({
  combatant,
  isCurrentTurn,
  canEdit,
  canEditIdentity,
  canViewStatblock,
  canRemove,
  canSetInitiative,
  busy,
  conditionSuggestions,
  ruleSystem,
  onHpDelta,
  onSetTempHp,
  onSetDeathSaves,
  onSetInitiative,
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
  busy: boolean;
  /** Condition chips offered by the active campaign's rule-system adapter (issue #234). */
  conditionSuggestions: readonly string[];
  /** Active campaign's rule system — selects the statblock adapter (issue #234). */
  ruleSystem: string | null;
  onHpDelta: (delta: number) => void;
  onSetTempHp: (value: number) => void;
  onSetDeathSaves: (patch: { deathSaveSuccesses?: number; deathSaveFailures?: number }) => void;
  onSetInitiative: (value: number) => void;
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
    if (trimmed === '') return; // empty = leave as-is (can't clear back to null from the UI)
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value === combatant.initiative) return;
    onSetInitiative(value);
  }

  const edgeColor = isCurrentTurn ? 'var(--color-accent)' : 'transparent';
  const kindTagClass = combatant.kind === 'character' ? 'tag tag-accent' : 'tag tag-neutral';
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
              <label htmlFor={`rename-${combatant.id}`} style={{ fontSize: 10 }}>Name</label>
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
              <label htmlFor={`hpmax-${combatant.id}`} style={{ fontSize: 10 }}>Max HP</label>
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
              <label htmlFor={`tokensize-${combatant.id}`} style={{ fontSize: 10 }}>Token size</label>
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
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => { setEditingIdentity(false); setNameDraft(combatant.name); setHpMaxDraft(combatant.hpMax?.toString() ?? ''); }}>Cancel</button>
          </div>
        ) : (
          <div style={{ fontSize: 14, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={down ? { textDecoration: 'line-through' } : undefined}>
              {down && <span aria-hidden="true" style={{ marginRight: 5 }}>💀</span>}
              {combatant.name}
            </span>
            <span className={kindTagClass} style={{ fontSize: 9 }}>
              {combatant.kind}
            </span>
            {combatant.deathState !== 'none' && combatant.deathState !== undefined ? (
              <span className="tag tag-outline" style={{ fontSize: 9 }}>
                {DEATH_STATE_LABEL[combatant.deathState] ?? 'Down'}
              </span>
            ) : (
              down && (
                <span className="tag tag-outline" style={{ fontSize: 9 }}>
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
                style={{ fontSize: 10, minHeight: 20, padding: '1px 6px' }}
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
            />
          )}
        {combatant.conditions.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            {combatant.conditions.map((cond) => (
              <span key={cond} className="tag tag-outline" style={{ fontSize: 9.5, gap: 6 }}>
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
                    style={{ fontSize: 10.5, border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)', minHeight: 24, padding: '2px 8px' }}
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
                  style={{ fontSize: 10.5, minHeight: 24, padding: '2px 8px' }}
                  onClick={() => setAddingCondition(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="btn btn-ghost"
                style={{ fontSize: 10.5, border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)', minHeight: 24, padding: '2px 8px' }}
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
      </div>
      <div style={{ minWidth: 130, flex: 'none' }}>
        {combatant.hpCurrent != null && combatant.hpMax != null ? (
          <>
            <div style={{ fontSize: 12.5, textAlign: 'right', marginBottom: 3, display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'baseline' }}>
              {combatant.hpTemp != null && combatant.hpTemp > 0 && (
                <span className="tag tag-accent" style={{ fontSize: 9 }} title="Temporary HP — absorbs damage first">
                  🛡 {combatant.hpTemp}
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
                fontSize: 11,
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
        style={{ fontSize: 10.5, minHeight: 24, padding: '2px 8px', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
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
  damage: '⚔️',
  heal: '✨',
  condition: '🌀',
  death: '💀',
  turn: '⏱️',
  roll: '🎲',
  note: '📝',
};

/**
 * Persistent per-encounter combat log (issue #61). Renders the server-stored event
 * trail (damage/heal, conditions, deaths, turns) in chronological order — it survives
 * reload and updates live with the rest of the tracker. Scrollable so a long fight
 * doesn't push the page down.
 */
function CombatLog({ events }: { events: EncounterEvent[] }) {
  return (
    <Card className="space-y-2">
      <span className="card-kicker">Combat log</span>
      {events.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
          Nothing yet — damage, conditions, deaths and turns will show here as the fight unfolds.
        </p>
      ) : (
        <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {events.map((ev) => (
            <div key={ev.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, lineHeight: 1.4 }}>
              <span aria-hidden="true" style={{ flex: 'none' }}>
                {EVENT_ICON[ev.type] ?? '•'}
              </span>
              {ev.round > 0 && (
                <span className="tag tag-neutral" style={{ fontSize: 9, flex: 'none' }}>
                  R{ev.round}
                </span>
              )}
              <span style={{ minWidth: 0 }}>
                {ev.type === 'turn' ? (
                  <span>{ev.detail}</span>
                ) : (
                  <>
                    {ev.target && <span style={{ fontWeight: 600 }}>{ev.target}</span>}{' '}
                    <span className="text-muted" style={{ color: 'var(--color-text)' }}>
                      {ev.detail}
                    </span>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
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

// ---------------------------------------------------------------------------

type AddTab = 'manual' | 'compendium' | 'party';

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

  /** Clamp a free-text quantity field to a sane 1–50, defaulting to 1. */
  function parseCount(raw: string): number {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(50, n);
  }

  useEffect(() => {
    if (tab !== 'compendium' || !debouncedQuery.trim()) {
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

  return (
    <Card className="space-y-3">
      <span className="card-kicker">Add combatant</span>
      <div className="seg self-start inline-flex">
        {(['manual', 'compendium', 'party'] as AddTab[]).map((t) => (
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
            {t === 'manual' ? 'Manual' : t === 'compendium' ? 'Compendium' : 'Party'}
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
                  <span className="tag tag-neutral" style={{ fontSize: 9.5 }}>
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
                <span className="text-muted" style={{ fontSize: 11 }}>
                  {c.hpCurrent}/{c.hpMax}
                </span>
              </button>
            ));
          })()}
        </div>
      )}
    </Card>
  );
}

// DiceLog moved to features/dice/SharedDiceLog — rolls are now persisted
// server-side and shared by the whole table (issue #35).
