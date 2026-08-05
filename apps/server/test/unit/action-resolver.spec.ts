import {
  ActionSpec,
  CharacterAction,
  Dnd5eAdapter,
  Pf2eAdapter,
  Sf2eAdapter,
  BasicFantasyAdapter,
  OldSchoolEssentialsAdapter,
  OpenLegendAdapter,
  applyDamageModifiers,
  checkProficiencyBonusForAdapter,
  defaultCheckProficiencyBonus,
  classifyAttackOutcome,
  classifySaveOutcome,
  computeAttackModifier,
  computeSaveDc,
  defaultAttackRoll,
  dnd5eProficiencyBonus,
  pf2eProficiencyBonus,
  resolveAttackForAdapter,
  halveDamage,
  inferActionSpecFromText,
  isResolvableSpec,
  parseSignedBonus,
  pickOutcomeBranch,
  rollBranchDamage,
  type ActionRollFn,
  type TargetDefenses,
} from '@campfire/schema';

/**
 * Unit tests for the structured action resolver (issue #414). These pin down the pure,
 * system-aware math the server / MCP / web all share: attack + DC modifiers, outcome
 * classification (5e hit/miss/crit vs PF2e degrees), half-damage on a save, damage-type
 * resistance/vulnerability/immunity, crit dice doubling, branch selection with fallbacks,
 * and the resolvable-vs-fallback gate that keeps unsupported shapes off silent math.
 */

/** A deterministic roller: maps a formula to a fixed total (dice = the queued value). */
function fixedRoller(totals: Record<string, number>): ActionRollFn {
  return (expr: string) => ({ total: totals[expr] ?? 0, rolls: [totals[expr] ?? 0] });
}

const NO_DEFENSES: TargetDefenses = { resistances: [], vulnerabilities: [], immunities: [] };

describe('action spec — backward compatibility', () => {
  it('a pre-#414 action (no spec) parses and carries an undefined spec', () => {
    const a = CharacterAction.parse({ name: 'Longsword', toHit: '+5', damage: '1d8+3 slashing', notes: 'Versatile.' });
    expect(a.spec).toBeUndefined();
    expect(a.notes).toBe('Versatile.'); // notes preserved
  });

  it('a structured action parses with defaults filled in', () => {
    const a = CharacterAction.parse({
      name: 'Fireball',
      spec: { mode: 'save', save: { ability: 'DEX', dc: { kind: 'fixed', dc: 15 } }, outcomes: { failure: { damage: [{ formula: '8d6', type: 'fire' }] }, success: { halfDamage: true } } },
    });
    expect(a.spec?.mode).toBe('save');
    expect(a.spec?.targets.count).toBe(1); // defaulted
    expect(a.spec?.cost.slot).toBe('action'); // defaulted
  });
});

describe('parseSignedBonus / halveDamage', () => {
  it('parses +5, 7, -1, and blank', () => {
    expect(parseSignedBonus('+5')).toBe(5);
    expect(parseSignedBonus('7')).toBe(7);
    expect(parseSignedBonus('-1')).toBe(-1);
    expect(parseSignedBonus('')).toBe(0);
    expect(parseSignedBonus('junk')).toBe(0);
  });
  it('halves rounding down, floored at 0', () => {
    expect(halveDamage(7)).toBe(3);
    expect(halveDamage(8)).toBe(4);
    expect(halveDamage(0)).toBe(0);
    expect(halveDamage(-4)).toBe(0);
  });
});

