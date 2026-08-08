/**
 * Combat stat card for a player character (issue: encounter character cards).
 *
 * Surfaces the combat-relevant slice of a Character — ability scores + modifiers,
 * AC, saving throws, proficient skills, actions, and spell slots — so a player can
 * see their own sheet inside the encounter and the DM can see the whole party's,
 * mirroring the collapsible monster statblock. Collapsed by default so a long
 * initiative list stays scannable mid-fight.
 *
 * When a `campaignId` is supplied the card becomes interactive (issue: wire actions
 * to dice): abilities, saves, skills, and attacks become click-to-roll and post to
 * the shared campaign dice feed with the same expressions the character sheet uses
 * (shift-click = advantage, alt/ctrl/⌘-click = disadvantage on d20s). A rolled damage
 * total is handed up via `onApplyDamage` so the encounter can apply it to a target.
 * Without a `campaignId` the card is read-only, so it stays reusable elsewhere.
 */
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ActionSpec, Character, RollCheckDefinition, UsableAction } from '@campfire/schema';
import {
  ruleSystemAdapter,
  checkCatalogForAdapter,
  sortCheckCatalog,
  filterCheckCatalog,
  formatCheckBreakdown,
  isResolvableSpec,
  STARFINDER_ADAPTER_ID,
  type CustomMechanicsProfile,
} from '@campfire/schema';
import {
  SPELL_LEVELS,
  abilityScore,
  abilityFieldsForCharacter,
  signed,
  toHitExpr,
  damageExpr, critDamageExpr,
} from '../lib/characterStats';
import { RollContextMenu, type RollMode } from './RollContextMenu';
import { useRoller } from '../lib/useRoller';
import { useDisclosure } from './useDisclosure';
import { api, API } from '../lib/api';
import { queryKeys } from '../lib/query';

/**
 * One row this card can render in its Actions section — either a hand-authored sheet
 * action (as-is) or a merged {@link UsableAction} fetched from the server (issue #1901),
 * which additionally may carry an equipped-item `source` tag and the MERGED index the
 * server's resolve/apply pipeline expects (not necessarily the raw `character.actions`
 * position once equipped-item actions are appended after it).
 */
interface DisplayAction {
  index: number;
  name: string;
  kind: string;
  toHit: string;
  damage: string;
  notes: string;
  spec: ActionSpec | null;
  /** "equipped: <item name>" for an equipped-item action; empty for a sheet action. */
  source: string;
}


const NOOP = () => {};

/** Shared style for a roll-me pill (button) vs. a static pill (span). */
const PILL: CSSProperties = { fontSize: 12, minHeight: 44, minWidth: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 10px' };
const ROLL_HINT = ' · shift-click for advantage · alt/ctrl/⌘-click for disadvantage';

function StatChip({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div
      title={title}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        padding: '4px 2px',
        border: '1px solid var(--color-divider)',
        borderRadius: 'var(--radius-md)',
        minWidth: 46,
        minHeight: 44,
      }}
    >
      <span className="text-muted" style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>
        <bdi>{value}</bdi>
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="card-kicker" style={{ margin: 0 }}>
        {title}
      </span>
      {children}
    </div>
  );
}

