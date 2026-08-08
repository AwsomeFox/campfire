/**
 * EntryFacts — renders the mechanical facts a NON-creature rule entry carries in its
 * `dataJson`: an item's price/bulk/damage/AC, a spell's range and duration, a feat's
 * prerequisite, a hazard's stealth DC and disable check.
 *
 * {@link StatBlock} covers creatures only. Everything else fell through it: the compendium
 * reader gated the structured view behind `hasMonsterStatblock`, so an item entry showed
 * its prose body or the words "No details available" and NEVER its stats, and the inventory
 * card dumped the raw JSON string into a `<pre>`. Both surfaces render this instead.
 *
 * Deliberately data-driven rather than a per-type layout. The importers keep adding fields
 * as upstream indexes expose them, and a hand-written layout per entry type would silently
 * drop each new one — the same failure this component exists to fix. Anything present in
 * `dataJson` is shown; anything absent is skipped. Only the label text, ordering, and
 * value formatting are curated.
 */
import { Fragment, useId } from 'react';
import { useTranslation } from 'react-i18next';

export interface EntryFact {
  key: string;
  label: string;
  value: string;
}

/**
 * Catalog lookup with an English fallback, threaded through the whole parse.
 *
 * It has to reach the FORMATTER, not just the label: a boolean is rendered as a word, so
 * `shared: true` produced a hardcoded "Yes" baked into `fact.value` before the component
 * ever saw it. Localizing labels alone left the Arabic view mixing languages within a
 * single row. Defaults to the English fallback so `parseEntryFacts` stays usable — and
 * testable — outside a React tree.
 */
export type FactTranslate = (key: string, defaultValue: string) => string;

const englishFallback: FactTranslate = (_key, defaultValue) => defaultValue;

export interface ParsedEntryFacts {
  facts: EntryFact[];
  traits: string[];
  /**
   * Keys whose values are too structured to render as a fact line, kept verbatim so the
   * data stays reachable rather than being silently discarded. See {@link FormattedValue}.
   */
  complex: Record<string, unknown>;
}

/**
 * Keys never shown as a fact row.
 *  - `traits` renders as its own chip row.
 *  - `kind` is an internal discriminator the importer stamps on reference entries.
 *  - the statblock arrays belong to {@link StatBlock}, which owns creature presentation.
 */
const HIDDEN_KEYS = new Set(['traits', 'kind', 'actions', 'specialAbilities', 'legendaryActions', 'reactions', 'abilityMods']);

/**
 * Fallback labels for a camelCase split that would get the term wrong (acronyms, game
 * terms). These are only the LAST resort: {@link EntryFacts} resolves every key through
 * `compendium.facts.<key>` first, so a translated locale shows translated terms. The map
 * still matters because the importers emit keys faster than the catalog gains entries, and
 * an unknown key must degrade to readable English rather than a raw `camelCase` token.
 */
const LABEL_OVERRIDES: Record<string, string> = {
  ac: 'AC',
  eac: 'EAC',
  kac: 'KAC',
  hp: 'HP',
  hpPerLevel: 'HP per Level',
  dexCap: 'Dex Cap',
  itemCategory: 'Category',
  itemSubcategory: 'Subcategory',
  weaponCategory: 'Weapon Category',
  weaponGroup: 'Weapon Group',
  weaponType: 'Weapon Type',
  armorCategory: 'Armor Category',
  armorGroup: 'Armor Group',
  checkPenalty: 'Check Penalty',
  speedPenalty: 'Speed Penalty',
  itemBonus: 'Item Bonus',
  itemBonusNote: 'Item Bonus Note',
  savingThrow: 'Saving Throw',
  keyAbility: 'Key Attribute',
  attributeBoosts: 'Attribute Boosts',
  attributeFlaws: 'Attribute Flaws',
  heightenLevels: 'Heightened',
  pilotingCheck: 'Piloting',
  primaryCheck: 'Primary Check',
  secondaryCheck: 'Secondary Check',
  secondaryCasters: 'Secondary Casters',
  areaOfConcern: 'Area of Concern',
  favoredWeapons: 'Favored Weapons',
  divineFont: 'Divine Font',
  divineSkills: 'Divine Skills',
  clericSpells: 'Cleric Spells',
  creatureFamily: 'Family',
  perceptionProficiency: 'Perception',
  fortitudeProficiency: 'Fortitude',
  reflexProficiency: 'Reflex',
  willProficiency: 'Will',
  attackProficiency: 'Attack Proficiency',
  defenseProficiency: 'Defense Proficiency',
  skillProficiency: 'Skill Proficiency',
  damageType: 'Damage Type',
  hazardType: 'Hazard Type',
  vehicleType: 'Vehicle Type',
  baseItem: 'Base Item',
  countAsImpact: 'Counts as Impact',
};