describe('computeAttackModifier', () => {
  it('an explicit bonus wins over ability+proficiency', () => {
    const spec = ActionSpec.parse({ mode: 'attack', attack: { bonus: '+7', ability: 'STR' } });
    const { modifier } = computeAttackModifier(spec, Dnd5eAdapter, { STR: 20 }, 3);
    expect(modifier).toBe(7);
  });
  it('ability modifier + proficiency when no explicit bonus', () => {
    const spec = ActionSpec.parse({ mode: 'attack', attack: { ability: 'STR', proficient: true } });
    // STR 18 -> +4, proficiency +3 -> +7
    const { modifier, breakdown } = computeAttackModifier(spec, Dnd5eAdapter, { STR: 18 }, 3);
    expect(modifier).toBe(7);
    expect(breakdown).toEqual([
      { label: 'STR', value: 4 },
      { label: 'proficiency', value: 3 },
    ]);
  });
  it('omits proficiency when not proficient', () => {
    const spec = ActionSpec.parse({ mode: 'attack', attack: { ability: 'DEX', proficient: false } });
    const { modifier } = computeAttackModifier(spec, Dnd5eAdapter, { DEX: 14 }, 3);
    expect(modifier).toBe(2);
  });
});

describe('computeSaveDc', () => {
  it('a fixed DC returns verbatim', () => {
    const { dc } = computeSaveDc({ kind: 'fixed', dc: 15, ability: '', proficient: true, bonus: 0, base: 8 }, Dnd5eAdapter, {}, 3);
    expect(dc).toBe(15);
  });
  it('ability DC = base 8 + ability mod + proficiency', () => {
    // CHA 18 -> +4, proficiency +3, base 8 -> 15
    const { dc } = computeSaveDc({ kind: 'ability', dc: 10, ability: 'CHA', proficient: true, bonus: 0, base: 8 }, Dnd5eAdapter, { CHA: 18 }, 3);
    expect(dc).toBe(15);
  });
  it('a none DC source yields null (caller must fall back, no silent math)', () => {
    const { dc } = computeSaveDc({ kind: 'none', dc: 10, ability: '', proficient: true, bonus: 0, base: 8 }, Dnd5eAdapter, {}, 3);
    expect(dc).toBeNull();
  });
});

describe('classifyAttackOutcome — 5e', () => {
  it('total >= AC hits, below misses', () => {
    expect(classifyAttackOutcome(Dnd5eAdapter, 18, 12, 15)).toBe('hit');
    expect(classifyAttackOutcome(Dnd5eAdapter, 14, 8, 15)).toBe('miss');
  });
  it('natural 20 always crits, natural 1 always misses (critMiss)', () => {
    expect(classifyAttackOutcome(Dnd5eAdapter, 25, 20, 15)).toBe('crit');
    expect(classifyAttackOutcome(Dnd5eAdapter, 21, 1, 15)).toBe('critMiss'); // nat 1 misses even if total clears AC
  });
});

describe('classifyAttackOutcome / classifySaveOutcome — PF2e degrees', () => {
  it('attack: total >= DC+10 crit, natural 20 bumps a hit to a crit', () => {
    expect(classifyAttackOutcome(Pf2eAdapter, 25, 12, 15)).toBe('crit'); // 25 >= 15+10
    expect(classifyAttackOutcome(Pf2eAdapter, 17, 20, 15)).toBe('crit'); // success bumped by nat 20
    expect(classifyAttackOutcome(Pf2eAdapter, 16, 12, 15)).toBe('hit');
    expect(classifyAttackOutcome(Pf2eAdapter, 4, 12, 15)).toBe('critMiss'); // <= DC-10
  });
  it('save: four degrees from the target perspective', () => {
    expect(classifySaveOutcome(Pf2eAdapter, 26, 12, 15).outcome).toBe('critSuccess'); // >= DC+10
    expect(classifySaveOutcome(Pf2eAdapter, 16, 12, 15).outcome).toBe('success');
    expect(classifySaveOutcome(Pf2eAdapter, 12, 12, 15).outcome).toBe('failure');
    expect(classifySaveOutcome(Pf2eAdapter, 4, 12, 15).outcome).toBe('critFailure'); // <= DC-10
  });
  it('save (5e): only success/failure, no crit', () => {
    expect(classifySaveOutcome(Dnd5eAdapter, 15, 12, 15).outcome).toBe('success');
    expect(classifySaveOutcome(Dnd5eAdapter, 14, 12, 15).outcome).toBe('failure');
  });
});

