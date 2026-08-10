/**
 * Derive a usable combat action from an equipped item's compendium data (issue #2097).
 *
 * Issue #1326 built the equipment loop but left this step to a human: an inventory item only
 * contributes to a character's action list when it carries an authored `equippedAction`, and
 * "compendium-derived auto-generation is out of scope" (its words). In practice nobody ever
 * authored one — there was no UI for it — so equipping a sword produced a badge and nothing
 * else. This module closes that gap.
 *
 * Three rules shape everything here:
 *
 *  - **Normalize, don't reimplement.** A compendium item's `dataJson` is reshaped into the
 *    same raw statblock shape {@link expandRawStatblockAction} already consumes, so the
 *    attack/damage/spec construction has exactly one implementation, shared with monster
 *    statblocks and the D&D Beyond importer.
 *
 *  - **System-aware, never system-assuming.** Attack math runs for an adapter that declares
 *    `weaponProficiencyBonus`, and only for one. Every other system still gets an action — its
 *    name and damage line are real data — but with no invented to-hit.
 *
 *  - **Degrade to text, never to wrong numbers.** When damage dice are not a dice expression
 *    (Open5e serves the SRD Net's as the string `"0"`) or the damage type is missing, the
 *    result is a text-only action rather than a resolvable spec built on a guess. A text-only
 *    action still appears in the list and can still be edited into a correct one; a fabricated
 *    +7 to hit is a lie the table will not notice.
 *
 * **Proficiency is read, not assumed** (issue #2144). This module used to have one deliberate
 * guess in it: 5e's to-hit includes a proficiency bonus *if the character is proficient with
 * the weapon*, the sheet recorded proficiency for saves and skills but never for weapons, so
 * the derivation assumed proficiency and said so in the action's own notes. That was defensible
 * for 5e, where the term is a single fixed number and most equipped weapons are ones the
 * character trained in. It was not defensible for PF2e, whose term is level plus a rank bonus
 * running +2 to +8 — a spread far too wide to guess — which is why a Pathfinder weapon showed a
 * damage line and a blank to-hit at all.
 *
 * `Character.weaponProficiencies` closed that gap, so the rank is now looked up (by the
 * weapon's name, then the categories it belongs to) and priced by the adapter. An UNTRAINED
 * wielder gets no proficiency term and is told so in the notes, which is the case the old
 * assumption was silently wrong about.
 */
import { z } from 'zod';
import { CharacterAction } from './character-action';
import { expandRawStatblockAction } from './combatant-statblock';
import { isRollableDamageExpression } from './dice-bounds';
import { weaponProficiencyRank, type ProficiencyRank } from './proficiency';

/**
 * The 5e-shaped subset of a rule-system adapter this module needs. Declared structurally (the
 * real `RuleSystemAdapter` satisfies it) so this file has no runtime dependency on index.ts,
 * mirroring `ResolverAdapter` in action-resolver.ts and for the same import-cycle reason.
 */
export interface ItemActionAdapter {
  readonly id: string;
  abilityModifier(score: number): number;
  /**
   * This system's canonical damage-type vocabulary, when it declares one (the 5e adapter
   * does). Review (chatgpt-codex-connector P2): damage defenses are matched by EXACT
   * lowercased type, so a noncanonical-but-short type like `"slashing damage"` produced a
   * resolvable spec whose damage sailed past a target's slashing immunity untouched — the
   * same silent-defense-bypass this module already refuses for an EMPTY type, reached by a
   * different door. An adapter that declares no vocabulary can't be checked against one, so
   * the length bound remains the only gate there.
   */
  readonly damageTypes?: readonly string[];
  /**
   * This system's proficiency term for an attack at `rank` (issue #2144). DECLARING IT IS WHAT
   * OPTS A SYSTEM INTO A DERIVED TO-HIT — see `RuleSystemAdapter.weaponProficiencyBonus`.
   *
   * Replaces the `adapter.id !== 'dnd5e'` gate this module used to open with. That check was a
   * stand-in for "does the resolver know this system's attack math", written before any hook
   * existed to ask; asking directly is both more honest and how PF2e — which has published its
   * own proficiency curve all along — stops being excluded by a name comparison.
   */
  weaponProficiencyBonus?(level: number, rank: ProficiencyRank): number;
  /**
   * How this system turns the wielder's ability modifier into weapon DAMAGE (issue #2144).
   * Omit for 5e's rule, which is the default: the same modifier that hit adds to the damage.
   *
   * PF2e does not work that way — a melee Strike adds STR to damage, a ranged one adds nothing
   * unless the weapon is Propulsive or Thrown (Player Core, "Damage"). Getting this wrong is
   * not cosmetic: every bow in the game would deal its wielder's DEX in extra damage on every
   * hit, forever, and the number looks perfectly plausible on the card.
   */
  weaponDamageModifier?(input: WeaponDamageModifierInput): number;
}

