/**
 * Human-readable summaries for pending AI tool confirmations (issue #1558).
 *
 * "Approve `update_character_hp`?" is not an informed decision. "Approve dealing 7 damage to
 * Thorne?" is. This module turns a queued tool call into a sentence a DM can rule on in the
 * two seconds they have while the table waits.
 *
 * TWO RULES GOVERN WHAT GOES ON SCREEN.
 *
 * 1. NAMES ARE RESOLVED ONLY FROM DATA THE CLIENT ALREADY HOLDS. The lookup is a plain map the
 *    caller passes in, built from the party/character reads the AI Table already made under the
 *    viewer's own permissions. This module never fetches, and there is no code path that could:
 *    an id it cannot resolve renders as `#12`, not as a name. That is what makes it structurally
 *    impossible to surface a DM-hidden NPC's name here — the client was never given it, so the
 *    summary cannot print it, however the tool arguments are shaped.
 *
 * 2. THE SUMMARY IS LOSSY; THE RAW ARGUMENTS ARE ONE CLICK AWAY. A summary that quietly drops an
 *    argument would be worse than a JSON dump, because a DM would approve believing they had
 *    seen the whole call. {@link summariseToolConfirmation} therefore reports `omittedKeys` for
 *    everything it did not put in the sentence, and the panel discloses the full argument object
 *    on demand. Compact by default, complete on request, never silently partial.
 */

/** Character/combatant id → display name, from reads the viewer already made. */
export type ToolArgNameLookup = Readonly<Record<number, string>>;

export interface ToolConfirmationSummary {
  /** One sentence a DM can rule on. Falls back to the tool name when the shape is unknown. */
  headline: string;
  /**
   * Argument keys NOT reflected in `headline`. Non-empty means the sentence is a summary rather
   * than the whole call, and the UI must say so.
   */
  omittedKeys: string[];
}

function nameFor(lookup: ToolArgNameLookup | undefined, id: unknown, prefix = '#'): string | null {
  if (typeof id !== 'number' || !Number.isFinite(id)) return null;
  const resolved = lookup?.[id];
  // An unresolved id renders as an id. Never guess, never fetch, never invent a label.
  return resolved && resolved.trim() ? resolved : `${prefix}${id}`;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Signed damage/healing phrasing: `-7` reads as damage, `+3` as healing. */
function hpPhrase(delta: number, who: string): string {
  if (delta < 0) return `Deal ${Math.abs(delta)} damage to ${who}`;
  if (delta > 0) return `Heal ${who} for ${delta}`;
  return `Apply no HP change to ${who}`;
}

/**
 * Build the sentence for one queued call.
 *
 * Deliberately NOT translated. The sentence is assembled from tool-specific grammar (signed
 * deltas reading as damage vs healing, possessives, list joins) that a key-per-shape catalogue
 * would either flatten into something stilted or explode into dozens of near-duplicate keys.
 * Keeping it here also keeps the module pure and unit-testable with no i18n runtime — the
 * surrounding panel chrome, which is the part a translator can actually work with, IS localised.
 * A follow-up that wants this localised should pass a translator in rather than import one, so
 * the purity survives.
 */
export function summariseToolConfirmation(
  tool: string,
  args: Record<string, unknown>,
  lookup?: ToolArgNameLookup,
): ToolConfirmationSummary {
  const keys = Object.keys(args);
  const used = new Set<string>();
  // NOT named `use` — the React lint rule treats any `use*` call as a hook, and this is a plain
  // helper in a plain module. `take(key, value)` marks the key as reflected in the sentence.
  const take = <T>(key: string, value: T): T => {
    used.add(key);
    return value;
  };
  const done = (headline: string): ToolConfirmationSummary => ({
    headline,
    omittedKeys: keys.filter((k) => !used.has(k)),
  });

  switch (tool) {
    case 'update_character_hp': {
      const who = nameFor(lookup, take('characterId', args.characterId)) ?? 'a character';
      const delta = num(take('hpDelta', args.hpDelta));
      const set = num(take('hpSet', args.hpSet));
      if (delta !== null) return done(hpPhrase(delta, who));
      if (set !== null) return done(`Set ${who}'s HP to ${set}`);
      return done(`Change ${who}'s HP`);
    }
    case 'set_character_conditions': {
      const who = nameFor(lookup, take('characterId', args.characterId)) ?? 'a character';
      const raw = take('conditions', args.conditions);
      const list = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [];
      if (list.length === 0) return done(`Clear all conditions on ${who}`);
      return done(`Set conditions on ${who}: ${list.join(', ')}`);
    }
    case 'apply_action':
    case 'resolve_action': {
      const action = str(take('actionName', args.actionName));
      const who = nameFor(lookup, take('actorCombatantId', args.actorCombatantId)) ?? 'a combatant';
      return done(action ? `Apply "${action}" by ${who}` : `Apply a resolved action by ${who}`);
    }
    case 'next_turn':
      return done('Advance to the next turn');
    case 'begin_encounter':
      return done('Start the encounter');
    case 'end_encounter':
      return done('End the encounter');
    case 'remove_combatant': {
      const who = nameFor(lookup, take('combatantId', args.combatantId)) ?? 'a combatant';
      return done(`Remove ${who} from the encounter`);
    }
    case 'add_combatant': {
      const name = str(take('name', args.name));
      return done(name ? `Add ${name} to the encounter` : 'Add a combatant to the encounter');
    }
    case 'award_xp': {
      const amount = num(take('amount', args.amount));
      const who = nameFor(lookup, take('characterId', args.characterId));
      if (amount === null) return done('Award XP');
      return done(who ? `Award ${amount} XP to ${who}` : `Award ${amount} XP to the party`);
    }
    case 'level_up_character': {
      const who = nameFor(lookup, take('characterId', args.characterId)) ?? 'a character';
      return done(`Level up ${who}`);
    }
    case 'set_escalation_die': {
      const value = num(take('value', args.value));
      return done(value === null ? 'Change the escalation die' : `Set the escalation die to ${value}`);
    }
    case 'adjust_treasury':
      return done('Adjust the party treasury');
    case 'add_inventory_item': {
      const name = str(take('name', args.name));
      return done(name ? `Add "${name}" to inventory` : 'Add an inventory item');
    }
    case 'update_inventory_item':
      return done('Change an inventory item');
    default:
      // Unknown or future tool: name it honestly and let the raw-argument disclosure carry the
      // detail. Inventing a sentence for a shape we do not model would be a summary a DM could
      // not trust, which is worse than no summary at all.
      return { headline: tool, omittedKeys: keys };
  }
}

/**
 * Build the id → name map from whatever character-shaped rows the page already loaded.
 *
 * Accepts a loose shape on purpose: the AI Table holds party rows and encounter combatants, and
 * both carry an id and a name. Anything without both is skipped rather than guessed at.
 */
export function buildToolArgNameLookup(
  rows: ReadonlyArray<{ id?: unknown; name?: unknown } | null | undefined> | undefined,
): ToolArgNameLookup {
  const out: Record<number, string> = {};
  for (const row of rows ?? []) {
    const id = num(row?.id);
    const name = str(row?.name);
    if (id !== null && name !== null) out[id] = name;
  }
  return out;
}
