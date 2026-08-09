import { expect, test } from '@playwright/test';
import { ActionSpec } from '@campfire/schema';
import {
  actionSourceText,
  actionSpecEffects,
  actionSpecFacts,
} from '../../src/features/characters/actionSpecFacts';

/**
 * The Actions card's per-action detail disclosure (design template
 * `templates/character-sheet/CharacterSheet.dc.html`, "Details ▾") renders from these pure
 * helpers. The invariant they own: a fact is shown only when the spec ACTUALLY states it —
 * a text-only action, or one whose spec leaves a field at its default, must not sprout an
 * invented "Range: " or "1 action" the sheet's author never wrote.
 */

/** A spec with every field at its schema default — the shape `inferActionSpecFromText` starts from. */
const emptySpec = () => ActionSpec.parse({});

test.describe('actionSpecFacts — states only what the spec carries', () => {
  test('a text-only action (no spec at all) has no facts, effects or source', () => {
    expect(actionSpecFacts(undefined)).toEqual([]);
    expect(actionSpecEffects(undefined)).toEqual([]);
    expect(actionSourceText(undefined)).toBe('');
    expect(actionSpecFacts(null)).toEqual([]);
  });

  test('an all-default spec states nothing at all', () => {
    // The trap: `cost` and `targets` are the two fields whose schema DEFAULTS are
    // non-empty ({slot:'action',count:1} / {count:1,allow:'any'}), so a naive reader
    // renders "1 action, 1 target" for a spec whose author wrote neither.
    expect(actionSpecFacts(emptySpec())).toEqual([]);
  });

  test('a real action DOES state its default economy — the default applies to it', () => {
    const facts = actionSpecFacts(ActionSpec.parse({ mode: 'attack', attack: { bonus: '+5' } }));
    expect(facts).toContainEqual({ label: 'Cost', value: '1 action' });
    expect(facts).toContainEqual({ label: 'Targets', value: '1 target' });
  });

  test('a deliberately non-default cost or targeting reads even without a mode', () => {
    expect(actionSpecFacts(ActionSpec.parse({ cost: { slot: 'bonus', count: 1 } })))
      .toContainEqual({ label: 'Cost', value: '1 bonus' });
    expect(actionSpecFacts(ActionSpec.parse({ targets: { count: 2, allow: 'ally' } })))
      .toContainEqual({ label: 'Targets', value: '2 targets (ally)' });
  });

  test('range and area combine; area alone still reads', () => {
    expect(actionSpecFacts(ActionSpec.parse({ range: { range: '120 ft' } })))
      .toContainEqual({ label: 'Range', value: '120 ft' });
    expect(actionSpecFacts(ActionSpec.parse({ range: { range: 'Self', shape: 'cone', size: '15 ft' } })))
      .toContainEqual({ label: 'Range', value: 'Self · cone 15 ft' });
    expect(actionSpecFacts(ActionSpec.parse({ range: { shape: 'sphere', size: '20 ft' } })))
      .toContainEqual({ label: 'Range', value: 'sphere 20 ft' });
  });

  test('a fixed save DC is shown; an actor-derived one names the save without inventing a number', () => {
    expect(actionSpecFacts(ActionSpec.parse({ mode: 'save', save: { ability: 'dex', dc: { kind: 'fixed', dc: 15 } } })))
      .toContainEqual({ label: 'Save', value: 'DEX save DC 15' });
    expect(actionSpecFacts(ActionSpec.parse({ mode: 'save', save: { ability: 'dex', dc: { kind: 'ability', ability: 'CHA' } } })))
      .toContainEqual({ label: 'Save', value: 'DEX save' });
  });

  test('an attack action forces no save, so no Save fact appears', () => {
    const facts = actionSpecFacts(ActionSpec.parse({ mode: 'attack', save: { ability: 'dex' } }));
    expect(facts.map((f) => f.label)).not.toContain('Save');
  });

  test('at-will actions have no Uses fact; limited ones name their recharge', () => {
    expect(actionSpecFacts(ActionSpec.parse({ mode: 'attack', uses: { max: 0 } })).map((f) => f.label)).not.toContain('Uses');
    expect(actionSpecFacts(ActionSpec.parse({ uses: { max: 3, recharge: 'long-rest' } })))
      .toContainEqual({ label: 'Uses', value: '3 per long-rest' });
  });

  /**
   * A die-roll recharge is a pool of one even at the schema default `max: 0` — that is what
   * `effectiveActionUsesMax` reads it as, and the encounter holds the action spent until it
   * recharges. Reading `max` literally made a recharge action look at-will on the sheet.
   */
  test('a recharge action with no explicit max is a pool, not at-will', () => {
    expect(actionSpecFacts(ActionSpec.parse({ uses: { recharge: 'recharge-5-6' } })))
      .toContainEqual({ label: 'Uses', value: 'Recharge 5–6' });
    expect(actionSpecFacts(ActionSpec.parse({ uses: { recharge: 'recharge-6' } })))
      .toContainEqual({ label: 'Uses', value: 'Recharge 6' });
  });

  /**
   * A named resource cost is independent of the action's own limited-use pool: an at-will
   * action can still spend from a shared pool (2 Ki), and reading only max/recharge made
   * that action look free.
   */
  test('a named resource cost is stated even for an otherwise at-will action', () => {
    expect(actionSpecFacts(ActionSpec.parse({ mode: 'attack', uses: { resourceKey: 'Ki', resourceCost: 2 } })))
      .toContainEqual({ label: 'Resource', value: '2 Ki' });
    // No amount given — name the pool, do not invent a number.
    expect(actionSpecFacts(ActionSpec.parse({ mode: 'attack', uses: { resourceKey: 'Ki' } })))
      .toContainEqual({ label: 'Resource', value: 'Ki' });
    expect(actionSpecFacts(ActionSpec.parse({ mode: 'attack' })).map((f) => f.label)).not.toContain('Resource');
  });

  test('a REST cadence keeps its own wording rather than being relabelled daily', () => {
    // describeActionUses renders every non-die-roll pool as "N/Day", which would call a
    // short-rest ability daily. Only the die-roll branch defers to it.
    expect(actionSpecFacts(ActionSpec.parse({ uses: { max: 2, recharge: 'short-rest' } })))
      .toContainEqual({ label: 'Uses', value: '2 per short-rest' });
  });

  test('targeting reads as targets, as an area, or not at all', () => {
    expect(actionSpecFacts(ActionSpec.parse({ mode: 'attack', targets: { count: 1 } })))
      .toContainEqual({ label: 'Targets', value: '1 target' });
    expect(actionSpecFacts(ActionSpec.parse({ targets: { count: 2, allow: 'ally' } })))
      .toContainEqual({ label: 'Targets', value: '2 targets (ally)' });
    expect(actionSpecFacts(ActionSpec.parse({ targets: { count: 0 }, range: { size: '15 ft' } })))
      .toContainEqual({ label: 'Targets', value: 'Area' });
    expect(actionSpecFacts(ActionSpec.parse({ targets: { count: 0 } })).map((f) => f.label)).not.toContain('Targets');
  });
});

