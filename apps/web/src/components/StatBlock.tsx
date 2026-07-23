/**
 * StatBlock — renders a monster/creature statblock from a RuleEntry's `dataJson`.
 *
 * Monster entries carry an EMPTY markdown `body`; their stats live in the
 * JSON-encoded `dataJson` produced by the server's open5e-importer
 * (mapCreature): { type, size, challengeRating, armorClass, hitPoints,
 * speed, abilityScores, specialAbilities, actions, reactions,
 * legendaryActions }. The compendium reader used to render only `body`,
 * so every monster showed as a blank page (issue #142).
 *
 * The parser is deliberately tolerant — it accepts both the stored camelCase
 * shape and the raw Open5e snake_case shape, and renders whatever fields are
 * present (missing fields are simply omitted). It also understands optional
 * `specialAbilities`/`actions`/`legendaryActions`/`reactions` arrays so the
 * compendium reader and in-combat card share the complete presentation.
 */
import { Fragment, useId, type CSSProperties } from 'react';
import {
  resolveAbilityModifier,
  ruleSystemAdapter,
  statblockPresentation,
  type AbilityRepresentation,
  type StatblockPresentation,
  type StatblockPresentationLabel,
} from '@campfire/schema';

const SPEED_LABEL = { full: 'Speed' } as const;

interface NamedEntry {
  name: string;
  desc: string;
  attackBonus: string | null;
  damage: string[];
  savingThrow: string | null;
  usage: string | null;
  legendaryActionCost: number | null;
}

export interface MonsterStatblock {
  size: string | null;
  creatureType: string | null;
  challengeRating: string | null;
  armorClass: string | null;
  hitPoints: string | null;
  speed: string | null;
  /**
   * Per-ability display values. `value` is the stored number from the adapter;
   * `mod` is the signed modifier string used for rolls/display. `representation`
   * controls whether the UI shows score+mod (5e), signed mod only (PF2e), or the
   * native value (Open Legend) — see issue #767.
   */
  abilities: Array<{ label: string; value: number; mod: string; representation: AbilityRepresentation }>;
  specialAbilities: NamedEntry[];
  actions: NamedEntry[];
  legendaryActions: NamedEntry[];
  reactions: NamedEntry[];
  /**
   * Adapter-native field labels for this block's rule system (issue #763). Carried on the
   * parsed block so compendium and encounter surfaces stay in lockstep — both render from
   * the same parse result rather than re-deriving labels independently.
   */
  presentation: StatblockPresentation;
}

const ABILITIES: Array<{ label: string; keys: string[] }> = [
  { label: 'STR', keys: ['strength', 'str'] },
  { label: 'DEX', keys: ['dexterity', 'dex'] },
  { label: 'CON', keys: ['constitution', 'con'] },
  { label: 'INT', keys: ['intelligence', 'int'] },
  { label: 'WIS', keys: ['wisdom', 'wis'] },
  { label: 'CHA', keys: ['charisma', 'cha'] },
];

const CR_FRACTIONS: Record<string, string> = { '0.125': '1/8', '0.25': '1/4', '0.5': '1/2' };

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function formatCr(cr: unknown): string | null {
  if (cr === null || cr === undefined || cr === '') return null;
  const n = typeof cr === 'number' ? cr : Number(cr);
  if (!Number.isFinite(n)) return typeof cr === 'string' ? cr : null;
  if (n > 0 && n < 1) return CR_FRACTIONS[String(n)] ?? String(cr);
  return String(n);
}

