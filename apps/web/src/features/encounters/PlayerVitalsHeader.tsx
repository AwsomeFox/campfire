import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Combatant, Character } from '@campfire/schema';
import { HpBar, Card, Btn, TextInput } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';

interface PlayerVitalsHeaderProps {
  combatants: Combatant[];
  charactersById: Map<number, Character>;
  onHpDelta?: (combatantId: number, delta: number) => void;
  onSetHpMax?: (combatantId: number, max: number) => void;
  turnPulse?: boolean;
  currentCombatantId?: number;
  /**
   * The active campaign's adapter movement-slot max (e.g. 30 for 5e), or `undefined`
   * when the adapter declares no movement slot at all (e.g. PF2e). Computed by the
   * caller from `actionEconomyForAdapter` — this component renders one row per
   * combatant, not the single current-turn actor the server resolves a movement max
   * for, so there is no per-combatant server value to thread through here.
   */
  movementDefault?: number;
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

export function PlayerVitalsHeader({ combatants, charactersById, onHpDelta, onSetHpMax, turnPulse = false, currentCombatantId, movementDefault }: PlayerVitalsHeaderProps) {
  const { t } = useTranslation('encounters');
  const [adjustHpFor, setAdjustHpFor] = useState<number | null>(null);
  const [hpDraft, setHpDraft] = useState('');
  const [editingMaxFor, setEditingMaxFor] = useState<number | null>(null);
  const [maxHpDraft, setMaxHpDraft] = useState('');

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
                <HpBar current={c.hpCurrent ?? 0} max={c.hpMax ?? 1} />
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

            {(c.hpCurrent === 0 || c.deathState === 'dying') && (
              <div className="flex items-center gap-2 ml-auto border border-red-500/50 bg-red-950/30 px-3 py-1.5 rounded-lg">
                <span className="text-xs text-red-200 font-semibold uppercase tracking-wider">Death Saves</span>
                <span className="text-sm font-bold text-white tracking-widest">
                  {c.deathSaveSuccesses} ✓ <span className="text-red-400">{c.deathSaveFailures} ✗</span>
                </span>
              </div>
            )}

            <div className="flex items-center gap-1.5 flex-wrap flex-1 justify-end min-w-[100px]">
              {c.conditions.map(cond => (
                <span key={cond} className="tag tag-neutral text-xs px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-200 border border-neutral-700">{cond}</span>
              ))}
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