/**
 * resolveAttackForAdapter / defaultAttackRoll — issue #1598.
 *
 * The resolver used to roll exactly 1d20 and compare the total against `targetAc` assuming
 * ASCENDING armour class, unconditionally. `resolveAttackForAdapter` asks the adapter for its
 * OWN `resolveAttack` when it declares one (OSR's descending-AC thac0 comparison via
 * `osrAttackHits`, Open Legend's exploding dice pool) and falls back to `defaultAttackRoll`
 * (exactly the old behaviour) otherwise — so 5e/PF2e/SF2e keep working unchanged while OSR and
 * Open Legend get their own, correct maths instead of a second `if (system === ...)` branch
 * inside the resolver itself.
 */
describe('resolveAttackForAdapter / defaultAttackRoll — issue #1598', () => {
  it('5e: defaultAttackRoll reproduces classifyAttackOutcome exactly (no behaviour change)', () => {
    const roll = fixedRoller({ '1d20': 12 });
    const result = defaultAttackRoll(Dnd5eAdapter, { modifier: 6, targetAc: 15, roll });
    expect(result).toEqual({ total: 18, naturalRoll: 12, outcome: classifyAttackOutcome(Dnd5eAdapter, 18, 12, 15) });
    expect(result.outcome).toBe('hit');
    // No resolveAttack declared, so resolveAttackForAdapter takes the SAME path.
    expect(resolveAttackForAdapter(Dnd5eAdapter, { modifier: 6, targetAc: 15, roll })).toEqual(result);
  });

  it('OSR descending AC: the OLD ascending-AC bug misclassified nearly every roll as a hit against strong armour', () => {
    // A very heavily armoured target (descending AC -5 — better than plate) against an
    // unskilled attacker (modifier 0). Neither roll is 1 or 20, so neither of osrAttackHits'
    // auto-miss/auto-hit overrides fires — this exercises the actual comparison.
    const roll = fixedRoller({ '1d20': 10 });
    const input = { modifier: 0, targetAc: -5, roll };

    // THE BUG, reproduced directly: the old code compared the SAME numbers as ascending AC —
    // total (10) >= targetAc (-5) — which is true for virtually any roll against a very
    // negative descending AC. This is exactly what #1598 reports: "against descending AC 2
    // nearly any positive total reads as a hit".
    expect(classifyAttackOutcome(BasicFantasyAdapter, 10, 10, -5)).toBe('hit');

    // THE FIX: BasicFantasyAdapter now owns its own attack roll via osrAttackHits, which
    // compares nat 10 against thac0(19) - descendingAc(-5) = 24 — unreachable by any d20 — so
    // the SAME inputs correctly miss.
    const result = resolveAttackForAdapter(BasicFantasyAdapter, input);
    expect(result.outcome).toBe('miss');
    expect(result.naturalRoll).toBe(10);
    expect(result.targetLabel).toBe('ascending AC 24 (descending AC -5)');
  });

  it('OSR descending AC: a real hit against ordinary armour still lands (not just "always miss now")', () => {
    // A competent attacker (modifier 5 -> thac0 14) against lightly-armoured descending AC 9:
    // threshold = 14 - 9 = 5, and a natural 15 clears it.
    const roll = fixedRoller({ '1d20': 15 });
    const result = resolveAttackForAdapter(OldSchoolEssentialsAdapter, { modifier: 5, targetAc: 9, roll });
    expect(result.outcome).toBe('hit');
    expect(result.naturalRoll).toBe(15);
    expect(result.targetLabel).toBeUndefined();
  });

  it('OSR: a natural 1 always misses and a natural 20 always hits, matching osrAttackHits', () => {
    // Impossibly good armour, but a nat 20 still hits; impossibly easy target, but a nat 1
    // still misses — the auto-fail/auto-succeed convention osrAttackHits already encodes.
    expect(resolveAttackForAdapter(BasicFantasyAdapter, { modifier: 0, targetAc: -20, roll: fixedRoller({ '1d20': 20 }) }).outcome).toBe(
      'hit',
    );
    expect(resolveAttackForAdapter(BasicFantasyAdapter, { modifier: 20, targetAc: 20, roll: fixedRoller({ '1d20': 1 }) }).outcome).toBe(
      'miss',
    );
  });

  it('OSR: never reports crit/critMiss — base rules have no automatic critical-hit multiplier', () => {
    // A natural 20 always HITS under OSR rules, but is not itself a critical hit — that would
    // be a house rule this adapter has no authority to assume.
    const result = resolveAttackForAdapter(BasicFantasyAdapter, { modifier: 0, targetAc: -20, roll: fixedRoller({ '1d20': 20 }) });
    expect(result.outcome).toBe('hit');
    expect(result.outcome).not.toBe('crit');
  });

  it('Open Legend: rolls an exploding ATTRIBUTE DICE POOL, not a d20 — the old code rolled the wrong thing entirely', () => {
    // Score 3 -> pool [20, 8] (see OPEN_LEGEND_ACTION_DICE). Neither die shows its max face,
    // so nothing explodes: total = 1 (d20) + 6 (d8) = 7, plus the score itself is NOT re-added
    // (the score selects the pool; it is not also a flat bonus).
    const roll = fixedRoller({ '1d20': 1, '1d8': 6 });
    const result = resolveAttackForAdapter(OpenLegendAdapter, { modifier: 3, targetAc: 5, roll });
    expect(result.total).toBe(7);
    expect(result.naturalRoll).toBeNull();
    expect(result.outcome).toBe('hit');

    // THE BUG, reproduced directly: the old code would have rolled ONLY a d20 (ignoring the
    // pool's other die entirely) and added the score as a flat modifier — a 1d20+3 wholly
    // unrelated to Open Legend's actual dice-pool rules.
    const wrongPath = defaultAttackRoll(OpenLegendAdapter, { modifier: 3, targetAc: 5, roll: fixedRoller({ '1d20': 1 }) });
    expect(wrongPath.total).toBe(4); // 1 + 3 — not the pool's 7
    // classifyAttackOutcome's 5e "natural 1 always misses" rule fires on this SAME roll used as
    // a d20 nat-1 — a rule this system's true dice-pool maths does not even have a concept of.
    expect(wrongPath.outcome).toBe('critMiss'); // would have wrongly refused a hit that actually landed
  });

  it('Open Legend: a negative or non-finite modifier degrades to the score-0 disadvantage pool rather than throwing', () => {
    const roll = fixedRoller({ '1d20': 10 });
    expect(() => resolveAttackForAdapter(OpenLegendAdapter, { modifier: -3, targetAc: 5, roll })).not.toThrow();
  });
});