/** What an adapter needs to decide how much of the wielder's modifier reaches damage. */
export interface WeaponDamageModifierInput {
  /** The ability the ATTACK used, and its modifier. */
  abilityKey: 'STR' | 'DEX';
  abilityMod: number;
  strMod: number;
  ranged: boolean;
  /** Lowercased weapon traits/properties, e.g. `['finesse', 'thrown', 'propulsive']`. */
  traits: readonly string[];
}

/** The character fields the attack math reads. */
export interface ItemActionCharacter {
  /** Canonical ability scores, e.g. `{ STR: 16, DEX: 12 }`. */
  stats: Record<string, number>;
  level: number;
  /**
   * Weapon training as `weapon or category -> rank` (issue #2144). Omitted or empty means the
   * wielder is untrained with everything, which is what an unfilled sheet honestly says.
   */
  weaponProficiencies?: Record<string, string> | null;
}

export interface DeriveEquippedItemActionInput {
  /** The inventory item's name — becomes the action's name. */
  itemName: string;
  /** The item's parsed compendium `dataJson` (or its snapshot's). */
  data: unknown;
  /** The owning character, for ability modifiers and proficiency. */
  character: ItemActionCharacter;
  adapter: ItemActionAdapter;
}

/**
 * A weapon reduced to the handful of facts an attack needs, normalized across sources. Open5e
 * weapons (issue #2096) carry `itemKind: 'weapon'` with `damageDice`/`damageType`/`properties`;
 * Starfinder items carry flat `damage`/`damageType`/`range`; homebrew entries may use either
 * spelling. Everything downstream reads this, so adding a source means teaching
 * {@link weaponProfileFrom} one more shape rather than touching the math.
 */
interface WeaponProfile {
  damageDice: string;
  damageType: string;
  /** Attacks with DEX (a bow), as opposed to a thrown melee weapon that still reports a range. */
  ranged: boolean;
  /** 5e Finesse — attacks with the better of STR and DEX. */
  finesse: boolean;
  /**
   * True when the source data cannot say whether this is a melee or a ranged weapon, and the
   * distinction would change which ability the attack uses (issue #2097 review,
   * chatgpt-codex-connector P2).
   *
   * Open5e v2 publishes no melee/ranged discriminator — verified against the live endpoint:
   * the Dagger (simple MELEE) and the Dart (simple RANGED) are byte-identical in its payload,
   * both `range: 20/60`, `is_simple: true`, `properties: [Finesse, Thrown, …]`. The PHB's own
   * "Simple Melee / Simple Ranged" table column is simply not in the API, so there is nothing
   * to preserve at import time and no honest way to tell them apart here.
   *
   * Finesse takes the BETTER of STR and DEX, so the two readings only diverge for a wielder
   * whose STR beats their DEX: that is correct for a Dagger (melee finesse) and too high for a
   * Dart (ranged, which is DEX outright). Rather than guess, or degrade every thrown finesse
   * weapon — the Dagger is common and currently right — the action says so in its own notes,
   * the same way it already declares the proficiency assumption. Visible and correctable beats
   * silently right-most-of-the-time.
   */
  abilityAmbiguous: boolean;
  /**
   * The proficiency keys this weapon answers to, besides its own name (issue #2144): its
   * category ("simple", "martial", PF2e's "advanced"/"unarmed") and, for PF2e, its weapon group
   * ("sword"). Lowercased. A character trained in a category is trained with every weapon in
   * it, so these are what {@link weaponProficiencyRank} matches the sheet against.
   */
  categories: string[];
  /**
   * The BASE weapon this one is built on, when the source names it (issue #2144 review,
   * chatgpt-codex-connector P2): Open5e's magic items embed it, PF2e keeps `base_item`.
   *
   * A magic weapon's inventory name is not its base weapon's — "Longsword (+1)", "Smoking
   * Sword" — so a character trained in `Longsword` by name matched neither, and read as
   * untrained with the very weapon they specialise in. Category training hid this for most
   * characters, which is exactly why it would have been missed.
   */
  baseName: string;
  /** Lowercased traits/properties, for the system's damage rule (PF2e Propulsive/Thrown). */
  traits: string[];
}

/**
 * The proficiency keys a weapon's CATEGORY answers to (issue #2144 review,
 * chatgpt-codex-connector P2).
 *
 * Both the broad category and the melee/ranged split of it, because both are real training
 * grants: 5e's classes grant "simple weapons"/"martial weapons", while D&D Beyond also
 * publishes the split forms (`martial-melee-weapons`) that some subclasses grant. Emitting
 * only the broad word meant an imported character with the split proficiency matched nothing
 * at all — `martial melee` was a key no weapon ever produced.
 */
function categoryKeys(category: string, ranged: boolean): string[] {
  const base = category.trim().toLowerCase();
  if (!base) return [];
  return [base, `${base} ${ranged ? 'ranged' : 'melee'}`];
}

