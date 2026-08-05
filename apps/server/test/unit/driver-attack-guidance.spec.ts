import {
  buildGroundingPreamble,
  GROUNDING_PREAMBLE,
  resolverSpeaksCampaignSystem,
} from '../../src/modules/ai-driver/ai-driver.service';
import {
  ActionSpec,
  criticalDamageRuleForAdapter,
  Dnd5eAdapter,
  isResolvableSpec,
  Pf2eAdapter,
  RESOLVER_MATH_D20_5E,
  resolverImplementsSystemMath,
  rollBranchDamage,
  Sf2eAdapter,
  type HomebrewMechanicsProfile,
  type OutcomeBranch,
} from '@campfire/schema';

/**
 * #1053 — the AI DM must be TOLD that server-side attack resolution exists.
 *
 * ── Do not delete this as prompt trivia ───────────────────────────────────────────────
 * The issue was filed as "no tool combines roll d20 + compare AC + apply damage; the AI must
 * chain three or more calls and each step risks hallucination". The observation was true and
 * the diagnosis was wrong: `resolve_action` (#414) had done all of it server-side — adapter-
 * aware hit/miss/crit, critical damage, resistance/immunity, atomic apply, undo token — and
 * was already on the driver's live-play allowlist. What was missing was one
 * sentence in the system prompt. The preamble said "you may resolve live play directly: ROLL
 * DICE, apply HP/conditions…", which is a description of the manual chain, and never named
 * `resolve_action` at all.
 *
 * So the capability existed, the allowlist permitted it, and the model was told to do it the
 * manual way. NOTHING in the test suite could detect that, which is why this file exists: a
 * prompt regression that silently reintroduces hand-rolled attacks looks identical to a
 * passing build. These assertions are the detector.
 */

const preamble = GROUNDING_PREAMBLE;

describe('driver system prompt names the server-side attack path (#1053)', () => {
  it('tells the model to use resolve_action for attacks', () => {
    expect(preamble).toMatch(/resolve_action/);
    expect(preamble).toMatch(/attack/i);
  });

  it('no longer offers "roll dice" as the way to resolve live play', () => {
    // The exact phrasing that caused the issue. A future edit that reinstates an unqualified
    // "roll dice" in the live-play sentence puts the model straight back on the manual chain.
    expect(preamble).not.toMatch(/resolve live play directly:[^\n]*roll dice/i);
  });

  it('says a single call can both resolve and apply', () => {
    // Without this the model resolves, then has to decide to apply — and a preview it never
    // commits is a narrated attack that never touched anyone's HP.
    expect(preamble).toMatch(/commit\s*:\s*true/i);
  });

  it('qualifies what roll_dice is still FOR, so the ambiguity does not return', () => {
    // An unqualified "you may roll dice" is what created the ambiguity in the first place.
    expect(preamble).toMatch(/roll_dice/);
    expect(preamble).toMatch(/roll_dice[^\n]*(no target|no consequence)/i);
  });

  it('defers the crit rule to the campaign system instead of asserting one', () => {
    // This preamble is shared by EVERY campaign, so a concrete crit rule in it is wrong for
    // some table: 5e doubles the dice, PF2e/SF2e double the total. An earlier draft of this
    // very line said "a crit doubles the dice, never the flat modifier" — true for 5e only,
    // and stated as universal. The prompt promises the server applies the system's rule; the
    // server keeps that promise via criticalDamageRuleForAdapter.
    expect(preamble).toMatch(/critical rule/i);
    expect(preamble).not.toMatch(/doubles the dice/i);
    expect(preamble).toMatch(/never recompute a crit yourself/i);
  });

  /**
   * #1053 review — a STANDALONE save is `saving_throw`'s job (#1040), not `resolve_action`'s.
   * `resolve_action` needs an encounter, an actor combatant, targets and an outcome spec, so
   * "make a DC 15 Dexterity save" outside combat is a call the model cannot even construct.
   * An earlier draft steered every save at `resolve_action`; these pin the split.
   */
  describe('saving throws are steered at the right tool', () => {
    it('names saving_throw for a standalone save', () => {
      expect(preamble).toMatch(/saving_throw/);
      expect(preamble).toMatch(/STANDALONE saving throw[^\n]*saving_throw/);
    });

    it('does not blanket-forbid saves in favour of resolve_action', () => {
      // The regression to catch: any sentence that tells the model to use resolve_action FOR
      // a saving throw without the "part of an action" qualifier.
      expect(preamble).not.toMatch(/a saving throw[^\n]*use resolve_action/i);
    });

    it('still routes an action-embedded save through resolve_action', () => {
      // The other half: a save that IS a structured action's outcome must not be split into
      // a bare saving_throw, or nothing applies the success/failure branch.
      expect(preamble).toMatch(/resolve_action instead only when the save is part of an action/i);
    });
  });
});

