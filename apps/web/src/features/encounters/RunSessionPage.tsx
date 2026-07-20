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
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  Character,
  Combatant,
  CombatantKind,
  EncounterWithCombatants,
  RuleEntry,
} from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useCampaignEvents } from '../../lib/useCampaignEvents';
import { useAuth } from '../../app/auth';
import { useCampaign } from '../../app/CampaignContext';
import { SharedDiceLog } from '../dice/SharedDiceLog';
import { Card, Btn, TextInput, HpBar, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
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

const CONDITION_SUGGESTIONS = ['Poisoned', 'Prone', 'Restrained', 'Stunned', 'Grappled', 'Blinded', 'Frightened'];

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

  const [encounter, setEncounter] = useState<EncounterWithCombatants | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Mirrors `busy` but updates synchronously (state updates are batched/async in React,
  // so a rapid double-click on e.g. the HP +/- steppers could fire twice before the
  // first setBusy(true) re-render lands). withBusy checks+sets this ref before anything
  // async happens, closing that race.
  const busyRef = useRef(false);

  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemoveCombatantId, setConfirmRemoveCombatantId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setNotFound(false);
    try {
      const data = await api.get<EncounterWithCombatants>(`${API}/encounters/${eid}`);
      setEncounter(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't load this encounter.");
      }
    } finally {
      setLoading(false);
    }
  }, [eid]);

  useEffect(() => {
    if (Number.isFinite(eid)) void load();
  }, [eid, load]);

  // Fetch campaign characters once, to map a combatant.characterId -> ownerUserId
  // so players can be scoped to only their own character's combatant.
  useEffect(() => {
    if (!Number.isFinite(cid)) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<Character[]>(`${API}/campaigns/${cid}/characters`);
        if (!cancelled) setCharacters(list);
      } catch {
        if (!cancelled) setCharacters([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cid]);

  // Live updates over SSE (replaces the old 5s poll) — players waiting for the DM to
  // hit "Start" (or take a turn, adjust HP, …) see it pushed instantly. On a remote
  // delete, bounce back to the encounters list rather than surfacing a 404.
  useCampaignEvents(Number.isFinite(cid) ? cid : undefined, {
    onEvent: useCallback(
      (event) => {
        if (event.encounterId !== eid) return;
        if (event.type === 'encounter.deleted') {
          navigate(`/c/${cid}/encounters`);
          return;
        }
        void load();
      },
      [eid, cid, navigate, load],
    ),
    // The stream was down for a while — refetch to catch anything missed.
    onReconnect: useCallback(() => void load(), [load]),
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

  async function withBusy(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'That action failed.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function rollInitiative() {
    await withBusy(async () => {
      await api.post(`${API}/encounters/${eid}/roll-initiative`);
      await load();
    });
  }

  async function startEncounter() {
    await withBusy(async () => {
      await api.post(`${API}/encounters/${eid}/start`);
      await load();
    });
  }

  async function nextTurn() {
    await withBusy(async () => {
      await api.post(`${API}/encounters/${eid}/next-turn`);
      await load();
    });
  }

  async function endEncounter() {
    await withBusy(async () => {
      await api.post(`${API}/encounters/${eid}/end`);
      setConfirmEnd(false);
      await load();
    });
  }

  async function reopenEncounter() {
    await withBusy(async () => {
      await api.post(`${API}/encounters/${eid}/reopen`);
      setConfirmReopen(false);
      await load();
    });
  }

  async function deleteEncounter() {
    await withBusy(async () => {
      await api.delete(`${API}/encounters/${eid}`);
      navigate(`/c/${cid}/encounters`);
    });
  }

  async function patchCombatant(combatantId: number, patch: Record<string, unknown>) {
    await withBusy(async () => {
      await api.patch(`${API}/encounters/${eid}/combatants/${combatantId}`, patch);
      await load();
    });
  }

  async function removeCombatant(combatantId: number) {
    await withBusy(async () => {
      await api.delete(`${API}/encounters/${eid}/combatants/${combatantId}`);
      setConfirmRemoveCombatantId(null);
      await load();
    });
  }

  if (!Number.isFinite(cid) || !Number.isFinite(eid)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message="Encounter not found." />
      </div>
    );
  }

  if (loading && !encounter) {
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

  if (error && !encounter) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
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

      {(error || actionError) && (
        <ErrorNote
          message={actionError ?? error ?? ''}
          onRetry={() => {
            setActionError(null);
            void load();
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
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 11.5 }}
          onClick={() => void load()}
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
                <Btn ghost disabled={busy} onClick={rollInitiative}>
                  Roll initiative
                </Btn>
                <Btn disabled={busy} onClick={startEncounter}>
                  Start
                </Btn>
              </>
            )}
            {encounter.status === 'running' && (
              <>
                {/* Reinforcements added mid-fight land at null initiative and sort last —
                    keep Roll initiative reachable so the DM can fill them (issue #54).
                    Already-set initiatives are left untouched server-side. */}
                <Btn ghost disabled={busy} onClick={rollInitiative}>
                  Roll initiative
                </Btn>
                <Btn disabled={busy} onClick={nextTurn}>
                  Next turn →
                </Btn>
              </>
            )}
            {encounter.status !== 'ended' && (
              <Btn ghost danger disabled={busy} onClick={() => setConfirmEnd(true)}>
                End
              </Btn>
            )}
            {encounter.status === 'ended' && (
              <Btn ghost disabled={busy} onClick={() => setConfirmReopen(true)}>
                Reopen
              </Btn>
            )}
            {(encounter.status === 'ended' || encounter.status === 'preparing') && (
              <Btn ghost danger disabled={busy} onClick={() => setConfirmDelete(true)}>
                Delete
              </Btn>
            )}
          </div>
        )}
      </div>

      {encounter.status === 'ended' && <EndedSummary encounter={encounter} />}

      {isDm && encounter.status === 'preparing' && (
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
          Add the party &amp; monsters below, roll initiative, then hit Start.
        </p>
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
              canRemove={isDm}
              canSetInitiative={isDm && encounter.status !== 'ended'}
              busy={busy}
              onHpDelta={(delta) => patchCombatant(c.id, { hpDelta: delta })}
              onSetTempHp={(value) => patchCombatant(c.id, { hpTemp: value })}
              onSetDeathSaves={(patch) => patchCombatant(c.id, patch)}
              onSetInitiative={(value) => patchCombatant(c.id, { initiative: value })}
              onAddCondition={(cond) => patchCombatant(c.id, { addConditions: [cond] })}
              onRemoveCondition={(cond) => patchCombatant(c.id, { removeConditions: [cond] })}
              onRename={(name) => patchCombatant(c.id, { name })}
              onSetHpMax={(value) => patchCombatant(c.id, { hpMax: value })}
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
          onAdded={load}
        />
      )}

      <SharedDiceLog campaignId={cid} />

      {confirmEnd && (
        <ConfirmDialog
          title="End this encounter?"
          body="HP writes back to character sheets. This cannot be undone."
          confirmLabel={busy ? 'Ending…' : 'End encounter'}
          busy={busy}
          onConfirm={endEncounter}
          onCancel={() => setConfirmEnd(false)}
        />
      )}
      {confirmReopen && (
        <ConfirmDialog
          title="Reopen this encounter?"
          body="It returns to Running where combat left off. HP was written back to character sheets when it ended; it will write back again the next time you End."
          confirmLabel={busy ? 'Reopening…' : 'Reopen encounter'}
          busy={busy}
          onConfirm={reopenEncounter}
          onCancel={() => setConfirmReopen(false)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this encounter?"
          body="This cannot be undone."
          confirmLabel={busy ? 'Deleting…' : 'Delete encounter'}
          busy={busy}
          onConfirm={deleteEncounter}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {confirmRemoveCombatantId != null && (
        <ConfirmDialog
          title="Remove this combatant from the encounter?"
          confirmLabel={busy ? 'Removing…' : 'Remove'}
          busy={busy}
          onConfirm={() => removeCombatant(confirmRemoveCombatantId)}
          onCancel={() => setConfirmRemoveCombatantId(null)}
        />
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
  canRemove,
  canSetInitiative,
  busy,
  onHpDelta,
  onSetTempHp,
  onSetDeathSaves,
  onSetInitiative,
  onAddCondition,
  onRemoveCondition,
  onRename,
  onSetHpMax,
  onRemove,
}: {
  combatant: Combatant;
  isCurrentTurn: boolean;
  canEdit: boolean;
  canEditIdentity: boolean;
  canRemove: boolean;
  canSetInitiative: boolean;
  busy: boolean;
  onHpDelta: (delta: number) => void;
  onSetTempHp: (value: number) => void;
  onSetDeathSaves: (patch: { deathSaveSuccesses?: number; deathSaveFailures?: number }) => void;
  onSetInitiative: (value: number) => void;
  onAddCondition: (cond: string) => void;
  onRemoveCondition: (cond: string) => void;
  onRename: (name: string) => void;
  onSetHpMax: (value: number) => void;
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
                {CONDITION_SUGGESTIONS.filter((s) => !combatant.conditions.includes(s)).map((s) => (
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
              disabled={busy}
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
