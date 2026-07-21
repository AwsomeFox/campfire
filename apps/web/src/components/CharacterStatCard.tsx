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
 * (shift-click = advantage, alt/ctrl-click = disadvantage on d20s). A rolled damage
 * total is handed up via `onApplyDamage` so the encounter can apply it to a target.
 * Without a `campaignId` the card is read-only, so it stays reusable elsewhere.
 */
import { useState } from 'react';
import type { Character } from '@campfire/schema';
import { ruleSystemAdapter } from '@campfire/schema';
import {
  ABILITY_KEYS,
  SKILLS,
  SPELL_LEVELS,
  profBonus,
  abilityScore,
  modOf,
  signed,
  d20Expr,
  toHitExpr,
  damageExpr,
  advFromEvent,
} from '../lib/characterStats';
import { useRoller } from '../lib/useRoller';
import { RollResultBanner } from './RollResultBanner';

const NOOP = () => {};

/** Shared style for a roll-me pill (button) vs. a static pill (span). */
const PILL: React.CSSProperties = { fontSize: 10 };
const ROLL_HINT = ' · shift-click for advantage · alt or ctrl-click for disadvantage';

function StatChip({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div
      title={title}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        padding: '4px 2px',
        border: '1px solid var(--color-divider)',
        borderRadius: 'var(--radius-md)',
        minWidth: 46,
      }}
    >
      <span className="text-muted" style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
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
  defaultOpen = false,
  campaignId,
  onError,
  onApplyDamage,
}: {
  character: Character;
  ruleSystem: string | null;
  defaultOpen?: boolean;
  /** When set, the card becomes interactive: rolls post to this campaign's shared feed. */
  campaignId?: number;
  onError?: (msg: string | null) => void;
  /** Called with a rolled damage total so the encounter can apply it to a target combatant. */
  onApplyDamage?: (amount: number, label: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const adapter = ruleSystemAdapter(ruleSystem);
  const pb = profBonus(character.level);
  const roller = useRoller(campaignId ?? 0, onError ?? NOOP);
  const interactive = campaignId != null;

  const proficientSkills = SKILLS.map(({ name, ability }) => {
    const rank = character.skills[name];
    if (!rank) return null;
    const mod = modOf(adapter, character, ability) + (rank === 'expertise' ? pb * 2 : pb);
    return { name, mod, rank };
  }).filter((s): s is { name: string; mod: number; rank: 'proficient' | 'expertise' } => s !== null);

  const spellLevels = SPELL_LEVELS.filter((lvl) => (character.spellSlots[lvl]?.max ?? 0) > 0);

  const subtitle = [character.species, character.className && `${character.className} ${character.level}`]
    .filter(Boolean)
    .join(' · ');

  /** A d20 check pill (ability check / save / skill) — a button when interactive, else a span. */
  function CheckPill({ mod, label, rollLabel, accent }: { mod: number; label: string; rollLabel: string; accent?: boolean }) {
    const cls = accent ? 'tag tag-accent' : 'tag tag-neutral';
    const text = `${label} ${signed(mod)}`;
    if (!interactive) {
      return (
        <span className={cls} style={PILL}>
          {text}
        </span>
      );
    }
    return (
      <button
        type="button"
        className={cls}
        style={{ ...PILL, cursor: 'pointer', border: 0 }}
        disabled={roller.rolling}
        title={`Roll ${rollLabel} (${signed(mod)})${ROLL_HINT}`}
        onClick={(e) => void roller.roll(d20Expr(mod, advFromEvent(e)), `${character.name} · ${rollLabel}`)}
      >
        {text}
      </button>
    );
  }

  return (
    <div style={{ marginTop: 5 }}>
      <button
        type="button"
        className="btn btn-ghost"
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${character.name}'s character sheet`}
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 10.5, minHeight: 24, padding: '2px 8px', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
      >
        {open ? '▾' : '▸'} Character sheet
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
            {character.ac != null && (
              <span className="tag tag-neutral" style={{ fontSize: 10, marginLeft: 'auto' }} title="Armor Class">
                AC {character.ac}
              </span>
            )}
          </div>

          {interactive && roller.last && <RollResultBanner roll={roller.last} onDismiss={roller.dismiss} />}

          {/* Ability scores — click for an ability check when interactive */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {ABILITY_KEYS.map((k) => {
              const score = abilityScore(character, k);
              const mod = adapter.abilityModifier(score);
              const value = `${score} (${signed(mod)})`;
              if (!interactive) return <StatChip key={k} label={k} value={value} />;
              return (
                <button
                  key={k}
                  type="button"
                  disabled={roller.rolling}
                  title={`Roll ${k} check (${signed(mod)})${ROLL_HINT}`}
                  onClick={(e) => void roller.roll(d20Expr(mod, advFromEvent(e)), `${character.name} · ${k} check`)}
                  style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}
                >
                  <StatChip label={k} value={value} />
                </button>
              );
            })}
          </div>

          {/* Saving throws */}
          <Section title="Saving throws">
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {ABILITY_KEYS.map((k) => {
                const proficient = character.saveProficiencies.includes(k);
                const mod = modOf(adapter, character, k) + (proficient ? pb : 0);
                return <CheckPill key={k} mod={mod} label={k} rollLabel={`${k} save`} accent={proficient} />;
              })}
            </div>
          </Section>

          {/* Proficient skills only — unproficient ones stay off the card to keep it compact */}
          {proficientSkills.length > 0 && (
            <Section title="Skills">
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {proficientSkills.map((s) => (
                  <CheckPill
                    key={s.name}
                    mod={s.mod}
                    label={s.rank === 'expertise' ? `${s.name} ◆` : s.name}
                    rollLabel={`${s.name} check`}
                  />
                ))}
              </div>
            </Section>
          )}

          {/* Actions / attacks */}
          {character.actions.length > 0 && (
            <Section title="Actions">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {character.actions.map((a, i) => {
                  const canRollHit = interactive && !!a.toHit && toHitExpr(a.toHit, 'flat') != null;
                  const dmgExpr = a.damage ? damageExpr(a.damage) : null;
                  const canRollDmg = interactive && dmgExpr != null;
                  return (
                    <div key={i} style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                      <span style={{ fontWeight: 600, color: 'var(--color-text)' }}>{a.name}</span>
                      {a.kind && (
                        <span className="text-muted" style={{ fontSize: 11 }}>
                          {' '}
                          · {a.kind}
                        </span>
                      )}
                      {(a.toHit || a.damage) && (
                        <span style={{ fontSize: 11.5 }}>
                          {' — '}
                          {a.toHit &&
                            (canRollHit ? (
                              <button
                                type="button"
                                className="cf-linkish"
                                disabled={roller.rolling}
                                title={`Roll ${a.name} to hit${ROLL_HINT}`}
                                onClick={(e) => void roller.roll(toHitExpr(a.toHit, advFromEvent(e))!, `${character.name} · ${a.name} to hit`)}
                                style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer', color: 'var(--color-accent)', font: 'inherit' }}
                              >
                                {a.toHit} to hit
                              </button>
                            ) : (
                              <span className="text-muted">{a.toHit} to hit</span>
                            ))}
                          {a.toHit && a.damage && <span className="text-muted">, </span>}
                          {a.damage &&
                            (canRollDmg ? (
                              <button
                                type="button"
                                className="cf-linkish"
                                disabled={roller.rolling}
                                title={`Roll ${a.name} damage${onApplyDamage ? ' — then apply to a target' : ''}`}
                                onClick={async () => {
                                  const res = await roller.roll(dmgExpr!, `${character.name} · ${a.name} damage`);
                                  if (res && onApplyDamage) onApplyDamage(res.total, `${a.name} (${character.name})`);
                                }}
                                style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer', color: 'var(--color-accent)', font: 'inherit' }}
                              >
                                {a.damage}
                              </button>
                            ) : (
                              <span className="text-muted">{a.damage}</span>
                            ))}
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