test.describe('actionSpecEffects — player-safe branch prose, kept under its own outcome', () => {
  /**
   * The invariant this suite exists for: a save's branches are MUTUALLY EXCLUSIVE, so
   * merging them into one list tells the reader that both a success effect and a failure
   * condition apply. Each branch keeps its own name.
   */
  test('a save keeps success and failure apart, each under its own label', () => {
    const spec = ActionSpec.parse({
      mode: 'save',
      outcomes: {
        failure: { effects: [{ condition: 'Restrained' }] },
        success: { text: 'The target is unaffected.' },
      },
    });
    expect(actionSpecEffects(spec)).toEqual([
      { outcome: 'success', label: 'On a success', lines: ['The target is unaffected.'] },
      { outcome: 'failure', label: 'On a failure', lines: ['Restrained'] },
    ]);
  });

  test('the same effect on hit and on crit is two statements about two outcomes, not one', () => {
    const spec = ActionSpec.parse({
      outcomes: {
        hit: { effects: [{ condition: 'Prone' }] },
        crit: { effects: [{ condition: 'Prone' }] },
      },
    });
    expect(actionSpecEffects(spec)).toEqual([
      { outcome: 'crit', label: 'On a critical hit', lines: ['Prone'] },
      { outcome: 'hit', label: 'On a hit', lines: ['Prone'] },
    ]);
  });

  test('a line repeated WITHIN one branch is still shown once', () => {
    const spec = ActionSpec.parse({
      outcomes: { hit: { text: 'Prone', effects: [{ condition: 'Prone' }] } },
    });
    expect(actionSpecEffects(spec)).toEqual([{ outcome: 'hit', label: 'On a hit', lines: ['Prone'] }]);
  });

  test('duration and save-ends are spelled out beside the condition', () => {
    const spec = ActionSpec.parse({
      outcomes: { failure: { text: 'The target is scorched.', effects: [{ condition: 'Frightened', rounds: 1, saveEnds: true }] } },
    });
    expect(actionSpecEffects(spec)).toEqual([
      { outcome: 'failure', label: 'On a failure', lines: ['The target is scorched.', 'Frightened (1 round), save ends'] },
    ]);
  });

  /**
   * A branch can state its whole effect mechanically. Reading only `text` dropped those
   * branches entirely — and healing / temp HP have no top-level CharacterAction field to
   * fall back on, so a healing action's actual result went completely unshown.
   */
  test('a damage-only branch is described, not dropped', () => {
    const spec = ActionSpec.parse({ outcomes: { hit: { damage: [{ formula: '1d8', flat: 3, type: 'slashing' }] } } });
    expect(actionSpecEffects(spec)).toEqual([
      { outcome: 'hit', label: 'On a hit', lines: ['1d8+3 slashing damage'] },
    ]);
  });

  test('flat and multi-type damage read as authored', () => {
    const spec = ActionSpec.parse({
      outcomes: { hit: { damage: [{ formula: '2d6', flat: 0, type: 'fire' }, { formula: '', flat: 5, type: 'cold' }] } },
    });
    expect(actionSpecEffects(spec)[0].lines).toEqual(['2d6 fire + 5 cold damage']);
  });

  test('healing and temp HP are shown — they have no sheet field to fall back on', () => {
    const spec = ActionSpec.parse({ outcomes: { hit: { healing: '2d8+3', tempHp: '5' } } });
    expect(actionSpecEffects(spec)[0].lines).toEqual(['Heals 2d8+3', '5 temporary hit points']);
  });

  /**
   * `halfDamage` is branch-neutral — a `miss`/`failure`/`critFailure` may carry it — and the
   * group heading already names the outcome, so the line must not name one itself.
   */
  test('a branch that halves its OWN damage says so on that damage, without naming an outcome', () => {
    const spec = ActionSpec.parse({
      mode: 'save',
      outcomes: { failure: { damage: [{ formula: '8d6', flat: 0, type: 'fire' }], halfDamage: true } },
    });
    expect(actionSpecEffects(spec)).toEqual([
      { outcome: 'failure', label: 'On a failure', lines: ['8d6 fire damage (halved)'] },
    ]);
  });

  test('save-for-half is stated even when the branch carries no damage of its own', () => {
    const spec = ActionSpec.parse({
      mode: 'save',
      outcomes: {
        failure: { damage: [{ formula: '8d6', flat: 0, type: 'fire' }] },
        success: { halfDamage: true },
      },
    });
    expect(actionSpecEffects(spec)).toEqual([
      { outcome: 'success', label: 'On a success', lines: ['Half damage'] },
      { outcome: 'failure', label: 'On a failure', lines: ['8d6 fire damage'] },
    ]);
  });

  /**
   * `text` and `condition` are independent fields — the resolver applies the condition
   * regardless of the prose — so picking one dropped a real mechanical consequence.
   */
  test('prose and the condition it applies are both shown', () => {
    const spec = ActionSpec.parse({
      outcomes: { hit: { effects: [{ text: 'Knocked off balance', condition: 'Prone' }] } },
    });
    expect(actionSpecEffects(spec)[0].lines).toEqual(['Knocked off balance (Prone)']);
  });

  test('prose that merely restates the condition is not doubled up', () => {
    const spec = ActionSpec.parse({ outcomes: { hit: { effects: [{ text: 'Prone', condition: 'prone' }] } } });
    expect(actionSpecEffects(spec)[0].lines).toEqual(['Prone']);
  });

  test('a condition alone still reads; prose alone does not (the resolver needs the condition)', () => {
    expect(actionSpecEffects(ActionSpec.parse({ outcomes: { hit: { effects: [{ condition: 'Blinded' }] } } }))[0].lines)
      .toEqual(['Blinded']);
    expect(actionSpecEffects(ActionSpec.parse({ outcomes: { hit: { effects: [{ text: 'Pushed 10 feet' }] } } })))
      .toEqual([]);
  });

  test('ongoing damage rides with the condition it belongs to', () => {
    const spec = ActionSpec.parse({
      outcomes: { hit: { effects: [{ condition: 'Burning', rounds: 3, ongoingDamage: 5 }] } },
    });
    expect(actionSpecEffects(spec)[0].lines).toEqual(['Burning (3 rounds) · 5 ongoing damage']);
  });

  /**
   * `ActionResolverService.resolveOneTarget` skips any effect with no condition
   * (`if (!eff.condition) continue`), so a standalone `ongoingDamage` never lands. Describing
   * it would promise recurring damage that using the action does not apply.
   */
  test('an effect with no condition is omitted — the resolver drops it', () => {
    const spec = ActionSpec.parse({ outcomes: { hit: { effects: [{ ongoingDamage: 5, rounds: 3 }] } } });
    expect(actionSpecEffects(spec)).toEqual([]);
    // Prose without a condition is dropped for the same reason.
    const prose = ActionSpec.parse({ outcomes: { hit: { effects: [{ text: 'Smoulders ominously' }] } } });
    expect(actionSpecEffects(prose)).toEqual([]);
  });

  test('a branch that truly says nothing still contributes no group', () => {
    const spec = ActionSpec.parse({ outcomes: { miss: {} } });
    expect(actionSpecEffects(spec)).toEqual([]);
  });

  /**
   * A half-damage branch with nothing of its own halves the FAILURE branch's damage. When
   * that branch has none either, the resolver rolls zero — so the line would promise a
   * consequence the action never applies.
   */
  test('half damage is only claimed when there is something to halve', () => {
    const nothingToHalve = ActionSpec.parse({
      mode: 'save',
      outcomes: { success: { halfDamage: true }, failure: { text: 'Knocked back' } },
    });
    expect(actionSpecEffects(nothingToHalve)).toEqual([
      { outcome: 'failure', label: 'On a failure', lines: ['Knocked back'] },
    ]);

    // The ordinary basic-save shape is unchanged.
    const basicSave = ActionSpec.parse({
      mode: 'save',
      outcomes: { success: { halfDamage: true }, failure: { damage: [{ formula: '8d6', flat: 0, type: 'fire' }] } },
    });
    expect(actionSpecEffects(basicSave)).toEqual([
      { outcome: 'success', label: 'On a success', lines: ['Half damage'] },
      { outcome: 'failure', label: 'On a failure', lines: ['8d6 fire damage'] },
    ]);
  });

  /**
   * #2115 review: every `DamagePart` field is optional and defaults, so `damage: [{}]` is a
   * schema-valid NON-EMPTY array that `rollBranchDamage` resolves to zero. An array-length
   * test called that fallback damage-bearing and promised "Half damage" for an effect the
   * resolver never applies — the same class of untrue disclosure as the empty-fallback case
   * above, one layer down.
   */
  test('a placeholder damage part is not something to halve', () => {
    const placeholder = ActionSpec.parse({
      mode: 'save',
      outcomes: { success: { halfDamage: true }, failure: { damage: [{}] } },
    });
    expect(actionSpecEffects(placeholder)).toEqual([]);

    // A part with a formula, or a positive flat amount, IS real damage — both still print.
    const flatOnly = ActionSpec.parse({
      mode: 'save',
      outcomes: { success: { halfDamage: true }, failure: { damage: [{ flat: 4, type: 'force' }] } },
    });
    expect(actionSpecEffects(flatOnly)).toEqual([
      { outcome: 'success', label: 'On a success', lines: ['Half damage'] },
      { outcome: 'failure', label: 'On a failure', lines: ['4 force damage'] },
    ]);
  });

  /**
   * #2115 review: a hand-authored `crit` branch is schema-valid in any system, but OSR's
   * `resolveAttack` returns only hit or miss, so no roll reaches it. Printing "On a critical
   * hit" — with doubled dice — described an outcome the table can never produce.
   */
  test('attack-crit branches are omitted for a system with no critical hits', () => {
    const spec = ActionSpec.parse({
      outcomes: {
        crit: { damage: [{ formula: '2d6', flat: 0, type: 'slashing' }] },
        hit: { damage: [{ formula: '1d6', flat: 2, type: 'slashing' }] },
        critMiss: { text: 'Weapon slips' },
        miss: { text: 'Turned aside' },
      },
    });
    expect(actionSpecEffects(spec, 'double-dice', false)).toEqual([
      { outcome: 'hit', label: 'On a hit', lines: ['1d6+2 slashing damage'] },
      { outcome: 'miss', label: 'On a miss', lines: ['Turned aside'] },
    ]);
    // Default (and 5e) keeps them.
    expect(actionSpecEffects(spec, 'double-dice').map((g) => g.outcome)).toEqual(['crit', 'hit', 'miss', 'critMiss']);
  });

  /**
   * Degrees of success answer to `degreeOfSuccess`, not to attack crits — a system can have
   * one without the other, so this capability has no authority over those branches.
   */
  test('degree branches are untouched by the attack-crit capability', () => {
    const spec = ActionSpec.parse({
      mode: 'save',
      outcomes: { critSuccess: { text: 'Unharmed' }, failure: { text: 'Singed' }, critFailure: { text: 'Scorched' } },
    });
    expect(actionSpecEffects(spec, 'double-dice', false).map((g) => g.outcome)).toEqual([
      'critSuccess',
      'failure',
      'critFailure',
    ]);
  });

  /**
   * #2115 review: `resolveOneTarget` branches on `spec.mode` — `attack` classifies to
   * crit/hit/miss/critMiss, `save`/`check` to the four degrees — and the families never mix.
   * A schema-valid spec can still carry both, and an attack whose `success` branch healed was
   * printed as a consequence using the action can never reach.
   */
  test('only the outcome family the declared mode can reach is shown', () => {
    const attack = ActionSpec.parse({
      mode: 'attack',
      attack: { bonus: '+5' },
      outcomes: {
        hit: { damage: [{ formula: '1d8', flat: 3, type: 'piercing' }] },
        success: { healing: '2d4' },
        failure: { text: 'Never reached' },
      },
    });
    expect(actionSpecEffects(attack)).toEqual([
      { outcome: 'hit', label: 'On a hit', lines: ['1d8+3 piercing damage'] },
    ]);

    const save = ActionSpec.parse({
      mode: 'save',
      outcomes: {
        hit: { text: 'Never reached' },
        success: { text: 'Shrugged off' },
        failure: { damage: [{ formula: '8d6', flat: 0, type: 'fire' }] },
      },
    });
    expect(actionSpecEffects(save)).toEqual([
      { outcome: 'success', label: 'On a success', lines: ['Shrugged off'] },
      { outcome: 'failure', label: 'On a failure', lines: ['8d6 fire damage'] },
    ]);
  });

  /**
   * `none` never auto-resolves (`isResolvableSpec` returns false), so its branches are prose a
   * human applies rather than a claim about the resolver — nothing to contradict, nothing to
   * filter. This is also the parsed default, so specs that never declared a mode are unchanged.
   */
  test('a descriptive action keeps every branch it was authored with', () => {
    const descriptive = ActionSpec.parse({
      outcomes: { hit: { text: 'Shoves' }, success: { text: 'Holds' } },
    });
    expect(descriptive.mode).toBe('none');
    expect(actionSpecEffects(descriptive).map((g) => g.outcome)).toEqual(['hit', 'success']);
  });

  /**
   * #2115 review, second pass: the borrow is gated on the SELECTED branch's raw array too.
   * `resolveOneTarget` reads `branch.damage.length === 0 && branch.halfDamage`, so a defaulted
   * `success.damage: [{}]` — non-empty, but printing nothing — makes the resolver roll the
   * selected branch for zero rather than borrow the failure branch's dice.
   */
  test('a placeholder on the halving branch stops the borrow, not just on the fallback', () => {
    const placeholderOnSuccess = ActionSpec.parse({
      mode: 'save',
      outcomes: {
        success: { halfDamage: true, damage: [{}] },
        failure: { damage: [{ formula: '8d6', flat: 0, type: 'fire' }] },
      },
    });
    expect(actionSpecEffects(placeholderOnSuccess)).toEqual([
      { outcome: 'failure', label: 'On a failure', lines: ['8d6 fire damage'] },
    ]);

    // Truly empty on the halving branch: the borrow happens, so the promise is real.
    const empty = ActionSpec.parse({
      mode: 'save',
      outcomes: {
        success: { halfDamage: true },
        failure: { damage: [{ formula: '8d6', flat: 0, type: 'fire' }] },
      },
    });
    expect(actionSpecEffects(empty)).toEqual([
      { outcome: 'success', label: 'On a success', lines: ['Half damage'] },
      { outcome: 'failure', label: 'On a failure', lines: ['8d6 fire damage'] },
    ]);
  });

  /**
   * #2115 review: `rollBranchDamage` floors every part with `Math.max(0, amount)`, so a
   * formula-less `{ flat: -3 }` deals nothing — "-3 damage" told players to apply an amount the
   * action never produces. With dice the sign is real: `1d8-1` rolls, and only the total floors.
   */
  test('a negative flat with no dice prints nothing; with dice it still prints', () => {
    const negativeOnly = ActionSpec.parse({
      outcomes: { hit: { text: 'Glances off', damage: [{ flat: -3, type: 'force' }] } },
    });
    expect(actionSpecEffects(negativeOnly)).toEqual([
      { outcome: 'hit', label: 'On a hit', lines: ['Glances off'] },
    ]);

    const withDice = ActionSpec.parse({
      outcomes: { hit: { damage: [{ formula: '1d8', flat: -1, type: 'force' }] } },
    });
    expect(actionSpecEffects(withDice)).toEqual([
      { outcome: 'hit', label: 'On a hit', lines: ['1d8-1 force damage'] },
    ]);
  });

  /**
   * #2115 review: `pickOutcomeBranch` falls back `crit → hit`, so a crit against the hit-only
   * shape `inferActionSpecFromText` produces still deals multiplied damage. Details showed only
   * the base "On a hit" and left the multiplication out.
   */
  test('a crit is disclosed even when only a hit branch was authored', () => {
    const hitOnly = ActionSpec.parse({
      mode: 'attack',
      attack: { bonus: '+5' },
      outcomes: { hit: { damage: [{ formula: '1d8', flat: 3, type: 'slashing' }] } },
    });
    expect(actionSpecEffects(hitOnly, 'double-dice')).toEqual([
      { outcome: 'crit', label: 'On a critical hit', lines: ['1d8+3 slashing damage, dice doubled on a critical'] },
      { outcome: 'hit', label: 'On a hit', lines: ['1d8+3 slashing damage'] },
    ]);
    // PF2e multiplies differently, and the synthesized line says so.
    expect(actionSpecEffects(hitOnly, 'double-total')[0].lines).toEqual([
      '1d8+3 slashing damage, total doubled on a critical',
    ]);
  });

  test('nothing is synthesized where a crit changes nothing, or cannot happen', () => {
    // A system with no critical hits.
    const hitOnly = ActionSpec.parse({
      mode: 'attack',
      attack: { bonus: '+5' },
      outcomes: { hit: { damage: [{ formula: '1d8', flat: 3, type: 'slashing' }] } },
    });
    expect(actionSpecEffects(hitOnly, 'double-dice', false).map((g) => g.outcome)).toEqual(['hit']);

    // No rule supplied — nothing is known about the multiplication, so nothing is claimed.
    expect(actionSpecEffects(hitOnly).map((g) => g.outcome)).toEqual(['hit']);

    // A hit branch with no damage: the crit group would repeat "On a hit" verbatim.
    const proseOnly = ActionSpec.parse({
      mode: 'attack',
      attack: { bonus: '+5' },
      outcomes: { hit: { effects: [{ condition: 'Prone' }] } },
    });
    expect(actionSpecEffects(proseOnly, 'double-dice').map((g) => g.outcome)).toEqual(['hit']);

    // Save mode never reaches an attack crit at all.
    const save = ActionSpec.parse({
      mode: 'save',
      outcomes: { failure: { damage: [{ formula: '8d6', flat: 0, type: 'fire' }] } },
    });
    expect(actionSpecEffects(save, 'double-dice').map((g) => g.outcome)).toEqual(['failure']);
  });

  test('a spec with no outcome branches yields nothing', () => {
    expect(actionSpecEffects(emptySpec())).toEqual([]);
  });

  /**
   * A hand-authored `crit` branch carries BASE damage by schema convention; the resolver
   * applies the campaign's `CriticalDamageRule` on top (5e resolves 1d8+3 as 2d8+3). Printing
   * the branch verbatim understated every critical. The rule is NAMED rather than recomputed
   * into an expression — doubling correctly is the resolver's job, and a second
   * implementation here would be free to disagree with it.
   */
  test('a crit branch names the system rule instead of understating its damage', () => {
    const spec = ActionSpec.parse({
      mode: 'attack',
      outcomes: {
        hit: { damage: [{ formula: '1d8', flat: 3, type: 'slashing' }] },
        crit: { damage: [{ formula: '1d8', flat: 3, type: 'slashing' }] },
      },
    });
    expect(actionSpecEffects(spec, 'double-dice')).toEqual([
      { outcome: 'crit', label: 'On a critical hit', lines: ['1d8+3 slashing damage, dice doubled on a critical'] },
      { outcome: 'hit', label: 'On a hit', lines: ['1d8+3 slashing damage'] },
    ]);
    expect(actionSpecEffects(spec, 'double-total')[0].lines)
      .toEqual(['1d8+3 slashing damage, total doubled on a critical']);
  });

  test('degree branches are consequences as authored — never re-multiplied', () => {
    const spec = ActionSpec.parse({
      mode: 'save',
      outcomes: { critFailure: { damage: [{ formula: '4d6', flat: 0, type: 'fire' }] } },
    });
    expect(actionSpecEffects(spec, 'double-dice')[0].lines).toEqual(['4d6 fire damage']);
  });

  test('with no rule supplied the damage reads plainly', () => {
    const spec = ActionSpec.parse({ outcomes: { crit: { damage: [{ formula: '1d8', flat: 0, type: '' }] } } });
    expect(actionSpecEffects(spec)[0].lines).toEqual(['1d8 damage']);
  });
});

test.describe('actionSourceText — cites a real source, never the sheet itself', () => {
  test('a compendium source is cited, with its ref when present', () => {
    expect(actionSourceText(ActionSpec.parse({ provenance: { source: 'SRD 5.1' } }))).toBe('SRD 5.1');
    expect(actionSourceText(ActionSpec.parse({ provenance: { source: 'SRD 5.1', ref: 'Evocation' } }))).toBe('SRD 5.1 — Evocation');
  });

  // `inferActionSpecFromText` stamps this on a spec it derived from the sheet's own to-hit
  // and damage text. Citing it would claim provenance the action does not have.
  test('a sheet-inferred spec cites nothing', () => {
    expect(actionSourceText(ActionSpec.parse({ provenance: { source: 'sheet-inferred' } }))).toBe('');
  });

  test('a spec with no provenance cites nothing', () => {
    expect(actionSourceText(emptySpec())).toBe('');
  });
});