describe('checkProficiencyBonusForAdapter — issue #1599', () => {
  it('5e: declares its own hook and matches dnd5eProficiencyBonus exactly (no behaviour change)', () => {
    for (const level of [1, 4, 5, 8, 9, 12, 13, 17, 20]) {
      expect(checkProficiencyBonusForAdapter(Dnd5eAdapter, level)).toBe(dnd5eProficiencyBonus(level));
    }
  });

  it('PF2e: a real, non-zero bonus — the trained floor, level + 2 — not the old silent 0', () => {
    // Level 5, trained: matches pf2eProficiencyBonus(5, 'trained') exactly.
    expect(checkProficiencyBonusForAdapter(Pf2eAdapter, 5)).toBe(pf2eProficiencyBonus(5, 'trained'));
    expect(checkProficiencyBonusForAdapter(Pf2eAdapter, 5)).toBe(7);
    // THE BUG, reproduced directly: before #1599, every non-5e adapter returned 0 here
    // regardless of level — the exact silent-understatement the issue was filed about.
    expect(checkProficiencyBonusForAdapter(Pf2eAdapter, 5)).not.toBe(0);
  });

  it('SF2e inherits PF2e proficiency via the adapter spread', () => {
    expect(checkProficiencyBonusForAdapter(Sf2eAdapter, 5)).toBe(pf2eProficiencyBonus(5, 'trained'));
  });

  it('OSR and Open Legend: no hook declared, default (0) applies — same as before #1599', () => {
    // Deliberately 0, not 5e's formula: see defaultCheckProficiencyBonus's own comment for why
    // "add nothing" is the only safe default for a system nobody has audited, unlike the
    // attack roll's default (which IS a reasonable universal guess).
    expect(checkProficiencyBonusForAdapter(BasicFantasyAdapter, 5)).toBe(0);
    expect(checkProficiencyBonusForAdapter(OldSchoolEssentialsAdapter, 5)).toBe(0);
    expect(checkProficiencyBonusForAdapter(OpenLegendAdapter, 5)).toBe(0);
    expect(defaultCheckProficiencyBonus()).toBe(0);
  });
});

