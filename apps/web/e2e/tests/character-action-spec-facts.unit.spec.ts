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

  test('either field alone still reads', () => {
    expect(actionSpecEffects(ActionSpec.parse({ outcomes: { hit: { effects: [{ condition: 'Blinded' }] } } }))[0].lines)
      .toEqual(['Blinded']);
    expect(actionSpecEffects(ActionSpec.parse({ outcomes: { hit: { effects: [{ text: 'Pushed 10 feet' }] } } }))[0].lines)
      .toEqual(['Pushed 10 feet']);
  });

  test('ongoing damage rides with the condition it belongs to', () => {
    const spec = ActionSpec.parse({
      outcomes: { hit: { effects: [{ condition: 'Burning', rounds: 3, ongoingDamage: 5 }] } },
    });
    expect(actionSpecEffects(spec)[0].lines).toEqual(['Burning (3 rounds) · 5 ongoing damage']);
  });

  test('a branch that truly says nothing still contributes no group', () => {
    const spec = ActionSpec.parse({ outcomes: { miss: {} } });
    expect(actionSpecEffects(spec)).toEqual([]);
  });

  test('a spec with no outcome branches yields nothing', () => {
    expect(actionSpecEffects(emptySpec())).toEqual([]);
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
