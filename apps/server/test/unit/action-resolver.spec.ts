import {
  ActionSpec,
  CharacterAction,
  Dnd5eAdapter,
  Pf2eAdapter,
  applyDamageModifiers,
  classifyAttackOutcome,
  classifySaveOutcome,
  computeAttackModifier,
  computeSaveDc,
  halveDamage,
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

describe('rollBranchDamage — crit doubles dice, not flat', () => {
  const branch = ActionSpec.parse({ outcomes: { hit: { damage: [{ formula: '2d6', flat: 3, type: 'fire' }] } } }).outcomes.hit!;
  it('normal hit: dice + flat', () => {
    const { parts } = rollBranchDamage(branch, fixedRoller({ '2d6': 7 }));
    expect(parts).toEqual([{ type: 'fire', amount: 10 }]); // 7 + 3
  });
  it('crit: dice rolled twice + flat once', () => {
    const { parts } = rollBranchDamage(branch, fixedRoller({ '2d6': 7 }), { critical: true });
    expect(parts).toEqual([{ type: 'fire', amount: 17 }]); // 7 + 7 + 3
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