// Review (chatgpt-codex-connector P2): this used to be a local regex, which accepted shapes
// the ROLLER rejects — `21d6` (over the 20-dice cap) and `1d3` (not a polyhedral face) both
// look like dice and both throw when rolled. A spec built on one degraded not to a text-only
// action but to an error mid-combat. `isRollableDamageExpression` asks the roller's own
// bounds, so "resolvable" now means the same thing here as it does at roll time.

/** `DamagePart.type` is capped at 24 chars; a longer value would throw inside `ActionSpec.parse`. */
const MAX_DAMAGE_TYPE_LENGTH = 24;

/**
 * The largest attack bonus this module will build a spec from (issue #2097 review,
 * chatgpt-codex-connector P2). `AttackSpec.bonus` is a 20-character string, and a
 * schema-valid 20-digit `toHit` like `99999999999999999999` survives the regex, then rounds
 * through `Number` into an exponent-form string that blows that cap — throwing an unhandled
 * `ZodError` out of the expander, so saving the action 500s instead of degrading to the
 * text-only row this module promises for input it cannot represent. A tabletop attack bonus
 * has no business anywhere near this bound; it exists to keep unusable input on the
 * documented path rather than the error path.
 */
const MAX_ATTACK_BONUS_ABS = 999;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * A damage type as either a bare string or a list of them. PF2e items publish
 * `damageType: ['Slashing']` (Archives of Nethys models it as a list), where Open5e and
 * Starfinder publish a plain string — so reading only strings silently lost the type for a
 * whole rule system, leaving an untyped damage line. The first entry is taken: a weapon with
 * several listed types has no single canonical one to derive from, and this module's rule is
 * to prefer a plain, checkable answer over a composed guess.
 */
function damageTypeOf(v: unknown): string {
  if (Array.isArray(v)) {
    for (const entry of v) {
      const first = str(entry);
      if (first) return first;
    }
    return '';
  }
  return str(v);
}

/** Read an ability score tolerantly (uppercase-folded, default 10) — mirrors index.ts's own reader. */
function abilityScore(stats: Record<string, number>, ability: string): number {
  const raw = stats[ability.toUpperCase()] ?? stats[ability] ?? stats[ability.toLowerCase()];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 10;
}

function hasProperty(properties: unknown, name: string): boolean {
  if (!Array.isArray(properties)) return false;
  return (properties as unknown[]).some((p) => {
    const o = asRecord(p);
    return !!o && str(o.name).toLowerCase() === name.toLowerCase();
  });
}

/**
 * Whether the item's own compendium data CLASSIFIES it as a weapon, independently of whether
 * it carries usable numbers (issue #2144).
 *
 * Every importer records this, in its own vocabulary. Two kinds of evidence, both taken:
 *
 *  - a shelf that NAMES weapons — Open5e magic items publish `category: "Weapon"` (550 of the
 *    SRD's 2.3k of them), PF2e/SF2e publish the coarse `category: "weapon"` beside the printed
 *    `itemCategory: "Weapons"`, Pathfinder 1e and Starfinder 1e publish a `category` from the
 *    same shelf;
 *  - a field only a weapon HAS — PF2e/SF2e's `weaponCategory` ("Simple"), `weaponGroup`
 *    ("Shock") and `weaponType` ("Ranged") are absent from every other kind of item, so their
 *    presence is the classification even though none of their values is the word "weapon".
 *
 * None of this is a damage die, and this function makes no claim that it is — it answers only
 * "is this thing a weapon", which is what decides whether an equipped item deserves an attack
 * row at all.
 */
function declaresWeapon(d: Record<string, unknown>): boolean {
  for (const key of ['category', 'itemCategory'] as const) {
    const v = str(d[key]).toLowerCase();
    if (v === 'weapon' || v === 'weapons') return true;
  }
  return (['weaponCategory', 'weaponGroup', 'weaponType'] as const).some((key) => str(d[key]) !== '');
}

/**
 * Recognize a weapon and reduce it to {@link WeaponProfile}, or return null for anything that
 * isn't one. Returning null is the "this item grants no action" answer — a bedroll, a potion,
 * a magic item whose effect is prose rather than an attack. That is the common case and it
 * must stay silent: deriving a bogus action for every backpack would be worse than deriving
 * nothing at all.
 *
 * A weapon with NO readable damage is still a weapon (issue #2144). It comes back with an
 * empty `damageDice`, which every branch downstream already treats as "not derivable" and
 * turns into a text-only row saying so. That is the difference between a character sheet that
 * shows "Longsword (+1) — fill in its attack" and one that shows nothing at all, and the
 * second is indistinguishable from the feature being broken. Some magic weapons genuinely
 * have no base weapon to read (the SRD's generic "+1 Weapon"), and an inventory acquired
 * before its importer learned to keep the stats has none either.
 */