/**
 * Reading order for the keys a rules reader scans first. Anything not listed sorts after
 * these, alphabetically — so a newly imported field still appears, just at the end.
 */
const KEY_ORDER = [
  'level',
  'rank',
  'price',
  'bulk',
  'itemCategory',
  'itemSubcategory',
  'category',
  'rarity',
  'usage',
  'hands',
  'damage',
  'damageType',
  'weaponCategory',
  'weaponGroup',
  'weaponType',
  'range',
  'reload',
  'ammunition',
  'expend',
  'upgrades',
  'grade',
  'ac',
  'dexCap',
  'checkPenalty',
  'speedPenalty',
  'strength',
  'armorCategory',
  'armorGroup',
  'hp',
  'hardness',
  'saves',
  'stealth',
  'complexity',
  'disable',
  'reset',
  'routine',
  'traditions',
  'cast',
  'components',
  'area',
  'duration',
  'onset',
  'targets',
  'savingThrow',
  'defense',
  'prerequisite',
  'trigger',
  'requirement',
  'frequency',
  'cost',
  'activate',
];

const ORDER_INDEX = new Map(KEY_ORDER.map((key, i) => [key, i]));

/** Values printed with an explicit sign, because the game prints them that way. */
const SIGNED_KEYS = new Set(['dexCap', 'checkPenalty', 'speedPenalty', 'itemBonus', 'perception']);

/** Numeric maps whose entries are modifiers rather than plain amounts. */
const SIGNED_MAP_KEYS = new Set(['saves', 'skills']);

function humanizeKey(key: string): string {
  const override = LABEL_OVERRIDES[key];
  if (override) return override;
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Catalog term for a fact key, falling back to the humanized English for unknown keys. */
function factLabel(key: string, translate: FactTranslate): string {
  return translate(`compendium.facts.${key}`, humanizeKey(key));
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

/**
 * Speed arrives as `{land: 20, fly: 40, max: 40}`. `max` is a derived convenience the
 * source adds for sorting, not a movement type — printing it would read as a fourth speed.
 */
function formatSpeedMap(value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [mode, raw] of Object.entries(value)) {
    if (mode === 'max') continue;
    if (typeof raw === 'number') parts.push(`${mode} ${raw} ft.`);
    else if (typeof raw === 'string' && raw.trim()) parts.push(`${mode} ${raw.trim()}`);
  }
  return parts.join(', ');
}

/**
 * The outcome of trying to render one value as a fact line.
 *
 * `lossless` is the important half. A flattener that renders what it understands and
 * silently returns '' for the rest looks correct on the data it was written against and
 * quietly discards everything else — and this component replaced the inventory card's raw
 * JSON disclosure, so "discarded here" meant "unreachable anywhere". Datasworn asset
 * entries are the live example: their `controls` nest four levels deep
 * (`integrity → controls → battered → …`), which no single-line rendering represents
 * honestly. Anything not `lossless` is therefore NOT dropped — {@link EntryFacts} keeps it
 * as raw data behind a disclosure.
 */
interface FormattedValue {
  text: string;
  lossless: boolean;
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function booleanText(v: boolean, translate: FactTranslate): string {
  return v ? translate('compendium.factValues.yes', 'Yes') : translate('compendium.factValues.no', 'No');
}

function scalarText(key: string, v: string | number | boolean, translate: FactTranslate): string {
  if (typeof v === 'boolean') return booleanText(v, translate);
  if (typeof v === 'number') return SIGNED_KEYS.has(key) ? signed(v) : String(v);
  return v.trim();
}

function formatValue(key: string, value: unknown, translate: FactTranslate): FormattedValue {
  if (value === null || value === undefined) return { text: '', lossless: true };
  if (isScalar(value)) return { text: scalarText(key, value, translate), lossless: true };

  if (Array.isArray(value)) {
    // A list of scalars reads fine inline; a list of objects does not, and flattening one
    // would drop structure the reader may need.
    if (!value.every((item) => item === null || item === undefined || isScalar(item))) {
      return { text: '', lossless: false };
    }
    const text = value
      .filter(isScalar)
      .map((item) => scalarText(key, item, translate))
      .filter(Boolean)
      .join(', ');
    return { text, lossless: true };
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (key === 'speed') return { text: formatSpeedMap(record), lossless: true };
    // One level of scalar-valued nesting is readable ("fortitude +9, reflex -1"); deeper
    // than that is not, so hand it to the raw-data disclosure instead of mangling it.
    if (!Object.values(record).every((v) => v === null || v === undefined || isScalar(v))) {
      return { text: '', lossless: false };
    }
    const signedMap = SIGNED_MAP_KEYS.has(key);
    const text = Object.entries(record)
      .map(([k, v]) => {
        if (typeof v === 'number') return `${k} ${signedMap ? signed(v) : v}`;
        if (typeof v === 'string' && v.trim()) return `${k} ${v.trim()}`;
        // Booleans nested inside a scalar map are the same problem one level down.
        if (typeof v === 'boolean') return `${k} ${booleanText(v, translate)}`;
        return '';
      })
      .filter(Boolean)
      .join(', ');
    return { text, lossless: true };
  }

  return { text: '', lossless: false };
}

/** Accept the raw `dataJson` string, an already-parsed object, or null; never throw. */
function normalize(data: unknown): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return null;
}

export function parseEntryFacts(data: unknown, translate: FactTranslate = englishFallback): ParsedEntryFacts | null {
  const d = normalize(data);
  if (!d) return null;

  const traits = Array.isArray(d.traits)
    ? d.traits.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean)
    : [];

  // `category` is the source's coarse index bucket ('weapon'), `itemCategory` the printed
  // shelf ('Weapons'). When both are present they are the same fact at two resolutions —
  // show only the specific one, which also keeps their shared "Category" label unique.
  const redundant = new Set<string>();
  if (typeof d.itemCategory === 'string' && d.itemCategory.trim()) redundant.add('category');

  const facts: EntryFact[] = [];
  const complex: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(d)) {
    if (HIDDEN_KEYS.has(key) || redundant.has(key)) continue;
    const { text, lossless } = formatValue(key, raw, translate);
    if (!lossless) {
      complex[key] = raw;
      continue;
    }
    if (!text) continue;
    facts.push({ key, label: factLabel(key, translate), value: text });
  }

  facts.sort((a, b) => {
    const ai = ORDER_INDEX.get(a.key) ?? Number.MAX_SAFE_INTEGER;
    const bi = ORDER_INDEX.get(b.key) ?? Number.MAX_SAFE_INTEGER;
    return ai !== bi ? ai - bi : a.label.localeCompare(b.label);
  });

  return facts.length > 0 || traits.length > 0 || Object.keys(complex).length > 0
    ? { facts, traits, complex }
    : null;
}

