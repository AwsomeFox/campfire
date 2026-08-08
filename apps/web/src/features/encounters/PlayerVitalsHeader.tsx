import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AdapterResourceDef, Combatant, Character, CustomMechanicsProfile } from '@campfire/schema';
import { ruleSystemAdapter } from '@campfire/schema';
import { HpBar, Card, Btn, TextInput } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { useAnnounce } from '../../components/Announcer';
import { api, API, translateApiError } from '../../lib/api';
import { adapterResourceLabel } from '../../lib/adapterVocabularyLabel';
import { TurnElapsedChip } from './TurnElapsedChip';
import type { DeathSaveOutcome } from './combat/deathSaveOutcome';
import { RulesHintPopover } from '../../components/RulesHintPopover';
import { conditionHintKey, rulesHintCompendiumHref } from '../../lib/rulesHints';
import {
  canAdjustSpecialResource,
  findSpecialResource,
  resourceAvailability,
  specialResourceAdjustBody,
} from '../characters/specialCharacterResource';

interface PlayerVitalsHeaderProps {
  combatants: Combatant[];
  charactersById: Map<number, Character>;
  onHpDelta?: (combatantId: number, delta: number) => void;
  onSetHpMax?: (combatantId: number, max: number) => void;
  turnPulse?: boolean;
  currentCombatantId?: number;
  /** Turn timer (issue #1935) — server-stamped; renders only once a limit is set (see TurnElapsedChip). */
  turnStartedAt?: string | null;
  turnTimerSeconds?: number;
  /**
   * The active campaign's adapter movement-slot max (e.g. 30 for 5e), or `undefined`
   * when the adapter declares no movement slot at all (e.g. PF2e). Computed by the
   * caller from `actionEconomyForAdapter` — this component renders one row per
   * combatant, not the single current-turn actor the server resolves a movement max
   * for, so there is no per-combatant server value to thread through here.
   */
  movementDefault?: number;
  /** Issue #1942: adds a non-color HP danger glyph alongside the color-only bar tone. */
  colorVisionAssist?: boolean;
  /**
   * Issue #1919 — roll a death save for the viewer's own dying character through the
   * SAME server-authoritative d20 + shared dice-log action `DeathSaveTracker` uses.
   * Omitted entirely disables the strip's Roll button (matches `DeathSaveTracker`'s
   * `canEditPermission && canRoll` gate: this header only ever renders the viewer's own
   * owned combatants, so permission is implicit — `canRoll` is still `deathState === 'dying'`).
   */
  onRollDeathSave?: (combatantId: number) => void;
  /** Per-combatant in-flight state for the Roll button, same signal as `busy` elsewhere. */
  isDeathSaveBusy?: (combatantId: number) => boolean;
  /**
   * Issue #1746 sync gate — disables the Roll button without unmounting it. Also disables
   * the Spend button on the special-resource pip (issue #1944 review) — see that prop's
   * mirror doc on `CombatantRowProps.syncBlocked`: every control that performs a write
   * must consult this for `disabled`, not just permission for mount.
   */
  syncBlocked?: boolean;
  /** This combatant's just-settled death-save outcome, or null once faded (issue #1919). */
  deathSaveOutcome?: { combatantId: number; outcome: DeathSaveOutcome } | null;
  /** Issue #1939: resolves the condition-tag rules-hint popovers — the same slug the
   *  encounter's combat surfaces already resolve `ruleSystemAdapter` from. */
  ruleSystem?: string | null;
  /** Issue #1939: campaign id for the condition-tag rules-hint popovers' "Full rule" link. */
  campaignId?: number;
  /** Issue #1939: whether the campaign's resolved rule pack has searchable compendium
   *  entries — gates the "Full rule" link on condition-tag rules-hint popovers. */
  rulesHintCompendiumAvailable?: boolean;
  /**
   * Issue #1944 review — the active campaign's homebrew mechanics override, threaded to
   * `ruleSystemAdapter` the SAME way `CombatantRow` and `RunSessionPage`'s other adapter
   * consumers already do (`campaign?.customMechanicsProfile`). Without this,
   * `ruleSystemAdapter(ruleSystem)` silently falls back to the 5e adapter for any
   * unregistered `ruleSystem` slug, so a homebrew table would see a 5e Inspiration pip
   * that `CombatantRow` (which DOES receive this prop) correctly renders no Award control
   * for.
   */
  customMechanicsProfile?: CustomMechanicsProfile | null;
  /**
   * Surfaces a Spend failure (e.g. the server's 400 rejecting an already-empty pool) as
   * the page's visible error banner — same prop shape as the `onError` callbacks other
   * encounter-screen components already take (e.g. BattleMap's).
   */
  onSpecialResourceError?: (msg: string) => void;
}