function weaponProfileFrom(data: unknown): WeaponProfile | null {
  const d = asRecord(data);
  if (!d) return null;

  // Open5e mundane weapons (issue #2096) — the explicit discriminator.
  if (str(d.itemKind).toLowerCase() === 'weapon') {
    // Ranged means "attacks with DEX", which is NOT the same as "reports a range": a thrown
    // Dagger carries a real 20/60 and is still a melee weapon whose attack uses STR (or DEX
    // via Finesse). Ammunition is the property that actually marks a bow/crossbow/sling.
    const ranged = hasProperty(d.properties, 'Ammunition');
    const finesse = hasProperty(d.properties, 'Finesse');
    const thrown = hasProperty(d.properties, 'Thrown');
    return {
      damageDice: str(d.damageDice),
      damageType: damageTypeOf(d.damageType),
      ranged,
      finesse,
      // See {@link WeaponProfile.abilityAmbiguous}: a thrown finesse weapon with no Ammunition
      // is either a melee weapon (Dagger) or a ranged one (Dart), and this data cannot say.
      abilityAmbiguous: !ranged && thrown && finesse,
      // Open5e's one weapon-category bit. A row that omits it (`isSimple: null` — homebrew, or
      // a magic item whose base weapon the SRD does not name) contributes no category, so the
      // wielder's category training cannot be claimed for it and only a by-name entry counts.
      categories: typeof d.isSimple === 'boolean' ? categoryKeys(d.isSimple ? 'simple' : 'martial', ranged) : [],
      baseName: str(d.baseItem),
      traits: propertyNames(d.properties),
    };
  }

  // An itemKind that names something else — Open5e's `armor` (issue #2096) — is a definite
  // "not a weapon", and must not fall through to the tolerant flat-key reading below.
  const itemKind = str(d.itemKind).toLowerCase();
  if (itemKind) return null;

  // PF2e/SF2e/Starfinder items and homebrew entries using the same flat keys.
  const rawDamage = str(d.damageDice) || str(d.damage);
  const damageType = damageTypeOf(d.damageType);
  if (!rawDamage && !declaresWeapon(d)) return null;
  const range = typeof d.range === 'number' ? d.range : null;
  const traits = [...stringList(d.traits), ...propertyNames(d.properties)];
  // AoN packs the damage type's abbreviation into the dice string — a PF2e Longsword is
  // `damage: "1d8 S"`, a Pulsecaster Pistol `"1d6 E"` (issue #2144). The letters duplicate
  // `damage_type`, which this profile already reads properly, and they make the string fail
  // every rollable-dice check, so the weapon degraded to a text-only row even once the
  // importer kept its stats. Only a trailing ALPHABETIC token is dropped, so a homebrew
  // `1d8+1` keeps its modifier.
  const damageDice = rawDamage.replace(/\s+[A-Za-z]{1,3}$/, '').trim();
  // PF2e states melee/ranged outright, which is strictly better data than Open5e's (see
  // `abilityAmbiguous` — that source cannot tell a Dagger from a Dart). Fall back to "reports a
  // positive range" for the flat-keyed sources that publish no such field.
  const weaponType = str(d.weaponType).toLowerCase();
  const ranged = weaponType ? weaponType === 'ranged' : range !== null && range > 0;
  return {
    damageDice,
    damageType,
    ranged,
    finesse: traits.includes('finesse'),
    // A flat-keyed source states its range or its weapon type outright, so there is no
    // melee/ranged ambiguity to warn about.
    abilityAmbiguous: false,
    // PF2e trains by category ("Simple"/"Martial"/"Advanced") and a character can also be
    // trained in a weapon GROUP ("Sword"); Starfinder 1e and PF1e publish a bare `category`.
    categories: [str(d.weaponCategory), str(d.weaponGroup), str(d.category)]
      .map((v) => v.toLowerCase())
      .filter((v) => v && v !== 'weapon' && v !== 'weapons' && v !== 'equipment')
      .flatMap((v) => categoryKeys(v, ranged)),
    baseName: str(d.baseItem),
    traits,
  };
}

/** Lowercased names from an Open5e-shaped `properties` array. */
function propertyNames(properties: unknown): string[] {
  if (!Array.isArray(properties)) return [];
  return (properties as unknown[])
    .map((p) => {
      const o = asRecord(p);
      return o ? str(o.name).toLowerCase() : str(p).toLowerCase();
    })
    .filter(Boolean);
}

/** Lowercased entries from a plain string array (`traits: ['Finesse', 'Propulsive']`). */
function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).map((e) => str(e).toLowerCase()).filter(Boolean);
}

/**
 * A named action with its known damage line, prose, and NO resolvable spec — the honest
 * output when the numbers aren't knowable.
 *
 * Review (Copilot): `damage` is populated whenever a damage line is known, rather than being
 * left empty with the text buried in `notes`. Action lists render `damage` prominently, so
 * hiding it there made a text-only row far less useful than the data behind it justified —
 * and contradicted this module's own claim that a non-5e system still gets a real damage
 * line, just no derived to-hit. Omitting the SPEC is what makes this text-only; omitting the
 * damage string was never the point.
 */
