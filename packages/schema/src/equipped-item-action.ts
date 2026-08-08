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
 *  - **System-aware, never system-assuming.** Attack math runs only for an adapter that has
 *    5e's ability-modifier and level-based proficiency shape. Every other system still gets
 *    an action — its name and damage line are real data — but with no invented to-hit.
 *
 *  - **Degrade to text, never to wrong numbers.** When damage dice are not a dice expression
 *    (Open5e serves the SRD Net's as the string `"0"`) or the damage type is missing, the
 *    result is a text-only action rather than a resolvable spec built on a guess. A text-only
 *    action still appears in the list and can still be edited into a correct one; a fabricated
 *    +7 to hit is a lie the table will not notice.
 *
 * One deliberate, documented assumption: **proficiency**. 5e's to-hit is ability modifier plus
 * proficiency bonus *if the character is proficient with the weapon*, and Campfire's `Character`
 * has no weapon-proficiency data at all — `saveProficiencies` covers saves and `skills` covers
 * skills, and neither says whether this fighter trained with a halberd. The D&D Beyond importer
 * faces the same gap and resolves it by leaving such weapons text-only, because an import is a
 * one-shot with no visible provenance and no edit affordance. This path is different in exactly
 * those two respects: the derived row is labelled as derived, states the assumption in its own
 * notes, and sits behind an editor. So it assumes proficiency (true for the overwhelming
 * majority of weapons a character chooses to equip), shows its work, and lets anyone correct it.
 * That is an explicit default, not silent math.
 */
import { z } from 'zod';
import { CharacterAction } from './character-action';
import { expandRawStatblockAction } from './combatant-statblock';
import { isRollableDamageExpression } from './dice-bounds';

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
}

/** The character fields the attack math reads. */
export interface ItemActionCharacter {
  /** Canonical ability scores, e.g. `{ STR: 16, DEX: 12 }`. */
  stats: Record<string, number>;
  level: number;
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
}

// Review (chatgpt-codex-connector P2): this used to be a local regex, which accepted shapes
// the ROLLER rejects — `21d6` (over the 20-dice cap) and `1d3` (not a polyhedral face) both
// look like dice and both throw when rolled. A spec built on one degraded not to a text-only
// action but to an error mid-combat. `isRollableDamageExpression` asks the roller's own
// bounds, so "resolvable" now means the same thing here as it does at roll time.

/** `DamagePart.type` is capped at 24 chars; a longer value would throw inside `ActionSpec.parse`. */
const MAX_DAMAGE_TYPE_LENGTH = 24;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Read an ability score tolerantly (uppercase-folded, default 10) — mirrors index.ts's own reader. */
function abilityScore(stats: Record<string, number>, ability: string): number {
  const raw = stats[ability.toUpperCase()] ?? stats[ability] ?? stats[ability.toLowerCase()];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 10;
}

/** 5e proficiency bonus by level. Duplicated from index.ts's `dnd5eProficiencyBonus` only to avoid an import cycle. */
function proficiencyBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

function hasProperty(properties: unknown, name: string): boolean {
  if (!Array.isArray(properties)) return false;
  return (properties as unknown[]).some((p) => {
    const o = asRecord(p);
    return !!o && str(o.name).toLowerCase() === name.toLowerCase();
  });
}

/**
 * Recognize a weapon and reduce it to {@link WeaponProfile}, or return null for anything that
 * isn't one. Returning null is the "this item grants no action" answer — a bedroll, a potion,
 * a magic item whose effect is prose rather than an attack. That is the common case and it
 * must stay silent: deriving a bogus action for every backpack would be worse than deriving
 * nothing at all.
 */