/**
 * #1053 review — the guidance is only as correct as the code behind it, and the gate that
 * enforces that must FAIL CLOSED.
 *
 * Three implementations named by this preamble are 5e-shaped:
 *  - `resolveOneTarget` always rolls exactly `1d20` plus a flat modifier. Open Legend resolves
 *    attacks with exploding ATTRIBUTE DICE POOLS, so the roll itself is wrong there.
 *  - `classifyAttackOutcome` compares `total >= targetAc`, ASCENDING AC. An OSR variant on the
 *    DESCENDING convention hits on `roll >= thac0 - descendingAc`, so against descending AC 2
 *    the ascending comparison calls almost any positive total a hit — and `commit:true` then
 *    writes that damage. Wrong HP at a live table, not a cosmetic mismatch.
 *  - proficiency is 5e's level-based bonus. `ActionResolverService.proficiencyBonus` returns 0
 *    for every non-5e adapter, so a trained PF2e character's save total is understated and can
 *    select the wrong degree-of-success branch; the standalone `saving_throw` tool (#1040)
 *    hardcodes the same 5e formula.
 *
 * The first version of this gate was a BLOCKLIST — descending-AC OSR only — and review found one
 * more broken system per round, because a blocklist's default is "guidance on". It is now an
 * ALLOWLIST derived from the adapter's own `resolverMath` declaration: unlisted means withheld,
 * so a newly added system is safe before anyone has audited it. The failure mode of a mistake
 * here is committing HP off the wrong arithmetic, which is why the default has to be closed.
 *
 * These assertions pin the POLARITY. A future edit that reintroduces a "known-bad" list should
 * fail here rather than at a live table.
 */