function deathSaveOutcomeText(
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string,
  outcome: DeathSaveOutcome,
): string {
  switch (outcome.kind) {
    case 'revive':
      return t('encounters.deathSave.outcome.revive', 'Natural 20 — back on your feet!');
    case 'dead':
      return t('encounters.deathSave.outcome.dead', 'Died.');
    case 'stabilized':
      return t('encounters.deathSave.outcome.stabilized', 'Stabilized.');
    case 'success':
      return t('encounters.deathSave.outcome.success', 'Success (rolled {{natural}}).', { natural: outcome.natural });
    case 'failure':
    default:
      return t('encounters.deathSave.outcome.failure', 'Failure (rolled {{natural}}).', { natural: outcome.natural });
  }
}

/**
 * Movement speed shown in the sticky vitals header (issue #1910). Matches the SAME
 * resolution the server uses in getTurnWorkspace (encounters.service.ts) EXACTLY:
 * the combatant's add-time snapshot, or — full stop — the caller-supplied adapter
 * default. Deliberately does NOT fall through to the character sheet's live speed
 * when the snapshot is null: `combatant.speed === null` is ambiguous between "predates the column"
 * and "the character had no speed set at add time", and a live-character fallback would show a DIFFERENT number.
 */
export function vitalsSpeedFor(combatant: Combatant, movementDefault: number | undefined): number | null {
  const speed = (combatant as { speed?: number | null }).speed;
  if (speed != null) return speed;
  return movementDefault ?? null;
}