function weaponProfileFrom(data: unknown): WeaponProfile | null {
  const d = asRecord(data);
  if (!d) return null;

  // Open5e mundane weapons (issue #2096) — the explicit discriminator.
  if (str(d.itemKind).toLowerCase() === 'weapon') {
    return {
      damageDice: str(d.damageDice),
      damageType: str(d.damageType),
      // Ranged means "attacks with DEX", which is NOT the same as "reports a range": a thrown
      // Dagger carries a real 20/60 and is still a melee weapon whose attack uses STR (or DEX
      // via Finesse). Ammunition is the property that actually marks a bow/crossbow/sling.
      ranged: hasProperty(d.properties, 'Ammunition'),
      finesse: hasProperty(d.properties, 'Finesse'),
    };
  }

  // Starfinder items (starfinder-importer.ts) and homebrew entries using the same flat keys.
  const damageDice = str(d.damageDice) || str(d.damage);
  const damageType = str(d.damageType);
  if (!damageDice) return null;
  const range = typeof d.range === 'number' ? d.range : null;
  return {
    damageDice,
    damageType,
    ranged: range !== null && range > 0,
    finesse: hasProperty(d.properties, 'Finesse'),
  };
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
    // Only a 5e-shaped adapter gets attack math. Another system's weapon still becomes an
    // action — the damage line is real, sourced data — but with no to-hit this module has no
    // business computing. `resolveAttack`/`checkProficiencyBonus`-style hooks are how a
    // system would opt in later; until one does, borrowing 5e's numbers would be exactly the
    // "silent PF2e math on a 5e fight" the resolver refuses to do, in the other direction.
    if (adapter.id !== 'dnd5e') {
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
    const prof = proficiencyBonus(character.level);
    const toHit = abilityMod + prof;

    // Review (chatgpt-codex-connector P2): a weapon whose accepted dice ALREADY carry a flat
    // modifier — a homebrew `1d8+1` — must have it folded into the ability modifier, not
    // appended after it. `1d8+1+3` is a shape `damagePartsFrom` cannot split (it separates a
    // single modifier), so the whole string lands in `DamagePart.formula` with `flat: 0`, and
    // 5e's double-dice critical rule then re-rolls both flats instead of adding them once.
    // One combined modifier keeps the dice/flat split the resolver's crit maths depends on.
    const diceMatch = profile.damageDice.replace(/\s+/g, '').match(/^(\d+d\d+)(?:([+-])(\d+))?$/i);
    if (!diceMatch) {
      return textOnlyAction(name, 'Equipped weapon — its damage could not be read; fill it in.', profile.damageDice);
    }
    const baseDice = diceMatch[1];
    const weaponFlat = diceMatch[2] ? (diceMatch[2] === '-' ? -1 : 1) * Number(diceMatch[3]) : 0;
    const totalFlat = weaponFlat + abilityMod;
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
        desc:
          `Derived from the equipped ${name}: ${abilityKey} ${signed(abilityMod)}, proficiency ${signed(prof)}. ` +
          'Assumes proficiency with this weapon — edit the action if that is wrong, or to add a magic bonus.',
      },
      'attack',
      'dnd5e',
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
  if (edited.spec) return edited;

  const bonusMatch = edited.toHit.trim().match(/^([+-]?\d+)$/);
  // `damage` is the human-facing "1d8+3 slashing" line: dice first, type as the remainder.
  const damageMatch = edited.damage.trim().match(/^(\d+d\d+(?:\s*[+-]\s*\d+)?)\s+(.+)$/i);
  const damageType = damageMatch ? damageMatch[2].trim().toLowerCase() : '';
  // Same roller check as the derivation: a hand-typed "21d6 slashing" must become a text-only
  // action, not a resolvable spec that throws the first time someone attacks with it.
  if (
    !bonusMatch ||
    !damageMatch ||
    !isRollableDamageExpression(damageMatch[1]) ||
    !damageType ||
    damageType.length > MAX_DAMAGE_TYPE_LENGTH ||
    (damageTypes && !damageTypes.some((t) => t.toLowerCase() === damageType))
  ) {
    return CharacterAction.parse({ ...edited, spec: undefined });
  }

  const rebuilt = expandRawStatblockAction(
    {
      name: edited.name,
      attackBonus: Number(bonusMatch[1]),
      damage: [{ expression: damageMatch[1].replace(/\s+/g, ''), type: damageType }],
      desc: edited.notes,
    },
    'attack',
    ruleSystem,
  );
  // The expander owns the spec; everything the human typed is theirs and is kept as typed.
  return CharacterAction.parse({ ...edited, spec: rebuilt.spec });
}