describe('attack / save guidance is gated on an adapter capability, and fails closed (#1053)', () => {
  it('serves the campaigns whose maths the resolver actually implements — 5e, and the slugs that fall back to it', () => {
    for (const slug of ['', null, 'dnd5e', 'open5e-srd', 'not-a-real-system']) {
      expect(resolverSpeaksCampaignSystem(slug)).toBe(true);
      const text = buildGroundingPreamble(slug);
      expect(text).toMatch(/To resolve an ATTACK, call resolve_action/);
      expect(text).toMatch(/STANDALONE saving throw[^\n]*saving_throw/);
    }
  });

  it('withholds it from every system nobody has declared — including ones no reviewer has looked at', () => {
    // pf2e/sf2e: proficiency understated. open-legend: not a d20 at all. basic-fantasy/osric:
    // descending AC. pathfinder-1e/archmage: simply unaudited — and that is the point, they are
    // withheld WITHOUT anyone having had to notice them first.
    for (const slug of ['pf2e', 'sf2e', 'open-legend', 'basic-fantasy', 'osric', 'ose', 'pathfinder-1e']) {
      expect(resolverSpeaksCampaignSystem(slug)).toBe(false);
      const gated = buildGroundingPreamble(slug);
      // The dangerous instructions must be ABSENT, not merely qualified elsewhere.
      expect(gated).not.toMatch(/To resolve an ATTACK, call resolve_action/);
      expect(gated).not.toMatch(/call saving_throw with the character and the DC/);
      expect(gated).not.toMatch(/commit\s*:\s*true/i);
    }
  });

  it('is opt-in at the adapter, so an adapter that declares nothing is withheld by construction', () => {
    // The polarity itself. `resolverImplementsSystemMath` is what the driver asks; an adapter
    // object with no `resolverMath` is unsupported without any list needing to mention it.
    expect(resolverImplementsSystemMath({})).toBe(false);
    expect(resolverImplementsSystemMath({ resolverMath: RESOLVER_MATH_D20_5E })).toBe(true);
    expect(resolverImplementsSystemMath(Dnd5eAdapter)).toBe(true);
    expect(resolverImplementsSystemMath(Pf2eAdapter)).toBe(false);
    expect(resolverImplementsSystemMath(Sf2eAdapter)).toBe(false);
  });

  it('tells a withheld table what to do INSTEAD, rather than going quiet', () => {
    // A gate that only deletes sentences drops the model back to the manual chain silently —
    // the exact failure #1053 was filed about. It must name the limit and hand over to the DM.
    const gated = buildGroundingPreamble('pf2e');
    expect(gated).toMatch(/implement D&D 5e maths/);
    expect(gated).toMatch(/do NOT use them to decide whether an attack hits or whether a save succeeds/);
    expect(gated).toMatch(/let the human DM make the call/);
    expect(gated).toMatch(/Never assert a hit, a miss, or a save result yourself/);
  });

  it('gates ONLY the attack/save block — everything else is system-neutral', () => {
    const gated = buildGroundingPreamble('pf2e');
    for (const shared of [
      'Never invent rules',
      'You MAY author encounters',
      'roll_dice is for rolls with no target',
      'Respect the session-zero charter',
    ]) {
      expect(gated).toContain(shared);
      expect(GROUNDING_PREAMBLE).toContain(shared);
    }
  });

  it('GROUNDING_PREAMBLE stays the 5e-shaped text, so existing callers are unchanged', () => {
    expect(GROUNDING_PREAMBLE).toBe(buildGroundingPreamble('dnd5e'));
  });

  // #1502 review. An unrecognized slug resolves to the 5e adapter, and that is honest: those
  // campaigns really do get 5e maths. A slug BACKED BY A PERSISTED HOMEBREW PROFILE does not —
  // it gets that profile's ability table, AC convention and initiative. Asking the gate with
  // the slug alone kept answering "5e speaks this system" for exactly the campaigns that had
  // just stopped being 5e, and this gate fails OPEN when it answers true: the model is told to
  // resolve_action with commit:true and writes HP off arithmetic the table does not use.
  it('withholds guidance from a campaign whose slug is backed by a homebrew mechanics profile', () => {
    const profile: HomebrewMechanicsProfile = {
      slug: 'my-pirate-hack',
      label: 'Pirate Hack',
      mechanicsSummary: 'A homebrew hack riding the OSR ability/save/AC/initiative shape.',
      abilityTable: 'sw-banded',
      abilityCap: 2,
      saves: ['Grit', 'Sea Legs'],
      acMode: 'descending',
      acAnchor: 9,
      initiativeMode: 'group',
      initiativeDie: 6,
      initiativeUsesDexMod: false,
      tiebreak: 'order-only',
    };

    // Without the profile the slug is merely unrecognized, so it inherits 5e — the pre-#1502
    // behaviour, deliberately unchanged.
    expect(resolverSpeaksCampaignSystem('my-pirate-hack')).toBe(true);

    // With it, the campaign's maths is the profile's, and the gate must close.
    expect(resolverSpeaksCampaignSystem('my-pirate-hack', profile)).toBe(false);
    const gated = buildGroundingPreamble('my-pirate-hack', profile);
    expect(gated).not.toMatch(/To resolve an ATTACK, call resolve_action/);
    expect(gated).not.toMatch(/call saving_throw with the character and the DC/);
    expect(gated).not.toMatch(/commit\s*:\s*true/i);
    expect(gated).toMatch(/let the human DM make the call/);
  });

  it('ignores a stale profile whose slug no longer matches the campaign, exactly as resolution does', () => {
    // Resolution only honours an exact slug match, so a leftover profile must not be able to
    // close the gate for an unrelated system either — the two must agree, or the prompt would
    // describe a system the resolver is not actually using.
    const stale: HomebrewMechanicsProfile = {
      slug: 'some-other-hack',
      label: 'Other',
      mechanicsSummary: 'Stale.',
      abilityTable: 'sw-banded',
      abilityCap: 2,
      saves: ['Grit'],
      acMode: 'descending',
      acAnchor: 9,
      initiativeMode: 'group',
      initiativeDie: 6,
      initiativeUsesDexMod: false,
      tiebreak: 'order-only',
    };
    expect(resolverSpeaksCampaignSystem('my-pirate-hack', stale)).toBe(true);
  });
});

/**
 * The prompt carries a WORKED inline-spec example. This is the half of the fix that decides
 * whether the change moves behaviour at all: naming a tool whose input shape the model cannot
 * construct just makes it fail once and fall back to the manual chain — a change that looks
 * correct and does nothing.
 */