function formatSpeed(speed: unknown): string | null {
  if (speed === null || speed === undefined) return null;
  if (typeof speed === 'number') return `${speed} ft.`;
  if (typeof speed === 'string') return speed.trim() || null;
  if (typeof speed === 'object') {
    const s = speed as Record<string, unknown>;
    const unit = typeof s.unit === 'string' ? s.unit : 'feet';
    const suffix = unit === 'feet' || unit === 'ft' ? 'ft.' : unit;
    const parts: string[] = [];
    if (typeof s.walk === 'number') parts.push(`${s.walk} ${suffix}`);
    for (const mode of ['burrow', 'climb', 'fly', 'swim']) {
      const v = s[mode];
      if (typeof v === 'number') parts.push(`${mode} ${v} ${suffix}`);
    }
    if (s.hover === true && parts.some((p) => p.startsWith('fly'))) parts.push('(hover)');
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim() || null;
  return null;
}

function namedEntries(v: unknown): NamedEntry[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((e): NamedEntry => {
      if (e && typeof e === 'object') {
        const o = e as Record<string, unknown>;
        const name = typeof o.name === 'string' ? o.name : '';
        const desc = typeof o.desc === 'string' ? o.desc : typeof o.description === 'string' ? o.description : '';
        const attackBonus = toText(o.attackBonus ?? o.attack_bonus);
        const damage = Array.isArray(o.damage)
          ? o.damage
              .map((raw) => {
                if (typeof raw === 'string') return raw.trim();
                if (!raw || typeof raw !== 'object') return '';
                const d = raw as Record<string, unknown>;
                const expression = toText(d.expression ?? d.dice);
                const type = toText(d.type);
                return [expression, type].filter(Boolean).join(' ');
              })
              .filter(Boolean)
          : [];
        const save = o.savingThrow && typeof o.savingThrow === 'object' ? (o.savingThrow as Record<string, unknown>) : null;
        const saveDc = toText(save?.dc ?? o.saveDc ?? o.save_dc);
        const saveAbility = toText(save?.ability ?? o.saveAbility ?? o.save_ability);
        const usage = o.usage && typeof o.usage === 'object' ? (o.usage as Record<string, unknown>) : null;
        const usageLabel = toText(usage?.label ?? (typeof o.usage === 'string' ? o.usage : null));
        const legendaryActionCostRaw = Number(o.legendaryActionCost ?? o.legendary_action_cost);
        return {
          name: name.trim(),
          desc: desc.trim(),
          attackBonus: attackBonus ? (attackBonus.startsWith('+') || attackBonus.startsWith('-') ? attackBonus : `+${attackBonus}`) : null,
          damage,
          savingThrow: saveDc ? `DC ${saveDc}${saveAbility ? ` ${saveAbility.toUpperCase()}` : ''}` : null,
          usage: usageLabel,
          legendaryActionCost: Number.isFinite(legendaryActionCostRaw) ? legendaryActionCostRaw : null,
        };
      }
      return { name: '', desc: '', attackBonus: null, damage: [], savingThrow: null, usage: null, legendaryActionCost: null };
    })
    .filter((e) => e.name || e.desc);
}

/** Accept the JSON string, an already-parsed object, or null; never throw. */
function normalize(data: unknown): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (typeof data === 'object') return data as Record<string, unknown>;
  return null;
}

export function parseMonsterStatblock(data: unknown, ruleSystem?: string | null): MonsterStatblock | null {
  const d = normalize(data);
  if (!d) return null;

  // Statblock field mapping + the ability-modifier formula come from the rule-system
  // adapter (issue #70), resolved from the active campaign's `ruleSystem` (issue #234)
  // rather than defaulted at the call site. Default (5e) reproduces the prior behavior
  // exactly for imported/Open5e monsters, which store camelCase fields.
  const adapter = ruleSystemAdapter(ruleSystem);
  // Presentation is resolved separately from mechanical mapping so unknown/homebrew packs
  // keep 5e-shaped field mapping but show neutral Rating/Defense labels (issue #763).
  const presentation = statblockPresentation(ruleSystem);
  const mapped = adapter.mapStatblock(d);
  const representation: AbilityRepresentation = mapped.abilityRepresentation ?? 'score';

  const scores = mapped.abilityScores;
  const abilities: MonsterStatblock['abilities'] = [];
  if (scores && typeof scores === 'object') {
    for (const { label, keys } of ABILITIES) {
      const raw = keys.map((k) => scores[k]).find((v) => v !== undefined && v !== null);
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(value)) continue;
      // Consume the stored value exactly once: scores convert; modifiers/native stay as-is.
      const modValue = resolveAbilityModifier(adapter, value, representation);
      abilities.push({
        label,
        value,
        mod: representation === 'native' ? String(modValue) : signed(modValue),
        representation,
      });
    }
  }

  const block: MonsterStatblock = {
    size: toText(mapped.size),
    creatureType: toText(mapped.creatureType),
    challengeRating: formatCr(mapped.challengeRating),
    armorClass: toText(mapped.armorClass),
    hitPoints: toText(mapped.hitPoints),
    speed: formatSpeed(mapped.speed),
    abilities,
    specialAbilities: namedEntries(mapped.specialAbilities),
    actions: namedEntries(mapped.actions),
    legendaryActions: namedEntries(mapped.legendaryActions),
    reactions: namedEntries(mapped.reactions),
    presentation,
  };

  const hasAnything =
    block.size ||
    block.creatureType ||
    block.challengeRating ||
    block.armorClass ||
    block.hitPoints ||
    block.speed ||
    block.abilities.length > 0 ||
    block.specialAbilities.length > 0 ||
    block.actions.length > 0 ||
    block.legendaryActions.length > 0 ||
    block.reactions.length > 0;

  return hasAnything ? block : null;
}