function textOnlyAction(itemName: string, desc: string, damage = ''): CharacterAction {
  return CharacterAction.parse({
    name: itemName.slice(0, 120),
    kind: 'attack',
    damage: damage.slice(0, 80),
    notes: desc.slice(0, 500),
  });
}

/**
 * Build the equipped-item action for `itemName`, or null when the item grants no attack.
 *
 * Never throws: every input here is external data (a compendium row, a homebrew paste, a
 * snapshot written by an older importer), and this runs on the equip path, where a malformed
 * item must not be able to fail the equip itself.
 */
export function deriveEquippedItemAction(input: DeriveEquippedItemActionInput): CharacterAction | null {
  const { itemName, character, adapter } = input;
  const name = str(itemName);
  if (!name) return null;

  const profile = weaponProfileFrom(input.data);
  if (!profile) return null;

  const diceUsable = isRollableDamageExpression(profile.damageDice);
  const normalizedType = profile.damageType.toLowerCase();
  const vocabulary = adapter.damageTypes;
  const typeUsable =
    normalizedType.length > 0 &&
    normalizedType.length <= MAX_DAMAGE_TYPE_LENGTH &&
    (!vocabulary || vocabulary.some((t) => t.toLowerCase() === normalizedType));

  try {
    // A system gets attack math when its ADAPTER declares the proficiency curve, not when its
    // id matches a string (issue #2144). The old `adapter.id !== 'dnd5e'` gate was a stand-in
    // written before any hook existed to ask — and it excluded PF2e, which has published
    // `pf2eProficiencyBonus` all along. A system that declares nothing still gets an action
    // with its real, sourced damage line and no to-hit, because borrowing 5e's numbers would
    // be exactly the "silent 5e math on a PF2e fight" the resolver refuses to do.
    const proficiencyFor = adapter.weaponProficiencyBonus;
    if (!proficiencyFor) {
      const line = [profile.damageDice, profile.damageType.toLowerCase()].filter(Boolean).join(' ');
      return textOnlyAction(
        name,
        line
          ? `Equipped weapon — ${line}. Attack bonus is not derived for this rule system; fill it in.`
          : 'Equipped weapon — fill in its attack bonus and damage.',
        line,
      );
    }

    if (!diceUsable || !typeUsable) {
      // Untyped damage would silently bypass a target's resistances and immunities in the
      // resolver, and unusable dice would only fail when someone actually rolls it mid-fight.
      // Both are worse than a row that plainly says "finish me".
      const known = [profile.damageDice, profile.damageType.toLowerCase()].filter(Boolean).join(' ');
      return textOnlyAction(
        name,
        known
          ? `Equipped weapon — ${known}. Its damage could not be read as a rollable, typed expression; check it.`
          : 'Equipped weapon — no usable damage on its compendium entry; fill it in.',
        known,
      );
    }

    const strMod = adapter.abilityModifier(abilityScore(character.stats, 'STR'));
    const dexMod = adapter.abilityModifier(abilityScore(character.stats, 'DEX'));
    // Finesse is the character's CHOICE of the better ability, so it can never be worse than
    // the plain STR attack; a ranged weapon is DEX outright.
    const abilityKey = profile.ranged ? 'DEX' : profile.finesse && dexMod > strMod ? 'DEX' : 'STR';
    const abilityMod = abilityKey === 'DEX' ? dexMod : strMod;
    // The wielder's ACTUAL training with this weapon (issue #2144), replacing the assumption
    // this module used to make and state in its own notes. It is read from the sheet — by the
    // weapon's name first, then the categories it belongs to — so an untrained character now
    // correctly gets no proficiency term instead of a silent grant of one.
    const rank = weaponProficiencyRank(character.weaponProficiencies, name, [
      // The base weapon is matched as a NAME, not a category: being trained in `Longsword`
      // is training in that weapon, and a "Longsword (+1)" is one.
      ...(profile.baseName ? [profile.baseName] : []),
      ...profile.categories,
    ]);
    const prof = proficiencyFor(character.level, rank);
    const toHit = abilityMod + prof;
    // How much of the modifier reaches DAMAGE is a separate, system-owned question — 5e's "the
    // same modifier that hit" is the default, PF2e's melee-only rule is not.
    const damageMod = adapter.weaponDamageModifier
      ? adapter.weaponDamageModifier({ abilityKey, abilityMod, strMod, ranged: profile.ranged, traits: profile.traits })
      : abilityMod;

    // Review (chatgpt-codex-connector P2): a weapon whose accepted dice ALREADY carry a flat
    // modifier — a homebrew `1d8+1` — must have it folded into the ability modifier, not
    // appended after it. `1d8+1+3` is a shape `damagePartsFrom` cannot split (it separates a
    // single modifier), so the whole string lands in `DamagePart.formula` with `flat: 0`, and
    // 5e's double-dice critical rule then re-rolls both flats instead of adding them once.
    // One combined modifier keeps the dice/flat split the resolver's crit maths depends on.
    // Count optional — a bare `d6` is one die, as the roller reads it.
    const diceMatch = profile.damageDice.replace(/\s+/g, '').match(/^(\d{0,2}d\d{1,3})(?:([+-])(\d{1,3}))?$/i);
    if (!diceMatch) {
      return textOnlyAction(name, 'Equipped weapon — its damage could not be read; fill it in.', profile.damageDice);
    }
    // Normalized to an explicit count. `damagePartsFrom` (combatant-statblock.ts) splits
    // dice from flat modifier with its own `\d+d\d+` pattern, so a bare `d6+3` would land
    // WHOLE in `DamagePart.formula` with `flat: 0` — and 5e's double-dice crit rule would
    // then re-roll the +3. Accept the shorthand on the way in, emit the canonical form.
    const baseDice = diceMatch[1].replace(/^d/i, '1d');
    const weaponFlat = diceMatch[2] ? (diceMatch[2] === '-' ? -1 : 1) * Number(diceMatch[3]) : 0;
    const totalFlat = weaponFlat + damageMod;
    const damageExpression =
      totalFlat === 0 ? baseDice : `${baseDice}${totalFlat > 0 ? '+' : '-'}${Math.abs(totalFlat)}`;
    // Combining can push the modifier past what the roller accepts even though each half was
    // fine on its own — text-only rather than a spec that throws at the table.
    if (!isRollableDamageExpression(damageExpression)) {
      const known = [profile.damageDice, profile.damageType.toLowerCase()].filter(Boolean).join(' ');
      return textOnlyAction(
        name,
        `Equipped weapon — ${known}. Its damage plus this character's modifier is outside the rollable range; check it.`,
        known,
      );
    }

    const signed = (n: number) => `${n >= 0 ? '+' : '-'}${Math.abs(n)}`;
    return expandRawStatblockAction(
      {
        name,
        attackBonus: toHit,
        damage: [{ expression: damageExpression, type: profile.damageType.toLowerCase() }],
        // The breakdown now reports the rank it READ rather than the one it assumed
        // (issue #2144). An untrained wielder is called out explicitly: a to-hit with no
        // proficiency term in it looks like a bug on the card unless the card says why, and
        // "you have not recorded training with this" is a fixable thing to be told.
        desc:
          `Derived from the equipped ${name}: ${abilityKey} ${signed(abilityMod)}, ${rank} ${signed(prof)}. ` +
          (rank === 'untrained'
            ? 'No training with this weapon is recorded on the sheet, so no proficiency is added — set it under Weapon training, or edit this action.'
            : 'Edit the action to add a magic bonus or any other modifier.') +
          // Only when the choice actually differed: a thrown finesse weapon whose wielder is
          // stronger than they are dexterous. If DEX won anyway, both readings agree and
          // there is nothing to warn about.
          (profile.abilityAmbiguous && abilityKey === 'STR'
            ? ' Its source data cannot say whether this is a melee or a thrown ranged weapon; a ranged one would use DEX instead.'
            : ''),
      },
      'attack',
      adapter.id,
    );
  } catch {
    // A shape that still slips past the guards above (an implausible score making the spec
    // fail validation, say) degrades to the same text-only row rather than failing the equip.
    return textOnlyAction(name, 'Equipped weapon — its compendium entry could not be read; fill in its attack.');
  }
}