export function PlayerVitalsHeader({ combatants, charactersById, onHpDelta, onSetHpMax, turnPulse = false, currentCombatantId, movementDefault, colorVisionAssist = false, turnStartedAt = null, turnTimerSeconds = 0, onRollDeathSave, isDeathSaveBusy, syncBlocked = false, deathSaveOutcome, ruleSystem = null, campaignId, rulesHintCompendiumAvailable = false, customMechanicsProfile = null, onSpecialResourceError }: PlayerVitalsHeaderProps) {
  const { t } = useTranslation();
  const [adjustHpFor, setAdjustHpFor] = useState<number | null>(null);
  const [hpDraft, setHpDraft] = useState('');
  const [editingMaxFor, setEditingMaxFor] = useState<number | null>(null);
  const [maxHpDraft, setMaxHpDraft] = useState('');
  const adapter = useMemo(() => ruleSystemAdapter(ruleSystem, customMechanicsProfile), [ruleSystem, customMechanicsProfile]);
  const specialResourceDef = useMemo(
    () => findSpecialResource(ruleSystemAdapter(ruleSystem, customMechanicsProfile)),
    [ruleSystem, customMechanicsProfile],
  );

  if (combatants.length === 0) return null;

  function commitHp(combatantId: number) {
    if (!hpDraft || !onHpDelta) return;
    const delta = parseInt(hpDraft, 10);
    if (!isNaN(delta) && delta !== 0) {
      onHpDelta(combatantId, delta);
    }
    setHpDraft('');
    setAdjustHpFor(null);
  }

  function commitMaxHp(combatantId: number) {
    if (!maxHpDraft || maxHpDraft.includes('.') || !onSetHpMax) return;
    const max = parseInt(maxHpDraft, 10);
    if (!isNaN(max) && Number.isInteger(max) && max >= 1) {
      onSetHpMax(combatantId, max);
    }
    setMaxHpDraft('');
    setEditingMaxFor(null);
  }

  return (
    <div className="sticky top-0 z-10 w-full mb-4">
      <TurnElapsedChip
        turnStartedAt={turnStartedAt}
        turnTimerSeconds={turnTimerSeconds}
        audience="player"
        className="mb-2"
      />
      {combatants.map(c => {
        const char = c.characterId ? charactersById.get(c.characterId) : undefined;
        const ac = char?.ac ?? c.eac ?? c.statblock?.ac ?? '—';
        const speed = vitalsSpeedFor(c, movementDefault);

        return (
          <Card key={c.id} className={`flex flex-col md:flex-row flex-wrap gap-4 items-center bg-neutral-900 border-b-4 border-accent p-3 shadow-md mb-2 ${turnPulse && c.id === currentCombatantId ? 'cf-turn-beat-pulse' : ''}`}>
            <div className="flex flex-col flex-1 min-w-[120px]">
              <span className="font-bold text-lg leading-tight text-white">{c.name}</span>
              <span className="text-xs text-muted">
                Initiative {c.initiative ?? '—'}
                {c.initiativeBreakdown && <span title={JSON.stringify(c.initiativeBreakdown)} className="ml-1 cursor-help">ℹ️</span>}
              </span>
            </div>

            <div className="flex items-center gap-3">
              <button 
                type="button"
                className="flex flex-col items-center cf-target-44 min-w-[44px] cursor-pointer bg-transparent border-none text-white hover:bg-neutral-800 rounded p-1"
                onClick={() => {
                  setEditingMaxFor(null);
                  setAdjustHpFor(adjustHpFor === c.id ? null : c.id);
                }}
                title="Quick HP adjust"
              >
                <span className="text-xs text-muted">HP</span>
                <span className="font-bold text-lg leading-none">{c.hpCurrent} / {c.hpMax}</span>
              </button>

              {onSetHpMax && (
                <button
                  type="button"
                  aria-label={t('encounters.vitals.editMaxHp', 'Edit max HP')}
                  className="cf-target-44 min-w-[44px] text-xs text-muted hover:text-white p-1 rounded hover:bg-neutral-800"
                  onClick={() => {
                    setAdjustHpFor(null);
                    if (editingMaxFor === c.id) {
                      setEditingMaxFor(null);
                    } else {
                      setEditingMaxFor(c.id);
                      setMaxHpDraft(String(c.hpMax));
                    }
                  }}
                  title={t('encounters.vitals.editMaxHp', 'Edit max HP')}
                >
                  ✏️
                </button>
              )}
              
              <div className="w-32 hidden sm:block">
                <HpBar current={c.hpCurrent ?? 0} max={c.hpMax ?? 1} colorVisionAssist={colorVisionAssist} />
              </div>
              
              {c.hpTemp != null && c.hpTemp > 0 && (
                <span className="tag tag-accent text-xs">+{c.hpTemp} Temp</span>
              )}
            </div>

            {adjustHpFor === c.id && (
              <div className="flex items-center gap-2 bg-neutral-800 p-2 rounded-md shadow-inner">
                <TextInput
                  autoFocus
                  placeholder="-5 or +5"
                  className="w-24 text-sm cf-target-44"
                  value={hpDraft}
                  onChange={(e) => setHpDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitHp(c.id);
                    if (e.key === 'Escape') setAdjustHpFor(null);
                  }}
                />
                <Btn className="cf-target-44" density="xs" onClick={() => commitHp(c.id)}>Apply</Btn>
              </div>
            )}

            {editingMaxFor === c.id && (
              <div className="flex items-center gap-2 bg-neutral-800 p-2 rounded-md shadow-inner">
                <TextInput
                  autoFocus
                  placeholder={t('encounters.vitals.maxHp', 'Max HP')}
                  className="w-24 text-sm cf-target-44"
                  value={maxHpDraft}
                  onChange={(e) => setMaxHpDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitMaxHp(c.id);
                    if (e.key === 'Escape') setEditingMaxFor(null);
                  }}
                />
                <Btn className="cf-target-44" density="xs" onClick={() => commitMaxHp(c.id)}>{t('encounters.vitals.setMax', 'Set Max')}</Btn>
              </div>
            )}

            <div className="flex items-center gap-4 min-w-[80px]">
              <div className="flex flex-col items-center cf-target-44 justify-center">
                <GameIcon slug="shield" size={14} className="text-muted" />
                <span className="font-bold">{ac}</span>
              </div>
              {speed != null && (
                <div className="flex flex-col items-center cf-target-44 justify-center">
                  <span className="text-xs text-muted leading-none">Speed</span>
                  <span className="font-bold">{speed}</span>
                </div>
              )}
            </div>

            {/* Issue #1944: the adapter-declared special resource (5e inspiration / PF2e
                hero points) — renders only when the adapter actually declares one AND this
                combatant's character resolved (character load in flight, or an unlinked
                combatant, shows neither). */}
            {char && specialResourceDef && (
              <SpecialResourcePip
                character={char}
                def={specialResourceDef}
                syncBlocked={syncBlocked}
                onError={onSpecialResourceError}
              />
            )}

            {(c.hpCurrent === 0 || c.deathState === 'dying') && (() => {
              const dying = c.deathState === 'dying';
              const canRoll = dying && onRollDeathSave != null;
              const busy = isDeathSaveBusy?.(c.id) ?? false;
              const outcome = deathSaveOutcome?.combatantId === c.id ? deathSaveOutcome.outcome : null;
              return (
                <div
                  className={`flex items-center gap-2 ml-auto flex-wrap border px-3 py-1.5 rounded-lg ${dying ? 'border-red-500 bg-red-950/50' : 'border-red-500/50 bg-red-950/30'}`}
                  data-testid={dying ? 'player-vitals-dying-strip' : 'player-vitals-death-saves'}
                >
                  <span className="text-xs text-red-200 font-semibold uppercase tracking-wider">
                    {dying
                      ? t(
                          'encounters.vitals.dyingStrip',
                          'You are dying — {{successes}} successes / {{failures}} failures',
                          { successes: c.deathSaveSuccesses, failures: c.deathSaveFailures },
                        )
                      : t('encounters.vitals.deathSaves', 'Death Saves')}
                  </span>
                  {!dying && (
                    <span className="text-sm font-bold text-white tracking-widest">
                      {c.deathSaveSuccesses} ✓ <span className="text-red-400">{c.deathSaveFailures} ✗</span>
                    </span>
                  )}
                  {canRoll && (
                    <Btn
                      className="cf-target-44"
                      density="xs"
                      disabled={busy || syncBlocked}
                      title={syncBlocked ? t('encounters.sync.controlsPaused', 'Paused — reconnecting to live updates.') : undefined}
                      aria-label={t('encounters.vitals.rollDeathSave', 'Roll a death save')}
                      onClick={() => onRollDeathSave?.(c.id)}
                    >
                      {t('dice.roll', 'Roll')}
                    </Btn>
                  )}
                  {outcome != null && (
                    <span className={`cf-death-save-outcome cf-death-save-outcome--${outcome.kind}`} data-testid="death-save-outcome">
                      {deathSaveOutcomeText(t, outcome)}
                    </span>
                  )}
                </div>
              );
            })()}

            <div className="flex items-center gap-1.5 flex-wrap flex-1 justify-end min-w-[100px]">
              {c.conditions.map(cond => {
                // Issue #1939: undefined on any adapter without an authored hint (every
                // non-5e system today) — no affordance renders, never 5e text on another system.
                const hintKey = conditionHintKey(adapter.id, cond);
                return (
                  <span key={cond} className="inline-flex items-center gap-1">
                    <span className="tag tag-neutral text-xs px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-200 border border-neutral-700">{cond}</span>
                    {hintKey && (
                      <RulesHintPopover
                        termId={cond}
                        termLabel={cond}
                        hintKey={hintKey}
                        align="end"
                        compendiumHref={
                          rulesHintCompendiumAvailable && campaignId != null
                            ? rulesHintCompendiumHref(campaignId, cond)
                            : undefined
                        }
                      />
                    )}
                  </span>
                );
              })}
              {c.turnState?.concentration && (
                <span className="tag tag-accent text-xs px-2 py-0.5 rounded-full border border-accent/50">
                  <GameIcon slug="brain" size={14} className="inline mr-1" />
                  {c.turnState.concentration}
                </span>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Issue #1944 — one player's own Spend affordance for the adapter-declared special
 * resource, plus the "award moment" for the recipient: a DM Award (CombatantRow) lands
 * here purely through the SAME `character.updated` SSE-driven refetch every other
 * inline sheet value on this page already relies on (see RunSessionPage's
 * `shouldInvalidateInlineCharacters` handling) — there is no separate push channel for
 * this feature. The previous-`available` ref below (mirrors HpBar's damage/heal pulse
 * at ui.tsx) detects that refetched increment and fires a small flourish + a screen
 * reader announcement via the app-wide Announcer.
 *
 * A dedicated component (not inlined in the `combatants.map` callback above) so each
 * combatant's previous-value ref and busy/flourish state are independent — the parent
 * only ever holds ONE shared `useState` per interaction (adjustHpFor, editingMaxFor),
 * which would collapse every combatant's award-detection into a single ref otherwise.
 */
function SpecialResourcePip({
  character,
  def,
  syncBlocked = false,
  onError,
}: {
  character: Character;
  def: AdapterResourceDef;
  /** Issue #1944 review — same sync gate the death-save Roll button already consults. */
  syncBlocked?: boolean;
  onError?: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const { max, available } = resourceAvailability(def, character);
  // Issue #1944 review: the adapter's `def.name` is a plain, locale-free English string
  // (e.g. "Inspiration") baked into the shared domain contract — display through
  // `adapterResourceLabel`, the SAME translated-name resolution `CharacterPage`'s
  // `AdapterResourceCard` already uses, keyed on the resource's stable `key` rather than
  // its English name. `def.name` itself still flows to the server via
  // `specialResourceAdjustBody` unchanged — this is display only.
  const resourceLabel = adapterResourceLabel(t, def);
  const syncBlockedReason = syncBlocked
    ? t('encounters.sync.controlsPaused', 'Paused — reconnecting to live updates.')
    : undefined;

  // Award-moment detection: `available` only ever goes UP from a DM award (a player's
  // own Spend always takes the delta-DOWN path below) — including the untouched → first
  // award transition (0 → defaultMax). Initialised to the CURRENT value so mounting
  // this pip for the first time (e.g. opening the encounter after the award already
  // landed) never fires a false flourish.
  const prevAvailableRef = useRef(available);
  const [flourish, setFlourish] = useState(false);
  useEffect(() => {
    if (available > prevAvailableRef.current) {
      setFlourish(true);
      announce(
        t('encounters.specialResource.receivedAnnounce', {
          name: resourceLabel,
          defaultValue: `You received ${resourceLabel}!`,
        }),
      );
    }
    prevAvailableRef.current = available;
  }, [available, announce, resourceLabel, t]);

  async function spend() {
    if (busy || syncBlocked || !canAdjustSpecialResource(def, character, 'spend')) return;
    if (!window.confirm(t('encounters.specialResource.spendConfirm', { name: resourceLabel, defaultValue: `Spend ${resourceLabel}?` }))) return;
    setBusy(true);
    try {
      await api.post(`${API}/characters/${character.id}/resources`, specialResourceAdjustBody(def, character, 'spend'));
      // Advisory-only confirmation (issue #1944) — the real state change is the
      // server-authoritative `character.updated` refetch, same as every other write
      // on this page; this is just the player's own immediate feedback.
      announce(t('encounters.specialResource.spentToast', { name: resourceLabel, defaultValue: `${resourceLabel} spent` }));
    } catch (err) {
      // Same translated-error convention every other encounter-screen write uses — this
      // is what surfaces the server's 400 on an overspend attempt as a visible banner
      // (the caller wires `onError` to RunSessionPage's `surfaceActionError`) instead of
      // a silent no-op the pip's `disabled` gating alone cannot fully rule out (a second
      // client's Spend racing between this pip's render and the request landing).
      onError?.(translateApiError(err, t, { fallbackKey: 'encounters.resourceTracker.updateResourceError' }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span
      className={`tag tag-accent text-xs px-2 py-1 rounded-full border border-accent/50 flex items-center gap-1.5 ${flourish ? 'cf-special-resource-award-flash' : ''}`}
      data-testid={`special-resource-pip-${character.id}`}
      onAnimationEnd={() => setFlourish(false)}
    >
      <span aria-label={t('encounters.specialResource.available', { available, max, name: resourceLabel, defaultValue: `${available} of ${max} ${resourceLabel} available` })}>
        {resourceLabel} {available}/{max}
      </span>
      <button
        type="button"
        className="btn btn-ghost !px-1 text-[10px] cf-density-xs cf-target-44"
        disabled={busy || syncBlocked || !canAdjustSpecialResource(def, character, 'spend')}
        title={syncBlockedReason}
        onClick={() => void spend()}
      >
        {t('encounters.specialResource.spend', { name: resourceLabel, defaultValue: `Spend ${resourceLabel}` })}
      </button>
    </span>
  );
}
