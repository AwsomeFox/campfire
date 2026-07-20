/**
 * StatBlock — renders a monster/creature statblock from a RuleEntry's `dataJson`.
 *
 * Monster entries carry an EMPTY markdown `body`; their stats live in the
 * JSON-encoded `dataJson` produced by the server's open5e-importer
 * (mapCreature): { type, size, challengeRating, armorClass, hitPoints,
 * speed, abilityScores }. The compendium reader used to render only `body`,
 * so every monster showed as a blank page (issue #142).
 *
 * The parser is deliberately tolerant — it accepts both the stored camelCase
 * shape and the raw Open5e snake_case shape, and renders whatever fields are
 * present (missing fields are simply omitted). It also understands optional
 * `specialAbilities`/`actions` arrays so the same component can back the
 * in-combat statblock (issue #56) if those get imported later.
 */
import { Fragment, type CSSProperties } from 'react';
import { ruleSystemAdapter } from '@campfire/schema';

interface NamedEntry {
  name: string;
  desc: string;
}

export interface MonsterStatblock {
  size: string | null;
  creatureType: string | null;
  challengeRating: string | null;
  armorClass: string | null;
  hitPoints: string | null;
  speed: string | null;
  /** [label, score, modifier] per ability, only for abilities that were present. */
  abilities: Array<{ label: string; score: number; mod: string }>;
  specialAbilities: NamedEntry[];
  actions: NamedEntry[];
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
        return { name: name.trim(), desc: desc.trim() };
      }
      return { name: '', desc: '' };
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

export function parseMonsterStatblock(data: unknown): MonsterStatblock | null {
  const d = normalize(data);
  if (!d) return null;

  // Statblock field mapping + the ability-modifier formula come from the rule-system
  // adapter (issue #70), not inline field names/math here. Default (5e) reproduces the
  // prior behavior exactly for imported/Open5e monsters, which store camelCase fields.
  const adapter = ruleSystemAdapter();
  const mapped = adapter.mapStatblock(d);

  const scores = mapped.abilityScores;
  const abilities: MonsterStatblock['abilities'] = [];
  if (scores && typeof scores === 'object') {
    for (const { label, keys } of ABILITIES) {
      const raw = keys.map((k) => scores[k]).find((v) => v !== undefined && v !== null);
      const score = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(score)) abilities.push({ label, score, mod: signed(adapter.abilityModifier(score)) });
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
    block.actions.length > 0;

  return hasAnything ? block : null;
}

/** True when `data` yields at least one renderable statblock field. */
export function hasMonsterStatblock(data: unknown): boolean {
  return parseMonsterStatblock(data) !== null;
}

const dividerRule: CSSProperties = { borderTop: '1px solid var(--color-divider)', paddingTop: 10, marginTop: 2 };

function KeyLine({ label, value }: { label: string; value: string }) {
  return (
    <p style={{ margin: 0, fontSize: 13 }}>
      <span style={{ fontWeight: 600 }}>{label}</span> {value}
    </p>
  );
}

function NamedSection({ title, entries }: { title: string; entries: NamedEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div style={{ ...dividerRule, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h4 style={{ margin: 0, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-accent)' }}>{title}</h4>
      {entries.map((e, i) => (
        <p key={i} style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
          {e.name && <span style={{ fontWeight: 600, fontStyle: 'italic' }}>{e.name}. </span>}
          <span className="text-muted" style={{ color: 'var(--color-text)' }}>{e.desc}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * Renders a monster statblock. Returns null when `data` carries no renderable
 * fields, so callers can fall back to a markdown body. Pass either the raw
 * `dataJson` string or an already-parsed object.
 */
export function StatBlock({ data }: { data: unknown }) {
  const block = parseMonsterStatblock(data);
  if (!block) return null;

  const metaBits = [block.size, block.creatureType].filter(Boolean).join(' ');
  const cr = block.challengeRating;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {(metaBits || cr) && (
        <p className="text-muted" style={{ margin: 0, fontSize: 12.5, fontStyle: 'italic' }}>
          {metaBits}
          {metaBits && cr ? ' · ' : ''}
          {cr ? `Challenge ${cr}` : ''}
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {block.armorClass && <KeyLine label="Armor Class" value={block.armorClass} />}
        {block.hitPoints && <KeyLine label="Hit Points" value={block.hitPoints} />}
        {block.speed && <KeyLine label="Speed" value={block.speed} />}
      </div>

      {block.abilities.length > 0 && (
        <div
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
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--color-accent)' }}>{a.label}</div>
                <div style={{ fontSize: 14 }}>{a.score}</div>
                <div className="text-muted" style={{ fontSize: 12 }}>{a.mod}</div>
              </div>
            </Fragment>
          ))}
        </div>
      )}

      <NamedSection title="Traits" entries={block.specialAbilities} />
      <NamedSection title="Actions" entries={block.actions} />
    </div>
  );
}

export default StatBlock;