/** True when `data` yields at least one renderable fact or trait. */
export function hasEntryFacts(data: unknown): boolean {
  return parseEntryFacts(data) !== null;
}

/**
 * Renders the fact list. `compact` drops the font size for the inventory card, where the
 * facts sit inside an already-small provenance block.
 */
export function EntryFacts({
  data,
  label,
  compact = false,
}: {
  data: unknown;
  label?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  // One translator for the whole parse: labels AND the words a value renders as.
  const translate: FactTranslate = (key, defaultValue) => t(key, { defaultValue });
  const parsed = parseEntryFacts(data, translate);
  const listId = useId();
  if (!parsed) return null;
  const { facts, traits, complex } = parsed;
  const complexKeys = Object.keys(complex);
  const fontSize = compact ? 11.5 : 13;

  return (
    <section
      aria-label={label ?? t('compendium.facts.sectionLabel')}
      data-testid="entry-facts"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}
    >
      {traits.length > 0 && (
        <ul aria-label={t('compendium.facts.traits')} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: 0, padding: 0, listStyle: 'none' }}>
          {traits.map((trait) => (
            <li key={trait} className="tag tag-neutral" style={{ fontSize: compact ? 9.5 : 10, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
              {trait}
            </li>
          ))}
        </ul>
      )}
      {facts.length > 0 && (
        <dl
          id={listId}
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr)',
            columnGap: 10,
            rowGap: 3,
            margin: 0,
            fontSize,
            lineHeight: 1.5,
            minWidth: 0,
          }}
        >
          {/* A Fragment, not a wrapper element: `dt`/`dd` must be DIRECT children of the
              `dl` to sit on its two grid tracks. Wrapping each pair in a `div` and giving
              it `display: contents` lays out identically, but that declaration is known to
              drop the wrapped elements from the accessibility tree in some browser/AT
              combinations (Safari/VoiceOver) — which would cost this list the term/definition
              semantics it exists to carry. A Fragment renders no DOM node at all, so there
              is nothing to strip semantics from. */}
          {facts.map((fact) => (
            <Fragment key={fact.key}>
              <dt style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{fact.label}</dt>
              <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{fact.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {complexKeys.length > 0 && (
        // Nested mechanics no single line represents honestly (Datasworn asset controls,
        // for one). Collapsed so it never crowds the readable facts, but present — this
        // component replaced the inventory card's raw-JSON disclosure, so dropping these
        // would have made them unreachable from every surface.
        <details style={{ fontSize: compact ? 11 : 12 }}>
          <summary>{complexKeys.map((key) => factLabel(key, translate)).join(', ')}</summary>
          <pre
            data-testid="entry-facts-raw"
            style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: compact ? 10.5 : 11.5 }}
          >
            {JSON.stringify(complex, null, 2)}
          </pre>
        </details>
      )}
    </section>
  );
}

export default EntryFacts;
