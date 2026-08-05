import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isResolvableSpec, type ActionSpec } from '@campfire/schema';
import { Card } from '../../components/ui';

/**
 * A castable spell as rendered by the panel (issue #1900). Sourced from the server's
 * `TurnWorkspace.spells` (derived from the character's real actions — see
 * `deriveTurnSpells` in `@campfire/schema`), never invented client-side. `castingTime` /
 * `range` / `toHit` / `saveDc` / `damage` / `school` have no data model on a spell action —
 * they stay optional and simply go unrendered when absent rather than being fabricated
 * (the deleted `effectiveSpells` fallback used to hardcode all of these).
 */
export interface SpellItem {
  id: string;
  name: string;
  level: number; // 0 for Cantrip, 1..9 for leveled spells
  school?: string;
  castingTime?: string; // e.g. "1A", "1BA", "1R" — display-only, derived from the action's cost slot
  range?: string; // e.g. "60 ft", "Touch", "Self"
  toHit?: string | null; // e.g. "+7"
  saveDc?: string | null; // e.g. "DC 15 Dex"
  damage?: string | null; // e.g. "8d6 fire"
  isConcentration?: boolean;
  isUpcastable?: boolean; // defaults to level >= 1
  notes?: string;
  spec?: ActionSpec | null;
  actionIndex?: number;
}

export interface SpellSlotMap {
  [level: string]: { max: number; used: number };
}

/**
 * Encounter-state side effects a DESCRIPTIVE (non-resolver) cast still needs to apply
 * (review fix on issue #1900): the resolve/apply flow normally consumes the action-economy
 * slot and sets concentration, but a spec that isn't resolver-eligible never reaches that
 * flow — the direct slot-patch is its only write. Only ever populated from real spec data
 * (never invented): `costSlot` is `spec.cost.slot` when present, `concentrationName` is the
 * spell's own name only when `spec.uses.concentration` is true.
 */
export interface SpellCastContext {
  costSlot?: string;
  concentrationName?: string | null;
}

export interface SpellbookPanelProps {
  combatantName?: string;
  spells: SpellItem[];
  spellSlots?: SpellSlotMap;
  activeConcentration?: string | null;
  // `level` is undefined for a cantrip cast that carries only a `castContext` (no slot to
  // spend); `delta` is 0 in that case. A manual pip click always passes a real `level` and
  // never a `castContext`.
  onUpdateSlot?: (level: number | undefined, delta: number, castContext?: SpellCastContext) => void;
  onUseActionRequested?: (actionIndex: number, actionName: string, spec: ActionSpec) => void;
  disabled?: boolean;
}

/** Formats verbose casting time strings to standard abbreviations (1A / 1BA / 1R). */
export function formatCastingTime(time: string): string {
  if (!time) return '1A';
  const norm = time.trim().toLowerCase();
  if (norm === '1a' || norm === '1 action' || norm === 'action') return '1A';
  if (norm === '1ba' || norm === '1 bonus action' || norm === 'bonus action' || norm === 'bonus') return '1BA';
  if (norm === '1r' || norm === '1 reaction' || norm === 'reaction') return '1R';
  return time;
}

/** Converts numeric spell level to display title. */
export function formatLevelName(level: number): string {
  if (level === 0) return 'Cantrips';
  if (level === 1) return '1st Level';
  if (level === 2) return '2nd Level';
  if (level === 3) return '3rd Level';
  return `${level}th Level`;
}

/** Filters spells by matching query string against name, school, or casting time. */
export function filterSpells(spells: SpellItem[], query: string): SpellItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return spells;
  return spells.filter((s) => {
    const nameMatch = s.name.toLowerCase().includes(q);
    const schoolMatch = s.school ? s.school.toLowerCase().includes(q) : false;
    const cTimeRawMatch = s.castingTime ? s.castingTime.toLowerCase().includes(q) : false;
    const cTimeFmtMatch = s.castingTime ? formatCastingTime(s.castingTime).toLowerCase().includes(q) : false;
    return nameMatch || schoolMatch || cTimeRawMatch || cTimeFmtMatch;
  });
}

/** Groups an array of spells by spell level (0..9). */
export function groupSpellsByLevel(spells: SpellItem[]): Map<number, SpellItem[]> {
  const grouped = new Map<number, SpellItem[]>();
  for (const spell of spells) {
    const lvl = Math.max(0, Math.min(9, spell.level));
    const list = grouped.get(lvl) ?? [];
    list.push(spell);
    grouped.set(lvl, list);
  }
  return grouped;
}