/**
 * Where an item's `equippedAction` came from (issue #2097). `derived` is this module's output
 * and may be regenerated; `manual` is a human's authored or edited row and is never overwritten
 * by derivation. Null on rows that predate the column and on items with no action at all.
 */
export const EquippedActionSource = z.enum(['derived', 'manual']);
export type EquippedActionSource = z.infer<typeof EquippedActionSource>;

/**
 * Whether an authored action says anything beyond its own name (issue #2144).
 *
 * `CharacterAction` requires a `name` and defaults every other field to `''`, so the editor's
 * initial draft — prefilled with the item's name and nothing else — is a VALID action. Saving
 * it unchanged stored a row that shows no attack, rolls nothing, and, because derivation only
 * runs where no authored action exists, permanently suppressed the derived attack the item
 * would otherwise have granted. A player who opened the editor to see what it did came away
 * with strictly less than they started with, and no way back except the Remove button they had
 * no reason to suspect.
 *
 * A name alone is therefore treated as "no action": it is exactly what the blank draft is, and
 * an action carrying no mechanics is not something anyone means to author.
 */
export function equippedActionHasContent(action: CharacterAction | null | undefined): boolean {
  if (!action) return false;
  if (action.spec) return true;
  return [action.kind, action.toHit, action.damage, action.targetAc, action.notes].some((field) => field.trim() !== '');
}

/**
 * Parse the human-facing damage line ("1d8+3 slashing") into the structured part the resolver
 * rolls. Null when it is not one rollable, typed expression — which is a legitimate thing for
 * a human to type, and simply means this line cannot be compared against a spec.
 */
