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
        <h1 className="text-2xl font-extrabold text-white m-0">{encounter.name}</h1>
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
              canRemove={isDm}
              canSetInitiative={isDm && encounter.status !== 'ended'}
              busy={busy}
              onHpDelta={(delta) => patchCombatant(c.id, { hpDelta: delta })}
              onSetInitiative={(value) => patchCombatant(c.id, { initiative: value })}
              onAddCondition={(cond) => patchCombatant(c.id, { addConditions: [cond] })}
              onRemoveCondition={(cond) => patchCombatant(c.id, { removeConditions: [cond] })}
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
  canRemove,
  canSetInitiative,
  busy,
  onHpDelta,
  onSetInitiative,
  onAddCondition,
  onRemoveCondition,
  onRemove,
}: {
  combatant: Combatant;
  isCurrentTurn: boolean;
  canEdit: boolean;
  canRemove: boolean;
  canSetInitiative: boolean;
  busy: boolean;
  onHpDelta: (delta: number) => void;
  onSetInitiative: (value: number) => void;
  onAddCondition: (cond: string) => void;
  onRemoveCondition: (cond: string) => void;
  onRemove: () => void;
}) {
  const [addingCondition, setAddingCondition] = useState(false);
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
        <div style={{ fontSize: 14, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          {combatant.name}
          <span className={kindTagClass} style={{ fontSize: 9 }}>
            {combatant.kind}
          </span>
        </div>
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
            <div style={{ fontSize: 12.5, textAlign: 'right', marginBottom: 3 }}>
              {combatant.hpCurrent} / {combatant.hpMax}
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
      </div>
      {canEdit && (
        <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
          <button
            className="btn btn-icon btn-secondary"
            style={{ width: 44, height: 44, fontSize: 16 }}
            disabled={busy}
            onClick={() => onHpDelta(-1)}
          >
            −
          </button>
          <button
            className="btn btn-icon btn-secondary"
            style={{ width: 44, height: 44, fontSize: 16 }}
            disabled={busy}
            onClick={() => onHpDelta(1)}
          >
            +
          </button>
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

  // Compendium
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 300);
  const [results, setResults] = useState<RuleEntry[]>([]);
  const [searching, setSearching] = useState(false);

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
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'monster' as CombatantKind,
        name: name.trim(),
        hpMax: hpMax ? Math.max(1, Number(hpMax)) : undefined,
        initMod: initMod ? Number(initMod) : undefined,
      });
      setName('');
      setHpMax('');
      setInitMod('');
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
        name: entry.name,
        ruleEntryId: entry.id,
      });
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

      {error && <p className="text-sm text-rose-400">{error}</p>}

      {tab === 'manual' && (
        <form onSubmit={addManual} className="flex gap-2 flex-wrap items-end">
          <div className="field" style={{ flex: 1, minWidth: 140 }}>
            <label>Name</label>
            <TextInput placeholder="Ashen cultist" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field" style={{ width: 80 }}>
            <label>HP</label>
            <TextInput placeholder="22" value={hpMax} onChange={(e) => setHpMax(e.target.value)} />
          </div>
          <div className="field" style={{ width: 80 }}>
            <label>Init mod</label>
            <TextInput placeholder="2" value={initMod} onChange={(e) => setInitMod(e.target.value)} />
          </div>
          <Btn type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Adding…' : 'Add'}
          </Btn>
        </form>
      )}

      {tab === 'compendium' && (
        <div className="space-y-2">
          <TextInput
            placeholder="Search monsters…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
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