/**
 * Whether a spell's structured spec is resolver-eligible (review fix on issue #1900). A spec
 * can exist but be purely descriptive — an attack with no bonus/ability, or a save/check with
 * no DC source (`isResolvableSpec` from `@campfire/schema`, the same predicate the server uses
 * to set `TurnSpellEntry.resolvable`). Routing a non-resolvable spec through the resolve/apply
 * Use flow either errors or silently spends nothing; gating on this instead of bare `spec`
 * truthiness is what makes both the Cast button and the upcast picker correct for it. Exported
 * so the branch is independently regression-tested without rendering the panel.
 */
export function isResolvableSpell(spell: Pick<SpellItem, 'spec'>): boolean {
  return Boolean(spell.spec && isResolvableSpec(spell.spec));
}

/**
 * Whether the actor has any Spellbook-worthy data (issue #1900): a spell row, or a slot pool
 * that is actually usable. A persisted `spellSlots` entry with `max: 0` (e.g. a slot tier the
 * character hasn't reached yet) must NOT count — review fix on the "toggle hidden when the
 * actor has no spells and no slots" acceptance criterion, which means no *usable* slots.
 */
export function hasSpellbookContent(spells: readonly SpellItem[], spellSlots?: SpellSlotMap): boolean {
  if (spells.length > 0) return true;
  if (!spellSlots) return false;
  return Object.values(spellSlots).some((pool) => pool.max > 0);
}

/**
 * Derives the encounter-state side effects a DIRECT slot-patch cast must also apply
 * (review fix, P1): a descriptive-but-structured spec never reaches the resolve/apply
 * flow, so its action-economy cost and concentration have no other write path. Returns
 * `undefined` when the spell carries no spec at all — nothing to derive, and nothing
 * invented. Exported so the derivation is independently regression-tested.
 */
export function buildSpellCastContext(spell: Pick<SpellItem, 'spec' | 'isConcentration' | 'name'>): SpellCastContext | undefined {
  if (!spell.spec) return undefined;
  return {
    costSlot: spell.spec.cost?.slot || undefined,
    concentrationName: spell.isConcentration ? spell.name : undefined,
  };
}