/** True when `data` yields at least one renderable statblock field. */
export function hasMonsterStatblock(data: unknown, ruleSystem?: string | null): boolean {
  return parseMonsterStatblock(data, ruleSystem) !== null;
}

/**
 * Snapshot-friendly visible labels for a parsed block (issue #763). Compendium and
 * encounter both render via {@link StatBlock} / {@link parseMonsterStatblock}, so the
 * same helper is the parity check between those surfaces.
 */
export function statblockVisibleLabels(block: MonsterStatblock) {
  const { presentation } = block;
  return {
    rating: presentation.rating.full,
    ratingShort: presentation.rating.short ?? null,
    defense: presentation.defense.full,
    defenseShort: presentation.defense.short ?? null,
    hitPoints: presentation.hitPoints.full,
    hitPointsShort: presentation.hitPoints.short ?? null,
    abilities: presentation.abilities.full,
    actions: presentation.actions.full,
    creatureType: presentation.creatureType.full,
    ratingLine: block.challengeRating ? `${presentation.rating.full} ${block.challengeRating}` : null,
  };
}

const dividerRule: CSSProperties = { borderTop: '1px solid var(--color-divider)', paddingTop: 10, marginTop: 2 };

/**
 * Labeled stat line using adapter presentation metadata (issue #763). Full accessible
 * terms are the visual default; optional `short` abbreviations live on the label object
 * for compact surfaces that opt into them.
 */
function KeyLine({ label, value }: { label: StatblockPresentationLabel; value: string }) {
  return (
    <p style={{ margin: 0, fontSize: 13 }}>
      <span style={{ fontWeight: 600 }}>{label.full}</span> {value}
    </p>
  );
}

function normalizedComparable(value: string): string {
  return value.toLowerCase().replace(/[\u2012-\u2015]/g, '-').replace(/\s+/g, ' ').trim();
}

function mechanicsNotAlreadyInText(entry: NamedEntry, includeLegendaryCost: boolean): string[] {
  const source = normalizedComparable(`${entry.name} ${entry.desc}`);
  const details: string[] = [];
  if (entry.usage && !source.includes(normalizedComparable(entry.usage))) details.push(entry.usage);
  if (entry.attackBonus && !source.includes(normalizedComparable(entry.attackBonus))) details.push(`Attack ${entry.attackBonus}`);
  for (const damage of entry.damage) {
    if (!source.includes(normalizedComparable(damage))) details.push(`Damage ${damage}`);
  }
  if (entry.savingThrow && !source.includes(normalizedComparable(entry.savingThrow))) details.push(`Save ${entry.savingThrow}`);
  if (includeLegendaryCost && entry.legendaryActionCost && entry.legendaryActionCost > 1) {
    const cost = `${entry.legendaryActionCost} legendary actions`;
    if (!source.includes(cost)) details.push(`Costs ${cost}`);
  }
  return details;
}

