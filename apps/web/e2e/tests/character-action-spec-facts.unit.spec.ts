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

  test('a range the spec never set is omitted rather than rendered empty', () => {
    const facts = actionSpecFacts(emptySpec());
    expect(facts.map((f) => f.label)).not.toContain('Range');
    expect(facts.every((f) => f.value !== '')).toBe(true);
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
    expect(actionSpecFacts(ActionSpec.parse({ uses: { max: 0 } })).map((f) => f.label)).not.toContain('Uses');
    expect(actionSpecFacts(ActionSpec.parse({ uses: { max: 3, recharge: 'long-rest' } })))
      .toContainEqual({ label: 'Uses', value: '3 per long-rest' });
  });

  test('targeting reads as targets, as an area, or not at all', () => {
    expect(actionSpecFacts(ActionSpec.parse({ targets: { count: 1 } })))
      .toContainEqual({ label: 'Targets', value: '1 target' });
    expect(actionSpecFacts(ActionSpec.parse({ targets: { count: 2, allow: 'ally' } })))
      .toContainEqual({ label: 'Targets', value: '2 targets (ally)' });
    expect(actionSpecFacts(ActionSpec.parse({ targets: { count: 0 }, range: { size: '15 ft' } })))
      .toContainEqual({ label: 'Targets', value: 'Area' });
    expect(actionSpecFacts(ActionSpec.parse({ targets: { count: 0 } })).map((f) => f.label)).not.toContain('Targets');
  });
});

test.describe('actionSpecEffects — player-safe branch prose, deduplicated', () => {
  test('an effect shared by the hit and crit branches is listed once', () => {
    const spec = ActionSpec.parse({
      outcomes: {
        hit: { effects: [{ condition: 'Prone' }] },
        crit: { effects: [{ condition: 'Prone' }] },
      },
    });
    expect(actionSpecEffects(spec)).toEqual(['Prone']);
  });

  test('duration and save-ends are spelled out beside the condition', () => {
    const spec = ActionSpec.parse({
      outcomes: { failure: { text: 'The target is scorched.', effects: [{ condition: 'Frightened', rounds: 1, saveEnds: true }] } },
    });
    expect(actionSpecEffects(spec)).toEqual(['The target is scorched.', 'Frightened (1 round), save ends']);
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
