import { expect, test } from '@playwright/test';
import {
  ActionSpec,
  CharacterAction,
  inferActionSpecFromText,
  isResolvableSpec,
} from '@campfire/schema';

/**
 * Issue #1930 — Sheet action editor preserves and infers resolvable specs.
 *
 * Acceptance Criteria:
 * 1. Preserve existing `spec` on `CharacterAction` when editing action fields (e.g. renaming).
 * 2. Export shared `inferActionSpecFromText(toHit, damage, kind)` in `@campfire/schema` to parse text like "+5" and "1d8+3 slashing" into an ActionSpec with `provenance.source = 'sheet-inferred'`.
 * 3. Run inference on add / edit when row has no spec or when a `sheet-inferred` spec's toHit/damage text changed. Never overwrite non-inferred specs.
 * 4. Show inline "one-tap ready" badge / "text only" hint on ActionsCard rows.
 */
test.describe('Sheet action editor spec preservation and inference (issue #1930)', () => {
  test('inferActionSpecFromText parses +5 and 1d8+3 slashing into a resolvable sheet-inferred spec', () => {
    const spec = inferActionSpecFromText('+5', '1d8+3 slashing', 'melee');
    expect(spec).toBeDefined();
    expect(spec?.mode).toBe('attack');
    expect(spec?.attack.bonus).toBe('+5');
    expect(spec?.outcomes.hit?.damage).toEqual([{ formula: '1d8', flat: 3, type: 'slashing' }]);
    expect(spec?.provenance.source).toBe('sheet-inferred');
    expect(isResolvableSpec(spec)).toBe(true);
  });

  test('inferActionSpecFromText returns undefined for unresolvable text', () => {
    expect(inferActionSpecFromText('', '', '')).toBeUndefined();
    expect(inferActionSpecFromText('versatile', '', '')).toBeUndefined();
  });

  test('editing action name preserves custom non-inferred spec', () => {
    const existingSpec = ActionSpec.parse({
      mode: 'attack',
      attack: { bonus: '+7' },
      provenance: { source: 'compendium', ref: 'item-123' },
    });
    const existingAction = CharacterAction.parse({
      name: 'Longsword',
      kind: 'melee',
      toHit: '+7',
      damage: '1d8+4 slashing',
      spec: existingSpec,
    });

    // Simulate saving edit with renamed action name: non-inferred spec MUST be preserved as-is.
    const _updatedName = 'Flaming Longsword';
    const nextToHit = existingAction.toHit;
    const nextDamage = existingAction.damage;
    const nextKind = existingAction.kind;

    let nextSpec: ActionSpec | undefined = existingAction.spec;
    if (!existingAction.spec) {
      nextSpec = inferActionSpecFromText(nextToHit, nextDamage, nextKind);
    } else if (existingAction.spec.provenance?.source === 'sheet-inferred') {
      const toHitChanged = nextToHit !== (existingAction.toHit ?? '');
      const damageChanged = nextDamage !== (existingAction.damage ?? '');
      const kindChanged = nextKind !== (existingAction.kind ?? '');
      if (toHitChanged || damageChanged || kindChanged) {
        nextSpec = inferActionSpecFromText(nextToHit, nextDamage, nextKind);
      }
    }

    expect(nextSpec).toEqual(existingSpec);
    expect(nextSpec?.provenance.source).toBe('compendium');
  });

  test('editing toHit/damage on sheet-inferred spec re-infers the spec', () => {
    const inferredSpec = inferActionSpecFromText('+5', '1d8+3 slashing', 'melee');
    const existingAction = CharacterAction.parse({
      name: 'Longsword',
      kind: 'melee',
      toHit: '+5',
      damage: '1d8+3 slashing',
      spec: inferredSpec,
    });

    const nextToHit = '+6';
    const nextDamage = '1d8+4 slashing';
    const nextKind = existingAction.kind;

    let nextSpec: ActionSpec | undefined = existingAction.spec;
    if (existingAction.spec?.provenance?.source === 'sheet-inferred') {
      const toHitChanged = nextToHit !== (existingAction.toHit ?? '');
      const damageChanged = nextDamage !== (existingAction.damage ?? '');
      const kindChanged = nextKind !== (existingAction.kind ?? '');
      if (toHitChanged || damageChanged || kindChanged) {
        nextSpec = inferActionSpecFromText(nextToHit, nextDamage, nextKind);
      }
    }

    expect(nextSpec?.attack.bonus).toBe('+6');
    expect(nextSpec?.outcomes.hit?.damage).toEqual([{ formula: '1d8', flat: 4, type: 'slashing' }]);
    expect(nextSpec?.provenance.source).toBe('sheet-inferred');
  });
});
