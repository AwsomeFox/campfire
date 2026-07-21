/**
 * Read-only combat stat card for a player character (issue: encounter character cards).
 *
 * Surfaces the combat-relevant slice of a Character — ability scores + modifiers,
 * AC, saving throws, proficient skills, actions, and spell slots — so a player can
 * see their own sheet inside the encounter and the DM can see the whole party's,
 * mirroring the collapsible monster statblock. Collapsed by default so a long
 * initiative list stays scannable mid-fight.
 *
 * Display-only for now; the click-to-roll wiring (attacks/saves/skills → the shared
 * dice log, with damage application) is a follow-up increment.
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
} from '../lib/characterStats';

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
}: {
  character: Character;
  ruleSystem: string | null;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const adapter = ruleSystemAdapter(ruleSystem);
  const pb = profBonus(character.level);

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

          {/* Ability scores */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {ABILITY_KEYS.map((k) => {
              const score = abilityScore(character, k);
              return <StatChip key={k} label={k} value={`${score} (${signed(adapter.abilityModifier(score))})`} />;
            })}
          </div>

          {/* Saving throws */}
          <Section title="Saving throws">
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {ABILITY_KEYS.map((k) => {
                const proficient = character.saveProficiencies.includes(k);
                const mod = modOf(adapter, character, k) + (proficient ? pb : 0);
                return (
                  <span
                    key={k}
                    className={proficient ? 'tag tag-accent' : 'tag tag-neutral'}
                    style={{ fontSize: 10 }}
                    title={proficient ? `${k} save (proficient)` : `${k} save`}
                  >
                    {k} {signed(mod)}
                  </span>
                );
              })}
            </div>
          </Section>

          {/* Proficient skills only — unproficient ones stay off the card to keep it compact */}
          {proficientSkills.length > 0 && (
            <Section title="Skills">
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {proficientSkills.map((s) => (
                  <span
                    key={s.name}
                    className="tag tag-neutral"
                    style={{ fontSize: 10 }}
                    title={s.rank === 'expertise' ? `${s.name} (expertise)` : `${s.name} (proficient)`}
                  >
                    {s.name} {signed(s.mod)}
                    {s.rank === 'expertise' && ' ◆'}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Actions / attacks */}
          {character.actions.length > 0 && (
            <Section title="Actions">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {character.actions.map((a, i) => (
                  <div key={i} style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                    <span style={{ fontWeight: 600, color: 'var(--color-text)' }}>{a.name}</span>
                    {a.kind && (
                      <span className="text-muted" style={{ fontSize: 11 }}>
                        {' '}
                        · {a.kind}
                      </span>
                    )}
                    {(a.toHit || a.damage) && (
                      <span className="text-muted" style={{ fontSize: 11.5 }}>
                        {' — '}
                        {[a.toHit && `${a.toHit} to hit`, a.damage].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </div>
                ))}
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