export function SpellbookPanel({
  combatantName,
  spells,
  spellSlots = {},
  activeConcentration,
  onUpdateSlot,
  onUseActionRequested,
  disabled = false,
}: SpellbookPanelProps) {
  useTranslation();
  const [filterQuery, setFilterQuery] = useState('');
  const [collapsedLevels, setCollapsedLevels] = useState<Record<number, boolean>>({});
  const [upcastMenuOpenFor, setUpcastMenuOpenFor] = useState<string | null>(null);
  const [concentrationWarningSpell, setConcentrationWarningSpell] = useState<{
    spell: SpellItem;
    castLevel?: number;
  } | null>(null);

  const filteredSpells = useMemo(() => filterSpells(spells, filterQuery), [spells, filterQuery]);
  const groupedSpells = useMemo(() => groupSpellsByLevel(filteredSpells), [filteredSpells]);

  // All levels that should be rendered (cantrips or levels that have spells or configured slots)
  const sortedLevels = useMemo(() => {
    const levelsSet = new Set<number>([0]);
    for (const lvlStr of Object.keys(spellSlots)) {
      const num = Number(lvlStr);
      if (!isNaN(num) && num >= 1 && num <= 9) levelsSet.add(num);
    }
    for (const spell of spells) {
      levelsSet.add(spell.level);
    }
    return Array.from(levelsSet).sort((a, b) => a - b);
  }, [spellSlots, spells]);

  const toggleLevelCollapse = (lvl: number) => {
    setCollapsedLevels((prev) => ({ ...prev, [lvl]: !prev[lvl] }));
  };

  const handlePipClick = (level: number, pipIndex: number, isUsed: boolean) => {
    if (disabled || !onUpdateSlot) return;
    // Clicking an available slot pip (not used) spends 1 (+1 delta); clicking a used pip
    // restores 1 (-1 delta). The parent's mutation is the only writer of `used` — this
    // component never tracks its own copy, so a failed request simply leaves the pips
    // showing whatever the server last confirmed (issue #1900).
    onUpdateSlot(level, isUsed ? -1 : 1);
  };

  // Issue #1900: no client-side slot decrement here anymore — that used to fire ALONGSIDE
  // the resolver's own server-side spend for a spec-bearing spell, double-spending the same
  // cast. A RESOLVABLE spell has EXACTLY one valid write path: the resolve/apply flow, which
  // spends the spec's own declared slot level transactionally (undo-refundable). Review fix:
  // this branch is now terminal for a resolvable spell — it NEVER falls through to the direct
  // slot patch below, even when the resolver handler isn't wired (e.g. a transient
  // encounter/turn-query disagreement right after a turn advance). Falling through there would
  // burn a slot with no attack/save/damage ever happening and no undo to refund it; `disabled`
  // on the Cast button (canCastBase, below) additionally prevents the click in that state — this
  // is defense in depth, not the only guard.
  const executeCast = (spell: SpellItem, castLevel?: number) => {
    if (isResolvableSpell(spell)) {
      if (onUseActionRequested && spell.actionIndex != null && spell.spec) {
        onUseActionRequested(spell.actionIndex, spell.name, spell.spec);
      }
      return;
    }
    // Non-resolvable (spec-less OR descriptive spec): the direct slot-patch / turn-state
    // path is the ONLY write. A cantrip (level 0) has no slot to spend but may still declare
    // a real action-economy cost and/or concentration (`buildSpellCastContext`) — those must
    // still be applied, or the Cast button is a silent no-op for every cantrip with structured
    // data (review fix). `castContext` alone (not `level`) is what tells the parent "this is a
    // genuine cast, apply side effects" — a manual pip click never carries one.
    const levelToSpend = castLevel ?? (spell.level > 0 ? spell.level : undefined);
    const castContext = buildSpellCastContext(spell);
    if (onUpdateSlot && (levelToSpend != null || castContext != null)) {
      onUpdateSlot(levelToSpend, levelToSpend != null ? 1 : 0, castContext);
    }
  };

  const initiateCast = (spell: SpellItem, castLevel?: number) => {
    if (disabled) return;
    setUpcastMenuOpenFor(null);

    // Check if casting this concentration spell will replace an active concentration
    if (spell.isConcentration && activeConcentration && activeConcentration !== spell.name) {
      setConcentrationWarningSpell({ spell, castLevel });
      return;
    }

    executeCast(spell, castLevel);
  };

  return (
    <Card className="space-y-4" data-testid="spellbook-panel">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 pb-3">
        <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
          <span>🔮 In-Combat Spellbook</span>
          {combatantName && <span className="text-xs font-normal text-muted">— {combatantName}</span>}
        </h3>
      </div>

      {/* Search / filter input */}
      <div>
        <input
          type="search"
          className="input w-full text-sm"
          placeholder="Search spells by name, school, casting time (1A, 1BA, 1R)…"
          aria-label="Filter prepared spells"
          data-testid="spellbook-search-input"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
        />
      </div>

      {/* Concentrating indicator banner if active */}
      {activeConcentration && (
        <div className="rounded-md px-3 py-1.5 text-xs bg-amber-950/30 border border-amber-500/30 text-amber-300 flex items-center gap-2" data-testid="active-concentration-banner">
          <span>🔮 Concentrating on: <strong className="text-amber-200">{activeConcentration}</strong></span>
        </div>
      )}

      {/* Level-by-level collapsible sections */}
      <div className="space-y-3" data-testid="spellbook-level-sections">
        {sortedLevels.map((lvl) => {
          const levelSpells = groupedSpells.get(lvl) ?? [];
          const slotPool = spellSlots[String(lvl)] ?? { max: 0, used: 0 };
          const isCollapsed = Boolean(collapsedLevels[lvl]);
          const remainingSlots = Math.max(0, slotPool.max - slotPool.used);

          // If filtering and no spells in this level, skip rendering empty level
          if (filterQuery.trim() && levelSpells.length === 0) return null;

          return (
            <div key={`level-section-${lvl}`} className="border border-neutral-800 rounded-lg overflow-hidden" data-testid={`spell-level-section-${lvl}`}>
              {/* Level section header */}
              <div
                className="bg-neutral-900/80 px-3 py-2 flex items-center justify-between gap-2 cursor-pointer select-none hover:bg-neutral-800/80 transition-colors"
                onClick={() => toggleLevelCollapse(lvl)}
                aria-expanded={!isCollapsed}
                aria-controls={`spell-level-${lvl}-content`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted text-xs">{isCollapsed ? '►' : '▼'}</span>
                  <h4 className="text-sm font-bold text-white m-0">{formatLevelName(lvl)}</h4>
                  <span className="text-xs text-muted">({levelSpells.length})</span>
                </div>

                {/* Slot pips for leveled slots — the ONLY source of truth is spellSlots
                    (the server's persisted {max, used}); there is nothing else to render. */}
                {lvl >= 1 && slotPool.max > 0 && (
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <span className="text-xs text-muted">
                      Slots: <strong className="text-white">{remainingSlots}/{slotPool.max}</strong>
                    </span>
                    <div className="flex items-center gap-1" data-testid={`slot-pips-level-${lvl}`}>
                      {Array.from({ length: slotPool.max }).map((_, pipIdx) => {
                        const isUsed = pipIdx >= remainingSlots;
                        return (
                          <button
                            key={`level-${lvl}-pip-${pipIdx}`}
                            type="button"
                            className={`w-6 h-6 rounded flex items-center justify-center text-xs font-bold transition-colors cf-target-44 ${
                              isUsed
                                ? 'border border-neutral-700 text-neutral-600 bg-neutral-950'
                                : 'border border-blue-400 text-blue-300 bg-blue-950/40 hover:bg-blue-900/40'
                            }`}
                            aria-label={`Level ${lvl} slot ${pipIdx + 1} ${isUsed ? 'used' : 'available'}`}
                            disabled={disabled}
                            onClick={() => handlePipClick(lvl, pipIdx, isUsed)}
                          >
                            {isUsed ? '○' : '●'}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Level section body */}
              {!isCollapsed && (
                <div id={`spell-level-${lvl}-content`} className="p-2 space-y-2 bg-neutral-950/40">
                  {levelSpells.length === 0 ? (
                    <p className="text-xs text-muted italic m-0 p-2">No {formatLevelName(lvl).toLowerCase()} prepared.</p>
                  ) : (
                    levelSpells.map((spell) => {
                      // Upcasting a RESOLVABLE spell isn't offered: the resolve/apply flow
                      // spends the spec's OWN declared slot level, so a chosen upcast level
                      // would silently not be honored server-side. A spec-less OR
                      // non-resolvable-spec leveled spell (no resolver path either way, see
                      // `isResolvableSpell`) gets the upcast picker, which spends the chosen
                      // level directly and exclusively via executeCast's slot-patch branch
                      // above (issue #1900; review fix — a descriptive spec with a real spell
                      // level must still be upcastable, not just a spec-less one).
                      const resolvable = isResolvableSpell(spell);
                      const isUpcastable = !resolvable && (spell.isUpcastable ?? (lvl >= 1 && lvl < 9));
                      const hasSlotRemaining = lvl === 0 || remainingSlots > 0;
                      // Review fix: a resolvable spell's ONLY valid write path is the resolver
                      // (see executeCast) — if that handler isn't wired, disable Cast rather
                      // than let a click fall through to a slot burn with nothing resolved.
                      const canCastBase = hasSlotRemaining && !disabled && (!resolvable || onUseActionRequested != null);

                      // Higher slot options for upcasting popover
                      const upcastLevels: Array<{ level: number; label: string; remaining: number }> = [];
                      if (isUpcastable) {
                        for (let uLvl = lvl + 1; uLvl <= 9; uLvl++) {
                          const pool = spellSlots[String(uLvl)];
                          if (pool && pool.max > 0) {
                            const rem = Math.max(0, pool.max - pool.used);
                            if (rem > 0) {
                              upcastLevels.push({
                                level: uLvl,
                                label: `${formatLevelName(uLvl)} (${rem}/${pool.max})`,
                                remaining: rem,
                              });
                            }
                          }
                        }
                      }

                      const hasDisplayDetails = Boolean(spell.castingTime || spell.range || spell.toHit || spell.saveDc || spell.damage);

                      return (
                        <div
                          key={spell.id}
                          className="rounded border border-neutral-800 p-2.5 bg-neutral-900/60 space-y-1.5"
                          data-testid={`spell-row-${spell.id}`}
                        >
                          <div className="flex items-start justify-between gap-2 flex-wrap">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-bold text-white text-sm">{spell.name}</span>
                                {spell.school && (
                                  <span className="tag tag-neutral text-[10px]">{spell.school}</span>
                                )}
                                {spell.isConcentration && (
                                  <span className="tag tag-warning text-[10px]" data-testid="concentration-indicator">
                                    🔮 Conc
                                  </span>
                                )}
                              </div>
                              {hasDisplayDetails && (
                                <div className="flex items-center gap-3 text-xs text-muted mt-1 flex-wrap">
                                  {spell.castingTime && <span>Time: <strong className="text-neutral-300">{formatCastingTime(spell.castingTime)}</strong></span>}
                                  {spell.range && <span>Range: <strong className="text-neutral-300">{spell.range}</strong></span>}
                                  {spell.toHit && <span>To Hit: <strong className="text-neutral-300">{spell.toHit}</strong></span>}
                                  {spell.saveDc && <span>Save: <strong className="text-neutral-300">{spell.saveDc}</strong></span>}
                                  {spell.damage && <span>Effect: <strong className="text-neutral-300">{spell.damage}</strong></span>}
                                </div>
                              )}
                              {spell.notes && <p className="text-xs text-muted m-0 mt-1">{spell.notes}</p>}
                            </div>

                            {/* Cast action buttons */}
                            <div className="flex items-center gap-1.5 shrink-0 relative">
                              <button
                                type="button"
                                className="btn btn-primary text-xs min-h-[44px] px-3 cf-target-44"
                                disabled={!canCastBase}
                                data-testid={`cast-spell-${spell.id}`}
                                onClick={() => initiateCast(spell)}
                              >
                                Cast
                              </button>

                              {isUpcastable && (
                                <div className="relative">
                                  <button
                                    type="button"
                                    className="btn btn-secondary text-xs min-h-[44px] px-2.5 cf-target-44"
                                    disabled={disabled || upcastLevels.length === 0}
                                    data-testid={`upcast-spell-${spell.id}`}
                                    aria-expanded={upcastMenuOpenFor === spell.id}
                                    aria-label={`Upcast ${spell.name}`}
                                    onClick={() => setUpcastMenuOpenFor((curr) => (curr === spell.id ? null : spell.id))}
                                  >
                                    Cast ↑
                                  </button>

                                  {/* Upcast slot picker popover */}
                                  {upcastMenuOpenFor === spell.id && (
                                    <div
                                      className="absolute right-0 top-full mt-1 z-30 w-48 rounded-md bg-neutral-900 border border-neutral-700 shadow-xl p-1.5 space-y-1"
                                      data-testid={`upcast-popover-${spell.id}`}
                                    >
                                      <span className="text-[10px] uppercase font-bold text-muted px-2 block">
                                        Select Slot Level
                                      </span>
                                      {upcastLevels.map((opt) => (
                                        <button
                                          key={`upcast-opt-${opt.level}`}
                                          type="button"
                                          className="w-full text-left text-xs text-white px-2 py-1.5 rounded hover:bg-neutral-800 transition-colors flex items-center justify-between"
                                          data-testid={`upcast-option-${opt.level}`}
                                          onClick={() => initiateCast(spell, opt.level)}
                                        >
                                          <span>{opt.label}</span>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Warning Modal when replacing active concentration */}
      {concentrationWarningSpell && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="concentration-warning-modal" role="dialog" aria-modal="true">
          <div className="bg-neutral-900 border border-amber-500/50 rounded-lg max-w-md w-full p-4 space-y-3 shadow-2xl">
            <h4 className="text-base font-bold text-amber-400 m-0 flex items-center gap-2">
              <span>🔮 Concentration Warning</span>
            </h4>
            <p className="text-sm text-neutral-200 m-0">
              You are currently concentrating on <strong>{activeConcentration}</strong>.
            </p>
            <p className="text-xs text-muted m-0">
              Casting <strong>{concentrationWarningSpell.spell.name}</strong> will break your active concentration on {activeConcentration}.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                className="btn btn-ghost text-xs min-h-[44px] cf-target-44"
                data-testid="cancel-concentration-replace"
                onClick={() => setConcentrationWarningSpell(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary text-xs min-h-[44px] cf-target-44 bg-amber-600 hover:bg-amber-500 text-white"
                data-testid="confirm-concentration-replace"
                onClick={() => {
                  const target = concentrationWarningSpell;
                  setConcentrationWarningSpell(null);
                  executeCast(target.spell, target.castLevel);
                }}
              >
                Replace Concentration &amp; Cast
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