describe('the inline-spec example in the prompt is actually valid (#1053)', () => {
  /**
   * Extracted from the preamble itself, so the example cannot rot away from the assertion.
   * Brace-counted rather than regex-matched: a pattern like `\}\}\}\}` silently stops matching
   * the moment the example gains or loses a nesting level, and a test that cannot find its
   * subject fails for the wrong reason.
   */
  function exampleFromPrompt(): unknown {
    const start = preamble.indexOf('{"mode":"attack"');
    if (start === -1) throw new Error('the prompt no longer carries an inline attack-spec example');
    let depth = 0;
    for (let i = start; i < preamble.length; i++) {
      if (preamble[i] === '{') depth++;
      else if (preamble[i] === '}') {
        depth--;
        if (depth === 0) return JSON.parse(preamble.slice(start, i + 1));
      }
    }
    throw new Error('the inline attack-spec example in the prompt has unbalanced braces');
  }

  it('parses as an ActionSpec', () => {
    expect(() => ActionSpec.parse(exampleFromPrompt())).not.toThrow();
  });

  it('is RESOLVABLE — the property a plausible guess fails', () => {
    // Every ActionSpec field is optional with a default, so `{}` and `{attack:{bonus:'+5'}}`
    // both parse happily and then fail isResolvableSpec for want of `mode`. That is precisely
    // the trap an unguided model falls into, and why an example beats a field list.
    expect(isResolvableSpec(ActionSpec.parse(exampleFromPrompt()))).toBe(true);
    expect(isResolvableSpec(ActionSpec.parse({ attack: { bonus: '+5' } }))).toBe(false);
    expect(isResolvableSpec(ActionSpec.parse({}))).toBe(false);
  });

  it('carries a hit branch with damage, so a hit actually does something', () => {
    const spec = ActionSpec.parse(exampleFromPrompt());
    expect(spec.outcomes.hit?.damage?.length).toBeGreaterThan(0);
  });

  it('keeps the modifier OUT of the dice formula, as the prompt instructs', () => {
    // The example is what the model will copy. If it modelled "1d8+3" as a formula it would
    // teach exactly the mistake the surrounding sentence warns against.
    const spec = ActionSpec.parse(exampleFromPrompt());
    const part = spec.outcomes.hit!.damage[0];
    expect(part.formula).not.toMatch(/[+-]\s*\d/);
    expect(part.flat).toBeGreaterThan(0);
  });
});

/**
 * Why the formula/flat split is load-bearing (#1053).
 *
 * `DamagePart.formula`'s own doc comment used to read `Dice expression ("2d6+3")`, which
 * contradicted `rollBranchDamage`'s contract. Anyone following the documented example got the
 * modifier doubled on every 5e critical hit — silently, with no error.
 *
 * Review of this PR raised the sharper version of the same problem: the split was documented
 * as a universal convention while `rollBranchDamage` implemented 5e's rule unconditionally, so
 * a PF2e `1d8+3` crit resolved as `2d8+3` when PF2e says `(1d8+3)*2`. The rule is now the
 * adapter's (`criticalDamageRuleForAdapter`), and the split is what makes EITHER rule
 * computable: `double-dice` must know which half is dice, `double-total` must know the
 * modifier so it can double that too.
 */