function damageLineToPart(damage: string): { formula: string; flat: number; type: string } | null {
  const m = damage.trim().match(/^(\d{0,2})d(\d{1,3})(?:\s*([+-])\s*(\d{1,3}))?\s+(.+)$/i);
  if (!m) return null;
  const flat = m[4] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
  return { formula: `${m[1] || '1'}d${m[2]}`, flat, type: m[5].trim().toLowerCase() };
}

/** A signed integer bonus ("+6", "7", "-1"), or null when the text is not one. */
function bonusOf(text: string): number | null {
  const m = text.trim().match(/^([+-]?\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Whether a supplied `spec` is consistent with the `toHit` / `damage` the same request is
 * displaying (issue #2097 review: chatgpt-codex-connector P1, twice).
 *
 * The problem this solves: a REST or MCP client naturally reads a whole action, edits the
 * numbers, and submits it back carrying the spec it was given. "A spec was supplied, so trust
 * it" then updates the display while combat keeps rolling the original — the exact defect the
 * editor was built to fix, reached through the other surface.
 *
 * The FIRST fix compared the supplied spec against the row's current action and called a match
 * a round trip. That identifies staleness by asking a third party, and the third party can move:
 * if client A reads spec X, client B commits spec Y, and A then submits its edit still carrying
 * X, the comparison against Y fails, X looks deliberately authored, and it is stored — display
 * says one thing, the dice say another. No amount of care in choosing the baseline fixes that;
 * the baseline is the bug.
 *
 * So nothing outside the request is consulted. A spec is stale precisely when it CONTRADICTS
 * the fields it arrived with, and that is decidable from the request alone:
 *
 *  - the attack bonus, when both the spec and `toHit` state one and they disagree;
 *  - the first hit-damage part, when `damage` reads as one rollable typed expression and the
 *    spec's own first part is a different formula, modifier, or type.
 *
 * Everything else is trusted: a spec with no attack (the MCP path for saves and effects), a
 * multi-part damage spec no single display line could describe, an ability-derived bonus with
 * no explicit number. Those are authored intent this function cannot second-guess.
 *
 * A spec that survives is one whose numbers ARE the displayed numbers, so trusting it and
 * rebuilding it would produce the same rolls — which is what makes the racy case harmless
 * rather than merely unlikely.
 */
function specAgreesWithFields(edited: CharacterAction): boolean {
  const spec = edited.spec;
  if (!spec) return true;

  const specBonus = bonusOf(spec.attack?.bonus ?? '');
  const fieldBonus = bonusOf(edited.toHit);
  // A spec stating a FIXED bonus is making a claim the display field has to repeat. Review
  // (chatgpt-codex-connector P1): requiring both sides to be numeric let a client clear
  // `toHit`, or replace it with prose, while round-tripping the spec — and a cleared field is
  // not "unknown", it is a different claim, so the card showed no attack bonus while combat
  // went on rolling the old one. An ABILITY-derived spec bonus (empty `bonus`, non-empty
  // `ability`) is deliberately not a fixed number and stays uncomparable.
  if (specBonus !== null && specBonus !== fieldBonus) return false;

  // Every damage part the spec rolls, from EVERY outcome branch (chatgpt-codex-connector P1,
  // twice). An attack puts its damage under `hit` and a save-based action under `failure`, so
  // a check that reads only `hit` compares nothing at all for half the shapes — the first fix
  // scanned every branch to decide whether the spec rolls damage, but then compared against
  // `hit` alone, which let a save action's display line be edited to 8d6 while combat kept
  // rolling the 2d6 stored under `failure`. One list, one rule.
  const specParts = Object.values(spec.outcomes ?? {}).flatMap((branch) => branch?.damage ?? []);
  const fieldPart = damageLineToPart(edited.damage);

  if (specParts.length === 0) {
    // The display states rollable typed damage the spec does not roll — adding
    // "1d6 bludgeoning" to a previously non-damaging attack, say.
    if (fieldPart) return false;
  } else if (specParts.length === 1) {
    // One part is what a round trip carries and what one display line can describe; more than
    // that is authored structure the line was never able to express, so there is nothing to
    // contradict.
    const part = specParts[0];
    if (fieldPart) {
      if (part.formula.toLowerCase() !== fieldPart.formula.toLowerCase()) return false;
      if (part.flat !== fieldPart.flat) return false;
      if (part.type.toLowerCase() !== fieldPart.type) return false;
    } else if (edited.damage.trim() === '' || specBonus !== null) {
      // A spec that rolls damage beside a display line that does not say so is the same lie as
      // a mismatched bonus, so the action is rebuilt — text-only when the fields cannot be
      // read, honest about being unfinished rather than rolling numbers the line disowns.
      //
      // CLEARED is unambiguous whatever the spec looks like: an empty field asserts there is
      // nothing to show, and no authoring intent is expressed by blanking the damage line on
      // an action that deals damage.
      //
      // PROSE is only a contradiction for the weapon shape — a spec stating a fixed attack
      // bonus, whose one damage part IS what the line describes. A save-based action
      // ("DC 15 DEX, 2d6 fire") legitimately carries one damage part beside a line no attack
      // parser can read, and rebuilding would throw its structure away.
      return false;
    }
  }

  return true;
}

/**
 * Rebuild the structured `spec` of a hand-edited equipped action from its own display fields
 * (issue #2097 review: chatgpt-codex-connector P1, Copilot).
 *
 * The editor exists so a player can fix an assumed proficiency bonus, add a magic weapon's +1,
 * or correct a damage die. But `ActionResolverService` resolves an attack from the structured
 * `spec`, NOT from `toHit`/`damage` — so an edit that carried the old spec through displayed
 * the corrected numbers while continuing to roll the original ones. Silently rolling different
 * numbers than it shows is the worst failure mode this feature could have had: it is invisible
 * at the table, and it defeats the single reason the editor was added.
 *
 * The contract:
 *  - A caller who supplies their OWN spec is trusted and untouched — that is the MCP path for
 *    authoring a rich action (saves, effects, action economy) the five text fields cannot express.
 *  - Otherwise the spec is rebuilt from `toHit` + `damage` through {@link expandRawStatblockAction},
 *    the same expander the derivation and every statblock use, so an edited action stays
 *    resolvable with the numbers the editor actually shows.
 *  - When those fields can't be read as a bonus and a rollable, typed damage expression, the
 *    action keeps its text and carries NO spec. Text-only is the correct outcome for input the
 *    resolver cannot honour — never a stale spec, and never an invented one.
 *
 * `name`, `kind`, and `notes` are preserved verbatim: they never feed the roll.
 */
export function rebuildEditedActionSpec(
  edited: CharacterAction,
  ruleSystem = '',
  /**
   * The system's canonical damage-type vocabulary, when it has one. Same reasoning as the
   * derivation's own check: defenses match by exact lowercased type, so a hand-typed
   * "slashing damage" would build a resolvable spec whose damage ignores slashing immunity.
   * A human typed it, but they typed it into a field labelled "1d8+3 slashing" — the honest
   * response is a text-only action they can see is unfinished, not silent defense bypass.
   */
  damageTypes?: readonly string[],
): CharacterAction {
  // A supplied spec is trusted only while it AGREES with the numbers the caller is displaying.
  // See {@link specAgreesWithFields} for why the test is self-consistency rather than a
  // comparison against the stored row.
  if (edited.spec && specAgreesWithFields(edited)) return edited;

  const bonusMatch = edited.toHit.trim().match(/^([+-]?\d+)$/);
  const bonus = bonusMatch ? Number(bonusMatch[1]) : null;
  // `damage` is the human-facing "1d8+3 slashing" line: dice first, type as the remainder.
  // Count optional here too, so a hand-typed `d6 slashing` is accepted exactly as `1d6` is.
  const damageMatch = edited.damage.trim().match(/^(\d{0,2}d\d{1,3}(?:\s*[+-]\s*\d{1,3})?)\s+(.+)$/i);
  const damageType = damageMatch ? damageMatch[2].trim().toLowerCase() : '';
  // Same roller check as the derivation: a hand-typed "21d6 slashing" must become a text-only
  // action, not a resolvable spec that throws the first time someone attacks with it.
  const withoutSpec = CharacterAction.parse({ ...edited, spec: undefined });
  if (
    bonus === null ||
    !Number.isFinite(bonus) ||
    Math.abs(bonus) > MAX_ATTACK_BONUS_ABS ||
    !damageMatch ||
    !isRollableDamageExpression(damageMatch[1]) ||
    !damageType ||
    damageType.length > MAX_DAMAGE_TYPE_LENGTH ||
    (damageTypes && !damageTypes.some((t) => t.toLowerCase() === damageType))
  ) {
    return withoutSpec;
  }

  try {
    const rebuilt = expandRawStatblockAction(
      {
        name: edited.name,
        attackBonus: bonus,
        // Same normalization as the derivation: an explicit count so the expander can split
      // dice from modifier. The human's own `damage` text is preserved as typed.
      damage: [{ expression: damageMatch[1].replace(/\s+/g, '').replace(/^d/i, '1d'), type: damageType }],
        desc: edited.notes,
      },
      'attack',
      ruleSystem,
    );
    // The expander owns the spec; everything the human typed is theirs and is kept as typed.
    return CharacterAction.parse({ ...withoutSpec, spec: rebuilt.spec });
  } catch {
    // Backstop, matching `deriveEquippedItemAction`'s own guard: this module is TOTAL, and
    // every escape hatch leads to a text-only action rather than out of the function. The
    // explicit bounds above are what this path is expected to be — a `ZodError` reaching
    // here means the expander grew a constraint this function does not yet know about, and
    // an unfinished-looking action beats a 500 on save.
    return withoutSpec;
  }
}