describe('pickOutcomeBranch — fallbacks', () => {
  const spec = ActionSpec.parse({
    mode: 'attack',
    outcomes: { hit: { damage: [{ formula: '1d8', type: 'slashing' }] }, success: { halfDamage: true } },
  });
  it('crit falls back to hit when no explicit crit branch', () => {
    expect(pickOutcomeBranch(spec, 'crit')?.damage[0].formula).toBe('1d8');
  });
  it('critSuccess falls back to success', () => {
    expect(pickOutcomeBranch(spec, 'critSuccess')?.halfDamage).toBe(true);
  });
  it('miss with no branch returns null (apply nothing)', () => {
    expect(pickOutcomeBranch(spec, 'miss')).toBeNull();
  });
});

describe('rollBranchDamage — the crit rule comes from the system (#1053)', () => {
  const branch = ActionSpec.parse({ outcomes: { hit: { damage: [{ formula: '2d6', flat: 3, type: 'fire' }] } } }).outcomes.hit!;
  it('normal hit: dice + flat', () => {
    const { parts } = rollBranchDamage(branch, fixedRoller({ '2d6': 7 }));
    expect(parts).toEqual([{ type: 'fire', amount: 10 }]); // 7 + 3
  });
  it('5e crit (the default when no rule is passed): dice rolled twice + flat once', () => {
    const { parts } = rollBranchDamage(branch, fixedRoller({ '2d6': 7 }), { critical: true });
    expect(parts).toEqual([{ type: 'fire', amount: 17 }]); // 7 + 7 + 3
  });
  it('PF2e crit: the whole total doubles, modifier included', () => {
    const { parts } = rollBranchDamage(branch, fixedRoller({ '2d6': 7 }), { critical: true, criticalRule: 'double-total' });
    expect(parts).toEqual([{ type: 'fire', amount: 20 }]); // (7 + 3) * 2 — not 17
  });
});

describe('applyDamageModifiers — half on save + resistance', () => {
  it('half damage on a successful save', () => {
    expect(applyDamageModifiers(9, 'fire', NO_DEFENSES, { half: true })).toEqual({ final: 4, applied: 'halved' });
  });
  it('resistance halves (after save-half); the two stack multiplicatively, each rounding down', () => {
    // 15 fire, save success (half -> 7), then resistant (half -> 3)
    expect(applyDamageModifiers(15, 'fire', { resistances: ['fire'], vulnerabilities: [], immunities: [] }, { half: true })).toEqual({
      final: 3,
      applied: 'resistant',
    });
  });
  it('vulnerability doubles', () => {
    expect(applyDamageModifiers(6, 'cold', { resistances: [], vulnerabilities: ['cold'], immunities: [] })).toEqual({ final: 12, applied: 'vulnerable' });
  });
  it('immunity zeroes and wins over everything', () => {
    expect(applyDamageModifiers(20, 'poison', { resistances: ['poison'], vulnerabilities: [], immunities: ['poison'] })).toEqual({ final: 0, applied: 'immune' });
  });
  it('untyped damage is never resisted', () => {
    expect(applyDamageModifiers(10, '', { resistances: ['fire'], vulnerabilities: [], immunities: [] })).toEqual({ final: 10, applied: 'normal' });
  });
  it('resistance match is case-insensitive', () => {
    expect(applyDamageModifiers(8, 'Fire', { resistances: ['FIRE'], vulnerabilities: [], immunities: [] }).applied).toBe('resistant');
  });
});