describe('critical damage follows the system, not a hardcoded rule (#1053)', () => {
  /** Deterministic roller: every die shows its maximum face. */
  const maxRoll = (expr: string) => {
    const [count, sides] = expr.split('d').map(Number);
    return { total: count * sides } as ReturnType<Parameters<typeof rollBranchDamage>[1]>;
  };

  function branch(formula: string, flat: number): OutcomeBranch {
    return {
      damage: [{ formula, flat, type: 'slashing' }],
      halfDamage: false,
      healing: '',
      tempHp: '',
      effects: [],
      text: '',
    };
  }

  it('5e (double-dice, the default) doubles only the dice', () => {
    // 1d8 max = 8. Normal: 8 + 3 = 11. Crit: (8 + 8) + 3 = 19 — the +3 is added once.
    expect(rollBranchDamage(branch('1d8', 3), maxRoll).parts[0].amount).toBe(11);
    expect(rollBranchDamage(branch('1d8', 3), maxRoll, { critical: true }).parts[0].amount).toBe(19);
    // Omitting criticalRule must behave exactly as before the seam existed.
    expect(rollBranchDamage(branch('1d8', 3), maxRoll, { critical: true, criticalRule: 'double-dice' }).parts[0].amount).toBe(19);
  });

  it('PF2e (double-total) doubles the modifier too — the bug this seam fixes', () => {
    // (8 + 3) * 2 = 22, not the 19 the 5e rule produces. Before #1053 every PF2e crit in the
    // resolver came out as 19: correct arithmetic, wrong game.
    expect(rollBranchDamage(branch('1d8', 3), maxRoll, { critical: true, criticalRule: 'double-total' }).parts[0].amount).toBe(22);
    // A non-critical hit is identical under both rules — the rule only changes crits.
    expect(rollBranchDamage(branch('1d8', 3), maxRoll, { criticalRule: 'double-total' }).parts[0].amount).toBe(11);
  });

  it('the adapters carry the rule, so the resolver never has to know the system', () => {
    // The default is the point: an adapter that has never declared a crit rule keeps 5e's,
    // which is what every system did before this seam — no silent PF2e math anywhere.
    expect(criticalDamageRuleForAdapter(Dnd5eAdapter)).toBe('double-dice');
    expect(criticalDamageRuleForAdapter(Pf2eAdapter)).toBe('double-total');
    expect(criticalDamageRuleForAdapter(Sf2eAdapter)).toBe('double-total');
    expect(criticalDamageRuleForAdapter({})).toBe('double-dice');
  });

  it('folding the modifier INTO the formula still breaks — under BOTH rules', () => {
    const foldedRoller = (expr: string) => {
      const m = expr.match(/(\d+)d(\d+)(?:\+(\d+))?/)!;
      return { total: Number(m[1]) * Number(m[2]) + Number(m[3] ?? 0) } as ReturnType<Parameters<typeof rollBranchDamage>[1]>;
    };
    // 5e: "1d8+3" rolls 11 normally but 22 on a crit instead of 19 — the +3 got doubled.
    expect(rollBranchDamage(branch('1d8+3', 0), foldedRoller, { critical: true }).parts[0].amount).toBe(22);
    // PF2e: it happens to land on 22 as well, but only by coincidence of this example — the
    // server cannot tell which half is dice, so it cannot report a breakdown or apply any
    // future rule that treats them differently. Documented, not endorsed.
    expect(rollBranchDamage(branch('1d8+3', 0), foldedRoller, { critical: true, criticalRule: 'double-total' }).parts[0].amount).toBe(22);
  });

  /**
   * #1053 review — `DamagePart.flat` was `.min(0)`, so `1d8-1` had NO legal encoding: `flat:-1`
   * failed validation and leaving `-1` in `formula` doubled the penalty on a 5e crit. The
   * convention this PR documents was unrepresentable for the case it most needed to cover.
   */
  describe('negative modifiers are representable', () => {
    it('accepts a negative flat through the schema', () => {
      const spec = ActionSpec.parse({
        mode: 'attack',
        attack: { bonus: '+5' },
        outcomes: { hit: { damage: [{ formula: '1d8', flat: -1, type: 'slashing' }] } },
      });
      expect(spec.outcomes.hit!.damage[0].flat).toBe(-1);
    });

    it('applies the penalty ONCE on a 5e crit, not twice', () => {
      // 1d8 max = 8. Normal: 8 - 1 = 7. Crit: (8 + 8) - 1 = 15.
      expect(rollBranchDamage(branch('1d8', -1), maxRoll).parts[0].amount).toBe(7);
      expect(rollBranchDamage(branch('1d8', -1), maxRoll, { critical: true }).parts[0].amount).toBe(15);
      // The old workaround — the penalty smuggled into the formula — gives 14: doubled.
      const foldedRoller = (expr: string) => {
        const m = expr.match(/(\d+)d(\d+)(?:-(\d+))?/)!;
        return { total: Number(m[1]) * Number(m[2]) - Number(m[3] ?? 0) } as ReturnType<Parameters<typeof rollBranchDamage>[1]>;
      };
      expect(rollBranchDamage(branch('1d8-1', 0), foldedRoller, { critical: true }).parts[0].amount).toBe(14);
    });

    it('doubles the penalty on a PF2e crit, which is what PF2e says to do', () => {
      // "double the damage after adding all the modifiers, bonuses, and penalties": (8-1)*2.
      expect(rollBranchDamage(branch('1d8', -1), maxRoll, { critical: true, criticalRule: 'double-total' }).parts[0].amount).toBe(14);
    });

    it('floors damage at 0 — a penalty can never heal the target', () => {
      // A deliberate decision, not inherited: the floor lives at the END of the calculation so
      // it catches both rules. 2 - 5 = -3 → 0, and (2 - 5) * 2 = -6 → 0.
      const oneRoll = () => ({ total: 2 }) as ReturnType<Parameters<typeof rollBranchDamage>[1]>;
      expect(rollBranchDamage(branch('1d4', -5), oneRoll).parts[0].amount).toBe(0);
      expect(rollBranchDamage(branch('1d4', -5), oneRoll, { critical: true, criticalRule: 'double-total' }).parts[0].amount).toBe(0);
    });
  });
});