function NamedSection({ title, entries, headingLevel }: { title: string; entries: NamedEntry[]; headingLevel: 2 | 3 | 4 }) {
  const headingId = useId();
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby={headingId} style={{ ...dividerRule, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <Heading id={headingId} style={{ margin: 0, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-accent-300, var(--color-text))' }}>{title}</Heading>
      <dl style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: 0, minWidth: 0 }}>
        {entries.map((entry, i) => {
          const mechanics = mechanicsNotAlreadyInText(entry, title === 'Legendary Actions');
          return (
            <div key={i} style={{ margin: 0, fontSize: 13, lineHeight: 1.5, minWidth: 0, overflowWrap: 'anywhere' }}>
              {entry.name && <dt style={{ fontWeight: 600, fontStyle: 'italic' }}>{entry.name}</dt>}
              <dd className="text-muted" style={{ margin: 0, color: 'var(--color-text)' }}>
                {entry.desc}
                {mechanics.length > 0 && (
                  <ul aria-label={`${entry.name || title} mechanics`} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '4px 0 0', padding: 0, listStyle: 'none' }}>
                    {mechanics.map((mechanic) => (
                      <li key={mechanic} className="tag tag-neutral" style={{ maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere', fontSize: 10 }}>
                        {mechanic}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/**
 * Renders a monster statblock. Returns null when `data` carries no renderable
 * fields, so callers can fall back to a markdown body. Pass either the raw
 * `dataJson` string or an already-parsed object. `ruleSystem` is the active
 * campaign's rule system (issue #234) — it selects the adapter that maps the
 * statblock fields and ability modifiers. Unrecognized / empty rule systems
 * keep 5e-shaped field mapping but use neutral Rating/Defense labels (#763).
 */
export function StatBlock({ data, ruleSystem, headingLevel = 2 }: { data: unknown; ruleSystem?: string | null; headingLevel?: 2 | 3 | 4 }) {
  const block = parseMonsterStatblock(data, ruleSystem);
  if (!block) return null;

  const { presentation } = block;
  const metaBits = [block.size, block.creatureType].filter(Boolean).join(' ');
  const cr = block.challengeRating;
  const ratingText = cr ? `${presentation.rating.full} ${cr}` : '';

  return (
    <section aria-label="Creature statblock" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      {(metaBits || ratingText) && (
        <p className="text-muted" style={{ margin: 0, fontSize: 12.5, fontStyle: 'italic' }}>
          {metaBits}
          {metaBits && ratingText ? ' · ' : ''}
          {ratingText}
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {block.armorClass && <KeyLine label={presentation.defense} value={block.armorClass} />}
        {block.hitPoints && <KeyLine label={presentation.hitPoints} value={block.hitPoints} />}
        {block.speed && <KeyLine label={SPEED_LABEL} value={block.speed} />}
      </div>

      {block.abilities.length > 0 && (
        <div
          role="group"
          aria-label={presentation.abilities.full}
          style={{
            ...dividerRule,
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.min(block.abilities.length, 6)}, minmax(0, 1fr))`,
            gap: 8,
            textAlign: 'center',
          }}
        >
          {block.abilities.map((a) => (
            <Fragment key={a.label}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--color-accent-300, var(--color-text))' }}>{a.label}</div>
                {a.representation === 'modifier' || a.representation === 'native' ? (
                  // PF2e creatures list signed modifiers; Open Legend lists native attribute values.
                  <div style={{ fontSize: 14 }}>{a.mod}</div>
                ) : (
                  <>
                    <div style={{ fontSize: 14 }}>{a.value}</div>
                    <div className="text-muted" style={{ fontSize: 12 }}>{a.mod}</div>
                  </>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      )}

      <NamedSection title="Traits" entries={block.specialAbilities} headingLevel={headingLevel} />
      <NamedSection title={presentation.actions.full} entries={block.actions} headingLevel={headingLevel} />
      <NamedSection title="Reactions" entries={block.reactions} headingLevel={headingLevel} />
      <NamedSection title="Legendary Actions" entries={block.legendaryActions} headingLevel={headingLevel} />
    </section>
  );
}

export default StatBlock;