describe('isResolvableSpec — fallback gate (no silent math)', () => {
  it('attack with a bonus or ability is resolvable', () => {
    expect(isResolvableSpec(ActionSpec.parse({ mode: 'attack', attack: { bonus: '+5' } }))).toBe(true);
    expect(isResolvableSpec(ActionSpec.parse({ mode: 'attack', attack: { ability: 'STR' } }))).toBe(true);
  });
  it('attack with neither bonus nor ability is NOT resolvable (fall back to statblock)', () => {
    expect(isResolvableSpec(ActionSpec.parse({ mode: 'attack' }))).toBe(false);
  });
  it('save is resolvable only with a real DC source', () => {
    expect(isResolvableSpec(ActionSpec.parse({ mode: 'save', save: { dc: { kind: 'fixed', dc: 15 } } }))).toBe(true);
    expect(isResolvableSpec(ActionSpec.parse({ mode: 'save' }))).toBe(false);
  });
  it("mode 'none' and a null spec never auto-resolve", () => {
    expect(isResolvableSpec(ActionSpec.parse({ mode: 'none' }))).toBe(false);
    expect(isResolvableSpec(null)).toBe(false);
    expect(isResolvableSpec(undefined)).toBe(false);
  });
});

describe('inferActionSpecFromText — sheet action spec inference (issue #1930)', () => {
  it('infers an attack spec from "+5" and "1d8+3 slashing"', () => {
    const spec = inferActionSpecFromText('+5', '1d8+3 slashing', '');
    expect(spec).toBeDefined();
    expect(spec?.mode).toBe('attack');
    expect(spec?.attack.bonus).toBe('+5');
    expect(spec?.outcomes.hit?.damage).toEqual([{ formula: '1d8', flat: 3, type: 'slashing' }]);
    expect(spec?.provenance.source).toBe('sheet-inferred');
    expect(isResolvableSpec(spec)).toBe(true);
  });

  it('infers an attack spec from bare bonus with no damage', () => {
    const spec = inferActionSpecFromText('+5', '', '');
    expect(spec).toBeDefined();
    expect(spec?.mode).toBe('attack');
    expect(spec?.attack.bonus).toBe('+5');
    expect(spec?.provenance.source).toBe('sheet-inferred');
    expect(isResolvableSpec(spec)).toBe(true);
  });

  it('infers a save spec from "DC 15" and "3d6 fire"', () => {
    const spec = inferActionSpecFromText('DC 15', '3d6 fire', 'spell');
    expect(spec).toBeDefined();
    expect(spec?.mode).toBe('save');
    expect(spec?.save.dc.dc).toBe(15);
    expect(spec?.outcomes.failure?.damage).toEqual([{ formula: '3d6', flat: 0, type: 'fire' }]);
    expect(spec?.outcomes.success?.halfDamage).toBe(true);
    expect(spec?.provenance.source).toBe('sheet-inferred');
    expect(isResolvableSpec(spec)).toBe(true);
  });

  it('preserves negative flat damage modifiers ("1d4-1 poison")', () => {
    const spec = inferActionSpecFromText('+5', '1d4-1 poison', '');
    expect(spec).toBeDefined();
    expect(spec?.outcomes.hit?.damage).toEqual([{ formula: '1d4', flat: -1, type: 'poison' }]);
  });

  it('returns undefined for non-resolvable text or empty input', () => {
    expect(inferActionSpecFromText('', '', '')).toBeUndefined();
    expect(inferActionSpecFromText('versatile', '', '')).toBeUndefined();
    expect(inferActionSpecFromText('', '3d6 fire', 'save')).toBeUndefined();
  });
});