export function CharacterStatCard({
  character,
  ruleSystem,
  customMechanicsProfile,
  defaultOpen = false,
  openOnActiveTurn = false,
  campaignId,
  encounterId,
  combatantId,
  onError,
  onApplyDamage,
  onUseAction,
}: {
  character: Character;
  ruleSystem: string | null;
  customMechanicsProfile?: CustomMechanicsProfile | null;
  defaultOpen?: boolean;
  /** Open when this character becomes the active combatant, without collapsing it on later turns. */
  openOnActiveTurn?: boolean;
  /** When set, the card becomes interactive: rolls post to this campaign's shared feed. */
  campaignId?: number;
  /**
   * Issue #1901: when both are set, the Actions section fetches the server's MERGED action
   * list (`GET /encounters/:id/combatants/:cid/actions` — the same owner/DM-gated read
   * `listUsableActions` serves) instead of mapping the raw `character.actions` array, so an
   * equipped item's action appears and `onUseAction`'s index always matches the server's
   * merged index space (no drift). Falls back to the raw sheet list while the fetch is
   * pending or when either prop is omitted, so the card stays usable outside an encounter.
   */
  encounterId?: number;
  combatantId?: number;
  onError?: (msg: string | null) => void;
  /** Called with a rolled damage total so the encounter can apply it to a target combatant. */
  onApplyDamage?: (amount: number, label: string, diceTotal?: number) => void;
  /**
   * Issue #414: open the structured action Use flow for a resolvable action. Takes the
   * MERGED index (see `displayActions` above) plus the name/spec at that index directly —
   * issue #1901 widened this from index-only so the caller never has to re-derive them from
   * `character.actions`, which is exactly the lookup that silently missed equipped-item
   * actions appended past the raw sheet's length. Same 3-arg shape as
   * `CombatantActionsList`'s `onUseAction` for a monster/NPC.
   */
  onUseAction?: (actionIndex: number, actionName: string, spec: ActionSpec) => void;
}) {
  const { open, setOpen, buttonProps, regionProps } = useDisclosure({
    initialOpen: defaultOpen,
    focusManagement: false,
    regionLabel: `${character.name} character sheet`,
  });
  const adapter = ruleSystemAdapter(ruleSystem, customMechanicsProfile);
  const isStarfinder = adapter.id === STARFINDER_ADAPTER_ID || ruleSystem?.startsWith('starfinder') || false;
  const roller = useRoller(campaignId ?? 0, onError ?? NOOP);
  const interactive = campaignId != null;

  // Issue #1901: the server's merged action list (sheet + equipped-item actions, one stable
  // index space) for a live-encounter combatant. Gated on encounterId/combatantId alone —
  // NOT on `interactive` — so the card still shows equipped gear off-turn; only the roll/Use
  // controls stay gated by `interactive` below, same as they already are for sheet actions.
  // Also gated on `open` (review: devin-ai-integration on PR #1951) — `displayActions` only
  // renders inside the `{open && ...}` disclosure body below, so fetching while collapsed
  // bought nothing but one request per party member on every mount, repeated on every
  // `character.updated`/`encounter.updated` invalidation (a DM's full-party view can have a
  // dozen of these cards mounted at once). `staleTime` still lets a quick collapse/expand
  // reuse a still-fresh cached response instead of re-fetching.
  const actionsFetchEnabled = encounterId != null && combatantId != null && open;
  // Issue #1901 review (devin-ai-integration): `isError` is read below specifically so a
  // FAILED fetch is distinguishable from an in-flight one — both leave `fetchedActions`
  // `undefined`, and `displayActions` falls back to the raw sheet list in either case (the
  // best available data), but only a genuine failure should tell the reader that fallback
  // might be missing an equipped weapon's attack. Silently blending the two together is
  // exactly the "equipped action just vanishes, with no message" bug this closes.
  const { data: fetchedActions, isError: actionsFetchFailed } = useQuery({
    queryKey: actionsFetchEnabled ? [...queryKeys.encounter(encounterId!), 'actions', combatantId!] : ['character-stat-card-actions-disabled'],
    queryFn: () => api.get<UsableAction[]>(`${API}/encounters/${encounterId}/combatants/${combatantId}/actions`),
    enabled: actionsFetchEnabled,
    staleTime: 5_000,
  });
  const displayActions: DisplayAction[] = useMemo(() => {
    if (fetchedActions) {
      return fetchedActions.map((a) => ({
        index: a.index,
        name: a.name,
        kind: a.kind,
        toHit: a.toHit,
        damage: a.damage,
        notes: a.notes,
        spec: a.spec,
        source: a.source,
      }));
    }
    return character.actions.map((a, index) => ({
      index,
      name: a.name,
      kind: a.kind ?? '',
      toHit: a.toHit ?? '',
      damage: a.damage ?? '',
      notes: a.notes ?? '',
      spec: a.spec ?? null,
      source: '',
    }));
  }, [fetchedActions, character.actions]);

  // Active turns can change while this card stays mounted. Open the relevant sheet when
  // that happens, but leave a player or DM in control of collapsing it afterwards.
  useEffect(() => {
    if (openOnActiveTurn) setOpen(true);
  }, [openOnActiveTurn, setOpen]);

  // Issue #415: the adapter-owned roll catalog is the SINGLE source of truth for every
  // rollable check — the same list (and math) the character sheet renders. Skills include
  // proficient AND unproficient, so an ordinary check rolls inline; favorites come first.
  const catalog = useMemo(() => sortCheckCatalog(checkCatalogForAdapter(adapter, character)), [adapter, character]);
  const saves = catalog.filter((c) => c.category === 'save');
  const allSkills = catalog.filter((c) => c.category === 'skill');

  // Skills are searchable (favorites first, not proficient-only). The query narrows the list.
  const [skillQuery, setSkillQuery] = useState('');
  const skills = useMemo(() => filterCheckCatalog(allSkills, skillQuery), [allSkills, skillQuery]);

  const spellLevels = SPELL_LEVELS.filter((lvl) => (character.spellSlots[lvl]?.max ?? 0) > 0);

  /** Roll a catalog check server-side (the server owns the proficiency math). */
  function rollCheck(def: RollCheckDefinition, mode: RollMode): void {
    if (!interactive) return;
    const resolvedMode = def.supportsAdvantage ? mode : 'normal';
    void roller.rollCheck(character.id, def.id, resolvedMode);
  }

  const subtitle = [character.species, character.className && `${character.className} ${character.level}`]
    .filter(Boolean)
    .join(' · ');

  /**
   * A catalog-check pill (ability check / save / skill). A button when interactive (rolls
   * server-side), else a static span. The transparent breakdown ("DEX +3, proficient +2 = +5")
   * rides in the accessible name + tooltip — the secondary action that opens the modifier.
   */
  function CheckPill({ def }: { def: RollCheckDefinition }) {
    const cls = def.favorite ? 'tag tag-accent' : 'tag tag-neutral';
    const suffix = def.proficiency === 'expertise' ? ' ◆' : '';
    const text = `${def.label}${suffix} ${signed(def.modifier)}`;
    const breakdown = formatCheckBreakdown(def);
    const incomplete = def.incomplete ? ' — sheet data incomplete' : '';
    if (!interactive) {
      return (
        <span className={cls} style={PILL} title={breakdown}>
          {text}
        </span>
      );
    }
    const advHint = def.supportsAdvantage ? ROLL_HINT : '';
    return (
      <RollContextMenu
        className={cls}
        style={{ ...PILL, cursor: 'pointer', border: 0 }}
        disabled={roller.rolling}
        data-testid={`check-roll-${def.id}`}
        title={`Roll ${def.label} — ${breakdown}${incomplete}${advHint}`}
        aria-label={`Roll ${def.label}: ${breakdown}${incomplete}`}
        onRoll={(mode) => rollCheck(def, mode)}
      >
        {text}
      </RollContextMenu>
    );
  }

  return (
    <div style={{ marginTop: 5 }}>
      <button
        type="button"
        className="btn btn-ghost"
        {...buttonProps}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${character.name}'s character sheet`}
        style={{ fontSize: 10.5, minHeight: 24, padding: '2px 8px', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Character sheet
      </button>
      {open && (
        <div
          {...regionProps}
          style={{
            marginTop: 6,
            padding: '10px 12px',
            border: '1px solid var(--color-divider)',
            borderRadius: 'var(--radius-md)',
            background: 'color-mix(in srgb, var(--color-accent) 4%, transparent)',
            maxWidth: 460,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 15, color: 'var(--color-text)' }}>{character.name}</span>
            {subtitle && (
              <span className="text-muted" style={{ fontSize: 12 }}>
                {subtitle}
              </span>
            )}
            {isStarfinder || character.eac != null || character.kac != null ? (
              <span className="tag tag-neutral" style={{ fontSize: 10, marginLeft: 'auto' }} title="Energy AC (EAC) / Kinetic AC (KAC)">
                EAC {character.eac ?? '—'} · KAC {character.kac ?? character.ac ?? '—'}
              </span>
            ) : (
              character.ac != null && (
                <span className="tag tag-neutral" style={{ fontSize: 10, marginLeft: 'auto' }} title="Armor Class">
                  AC {character.ac}
                </span>
              )
            )}
          </div>

          {/* Ability scores — click for an ability check when interactive (server-resolved) */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {abilityFieldsForCharacter(adapter, character).map(({ key: k, label }) => {
              const score = abilityScore(character, k);
              const mod = score === null ? null : adapter.abilityModifier(score);
              const value = score === null ? '—' : `${score} (${signed(mod!)})`;
              const def = catalog.find((c) => c.id === `ability:${k}`);
              if (!interactive || !def) return <StatChip key={k} label={label} value={value} />;
              return (
                <RollContextMenu
                  key={k}
                  disabled={roller.rolling}
                  data-testid={`check-roll-ability:${k}`}
                  title={`Roll ${k} check (${mod === null ? '—' : signed(mod)})${def.supportsAdvantage ? ROLL_HINT : ''}`}
                  onRoll={(mode) => rollCheck(def, mode)}
                  style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}
                >
                  <StatChip label={label} value={value} />
                </RollContextMenu>
              );
            })}
          </div>

          {/* Saving throws — every ability, proficient (accent) or not */}
          {saves.length > 0 && (
            <Section title="Saving throws">
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {saves.map((def) => (
                  <CheckPill key={def.id} def={def} />
                ))}
              </div>
            </Section>
          )}

          {/* Skills — EVERY skill (issue #415), proficient and not, searchable, favorites first.
              An unproficient check now rolls inline at its correct modifier instead of hiding. */}
          {allSkills.length > 0 && (
            <Section title="Skills">
              {interactive && (
                <input
                  type="search"
                  value={skillQuery}
                  onChange={(e) => setSkillQuery(e.target.value)}
                  placeholder="Search skills…"
                  aria-label={`Search ${character.name}'s skills`}
                  data-testid="check-search"
                  className="input"
                  style={{ fontSize: 12, minHeight: 32, marginBottom: 4, maxWidth: 220 }}
                />
              )}
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {skills.map((def) => (
                  <CheckPill key={def.id} def={def} />
                ))}
                {skills.length === 0 && (
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    No skills match “{skillQuery}”.
                  </span>
                )}
              </div>
            </Section>
          )}

          {/* Issue #1901 review (devin-ai-integration): a failed merged-actions fetch used to
              fall back to the raw sheet list with no indication anything went wrong — an
              equipped weapon's attack just silently disappeared. Rendered independently of
              `displayActions.length` so it still shows even when the sheet fallback is empty. */}
          {actionsFetchEnabled && actionsFetchFailed && (
            <p className="text-rose-400" style={{ fontSize: 11.5 }} data-testid="character-stat-actions-error">
              Couldn't load this character's full action list — equipped-gear actions may be missing below.
            </p>
          )}

          {/* Actions / attacks — primary combat rolls use 44×44 hit areas (issue #428).
              Issue #1901: `displayActions` is the server-merged list (sheet + equipped-item
              actions) when encounterId/combatantId are supplied, so an equipped weapon's
              attack appears here with the SAME index the server's resolve/apply expects. */}
          {displayActions.length > 0 && (
            <Section title="Actions">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="character-stat-actions">
                {displayActions.map((a) => {
                  const canRollHit = interactive && !!a.toHit && toHitExpr(a.toHit, 'flat') != null;
                  const dmgExpr = a.damage ? damageExpr(a.damage) : null;
                  const canRollDmg = interactive && dmgExpr != null;
                  const canUse = interactive && onUseAction != null && a.spec != null && isResolvableSpec(a.spec);
                  return (
                    <div key={a.index} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <div style={{ fontSize: 12.5, lineHeight: 1.4, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, color: 'var(--color-text)' }}>{a.name}</span>
                      {a.kind && (
                        <span className="text-muted" style={{ fontSize: 11 }}>
                          · {a.kind}
                        </span>
                      )}
                      {a.source && (
                        <span className="tag tag-neutral" style={{ fontSize: 10 }} data-testid="action-source-tag">
                          {a.source}
                        </span>
                      )}
                      {a.toHit &&
                        (canRollHit ? (
                          <RollContextMenu
                            className="cf-roll-control"
                            data-testid="attack-roll-control"
                            disabled={roller.rolling}
                            onRoll={(mode) => void roller.roll(toHitExpr(a.toHit, mode === 'advantage' ? 'adv' : mode === 'disadvantage' ? 'dis' : 'flat')!, `${character.name} · ${a.name} to hit${mode !== 'normal' ? ` (${mode})` : ''}`)}
                          >
                            🎯 {a.toHit.startsWith('+') || a.toHit.startsWith('-') ? a.toHit : `+${a.toHit}`}
                          </RollContextMenu>
                        ) : (
                          <span className="text-muted">🎯 {a.toHit.startsWith('+') || a.toHit.startsWith('-') ? a.toHit : `+${a.toHit}`}</span>
                        ))}
                      {a.damage &&
                        (canRollDmg ? (
                          <RollContextMenu
                            className="cf-roll-control"
                            data-testid="damage-roll-control"
                            disabled={roller.rolling}
                            onRoll={(mode) => {
                               // For damage, crit implies doubling dice via roller API/logic if supported, but for now we just label it or handle it in roller.
                               void roller.roll(mode === 'crit' ? critDamageExpr(dmgExpr!) || dmgExpr! : dmgExpr!, `${character.name} · ${a.name} damage${mode !== 'normal' ? ` (${mode})` : ''}`, {
                                onApply: onApplyDamage,
                              });
                            }}
                          >
                            💥 {a.damage}
                          </RollContextMenu>
                        ) : (
                          <span className="text-muted">💥 {a.damage}</span>
                        ))}
                      {canUse && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ minHeight: 32, fontSize: 11.5, padding: '0 10px' }}
                          data-testid="action-use-control"
                          onClick={() => a.spec && onUseAction(a.index, a.name, a.spec)}
                        >
                          Use
                        </button>
                      )}
                      </div>
                      {/* Freeform notes (issue #414): always preserved on the action AND rendered
                          here — the statblock text a player relies on when an action has no
                          structured resolver, or the flavour/rider text alongside one. */}
                      {a.notes && (
                        <span className="text-muted" style={{ fontSize: 11.5, lineHeight: 1.35, whiteSpace: 'pre-wrap' }} data-testid="action-notes">
                          {a.notes}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Spell slots */}
          {spellLevels.length > 0 && (
            <Section title="Spell slots">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {spellLevels.map((lvl) => {
                  const slot = character.spellSlots[lvl]!;
                  const remaining = Math.max(0, slot.max - slot.used);
                  return (
                    <span key={lvl} className="text-muted" style={{ fontSize: 11.5 }} title={`Level ${lvl}: ${remaining} of ${slot.max} left`}>
                      L{lvl} {'●'.repeat(remaining)}
                      {'○'.repeat(Math.max(0, slot.max - remaining))}
                    </span>
                  );
                })}
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
