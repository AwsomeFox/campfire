import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { startFakeDdb, PUBLIC_DDB_CHARACTER, PUBLIC_DDB_CHARACTER_ID, CASTER_DDB_CHARACTER, CASTER_DDB_CHARACTER_ID, type FakeDdb } from './fake-ddb';
import { mapDdbCharacter, summarizeDdbImport, computeSpellSlots, computeDdbActionEntryCount, parseDdbId } from '../src/modules/characters/ddb-importer';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { rulePacks } from '../src/db/schema';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'ddb-owner' };

/**
 * Issue #18 — D&D Beyond public character import. Two layers:
 *  1. Pure-mapper unit tests against the representative captured sheet in fake-ddb.ts
 *     (no server, no app) — the mapping is the load-bearing logic.
 *  2. Endpoint tests through the real Nest app, with the character-service base URL
 *     pointed at an in-process fake server (DDB_CHARACTER_SERVICE_BASE_URL), mirroring
 *     how the Open5e importer is tested against a fake API. Covers the happy path plus
 *     the private/404/unavailable clean-error paths.
 */
describe('D&D Beyond character import — mapper (unit)', () => {
  it('parseDdbId accepts a bare id and several URL shapes', () => {
    expect(parseDdbId('12345678')).toBe('12345678');
    expect(parseDdbId('https://www.dndbeyond.com/characters/12345678')).toBe('12345678');
    expect(parseDdbId('https://www.dndbeyond.com/profile/someone/characters/12345678')).toBe('12345678');
    expect(parseDdbId('  12345678  ')).toBe('12345678');
    expect(() => parseDdbId('not-a-character')).toThrow();
    expect(() => parseDdbId('')).toThrow();
  });

  it('maps a representative public sheet into a Campfire character', () => {
    const c = mapDdbCharacter(PUBLIC_DDB_CHARACTER);
    expect(c.name).toBe('Thornbeard Ironfist');
    expect(c.species).toBe('Hill Dwarf');
    // Multiclass -> per-class levels in the label; total level is the sum.
    expect(c.className).toBe('Fighter 3 / Rogue 2');
    expect(c.level).toBe(5);
    // Con 14 base + 2 racial ASI (from modifiers) = 16.
    expect(c.stats).toEqual({ STR: 16, DEX: 12, CON: 16, INT: 10, WIS: 13, CHA: 8 });
    // Chain mail (heavy AC 16, no Dex) + shield (+2) = 18.
    expect(c.ac).toBe(18);
    // 39 base + Con-mod(+3) * 5 levels = 54; 7 damage -> 47 current.
    expect(c.hpMax).toBe(54);
    expect(c.hpCurrent).toBe(47);
    expect(c.background).toBe('Soldier');
    expect(c.xp).toBe(6500);
    expect(c.ddbId).toBe(String(PUBLIC_DDB_CHARACTER_ID));
    expect(new Set(c.saveProficiencies)).toEqual(new Set(['STR', 'CON']));
    expect(c.skills).toEqual({ Perception: 'proficient', Stealth: 'expertise' });
    expect(c.portraitUrl).toBe('https://www.dndbeyond.com/avatars/thornbeard.png');
    expect(c.notes).toContain('left the mountain halls');
  });

  // Issue #1903 — attacks/actions.
  it('maps the equipped weapon into a resolvable attack action (fighter fixture)', () => {
    const c = mapDdbCharacter(PUBLIC_DDB_CHARACTER);
    const longsword = c.actions?.find((a) => a.name === 'Longsword');
    expect(longsword).toBeDefined();
    // STR 16 (mod +3) + proficiency bonus at level 5 (+3) = +6; 1d8+3 slashing.
    expect(longsword?.toHit).toBe('+6');
    expect(longsword?.damage).toBe('1d8+3 slashing');
    expect(longsword?.spec?.mode).toBe('attack');
    expect(longsword?.spec?.attack.bonus).toBe('+6');
    expect(longsword?.spec?.outcomes.hit?.damage).toEqual([{ formula: '1d8', flat: 3, type: 'slashing' }]);
  });

  it('does not import an unequipped weapon as an attack', () => {
    const c = mapDdbCharacter(PUBLIC_DDB_CHARACTER);
    expect(c.actions?.some((a) => a.name === 'Dagger')).toBe(false);
  });

  it('maps an attack-less class feature as a text-only action, never dropped', () => {
    const c = mapDdbCharacter(PUBLIC_DDB_CHARACTER);
    const secondWind = c.actions?.find((a) => a.name === 'Second Wind');
    expect(secondWind).toBeDefined();
    expect(secondWind?.spec).toBeUndefined();
    expect(secondWind?.notes).toContain('Regain 1d10+5');
  });

  it('non-caster fighter gets empty spellSlots', () => {
    const c = mapDdbCharacter(PUBLIC_DDB_CHARACTER);
    expect(c.spellSlots).toEqual({});
  });

  it('summarizeDdbImport reports the text-only feature and the resolvable weapon attack', () => {
    const c = mapDdbCharacter(PUBLIC_DDB_CHARACTER);
    const summary = summarizeDdbImport(c);
    expect(summary.spellSlotsImported).toBe(false);
    expect(summary.spellsImported).toBe(0);
    expect(summary.actionsImported).toBeGreaterThanOrEqual(2); // Longsword + Second Wind
    expect(summary.textOnly).toContain('Second Wind');
    expect(summary.textOnly).not.toContain('Longsword');
  });

  // Regression for a PR #1950 review finding: every imported spell carries a `spec` object
  // (`{uses:{spellLevel}}`, needed for slot tracking) but is never given an attack/save
  // `mode` (DDB's target-save-ability fields aren't reliably shaped), so `isResolvableSpec`
  // is false for all of them — matching the encounter UI's own Use-button gate. `textOnly`
  // must flag them by resolvability, not by mere `spec` presence, or the DM is never told
  // these need a manual attack/save mode before they can be cast via the Use flow.
  it('summarizeDdbImport flags every imported spell as needing touch-up (not auto-resolvable)', () => {
    const c = mapDdbCharacter(CASTER_DDB_CHARACTER);
    const summary = summarizeDdbImport(c);
    expect(summary.spellsImported).toBe(3);
    expect(summary.textOnly).toEqual(expect.arrayContaining(['Find Familiar', 'Fire Bolt', 'Magic Missile']));
  });

  // Issue #1903 — spells / spell slots.
  it('maps class + feat-granted spells into kind:"spell" actions with spec.uses.spellLevel set', () => {
    const c = mapDdbCharacter(CASTER_DDB_CHARACTER);
    const spells = c.actions?.filter((a) => a.kind === 'spell') ?? [];
    const names = spells.map((s) => s.name).sort();
    // Mage Armor is prepared:false -> excluded.
    expect(names).toEqual(['Find Familiar', 'Fire Bolt', 'Magic Missile']);
    const fireBolt = spells.find((s) => s.name === 'Fire Bolt');
    expect(fireBolt?.spec?.uses.spellLevel).toBe(0); // cantrip
    const magicMissile = spells.find((s) => s.name === 'Magic Missile');
    expect(magicMissile?.spec?.uses.spellLevel).toBe(1);
    const findFamiliar = spells.find((s) => s.name === 'Find Familiar');
    expect(findFamiliar?.spec?.uses.spellLevel).toBe(1);
    expect(findFamiliar?.notes).toContain('Ritual.');
  });

  it('computes wizard spell slots from the full-caster table by level (fallback table, issue #1903)', () => {
    const c = mapDdbCharacter(CASTER_DDB_CHARACTER);
    // Level 5 Wizard (full caster): PHB slots 4/3/2 at levels 1/2/3.
    expect(c.spellSlots).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 3, used: 0 },
      '3': { max: 2, used: 0 },
    });
  });

  it('computeSpellSlots: Warlock alongside another caster contributes only its own table, no Pact Magic', () => {
    // Level 6 Paladin (half caster, solo alongside a Warlock -> Pact Magic is excluded from
    // this combination per PHB p.165, so Paladin uses its own table: ceil(6/2) = 3).
    const slots = computeSpellSlots([
      { level: 6, definition: { name: 'Paladin' } },
      { level: 3, definition: { name: 'Warlock' } },
    ]);
    // Effective full-caster level 3 -> 4 level-1 / 2 level-2 slots (PHB multiclass table).
    // No Pact Magic entries are added on top — see the regression test below.
    expect(slots).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 2, used: 0 },
    });
  });

  // Regression for a PR #1950 review finding: Pact Magic slots have a different recovery
  // cadence (short rest) than ordinary spell slots (long rest only — see
  // resetSpellSlotsForRest in packages/schema/src/rest.ts), so merging them into the same
  // pool would silently mismodel a Warlock's recovery. Not imported until #1039 gives Pact
  // Magic its own representation.
  it('a solo Warlock gets no spell slots imported (Pact Magic is not modeled here yet)', () => {
    expect(computeSpellSlots([{ level: 5, definition: { name: 'Warlock' } }])).toEqual({});
    expect(computeSpellSlots([{ level: 20, definition: { name: 'Warlock' } }])).toEqual({});
  });

  it('computeSpellSlots returns {} for a non-caster class', () => {
    expect(computeSpellSlots([{ level: 5, definition: { name: 'Fighter' } }])).toEqual({});
    expect(computeSpellSlots(null)).toEqual({});
  });

  // Regression for a PR #1950 review finding: the solo half-caster ceil(level/2) fix
  // (above) incorrectly granted a level-1 Paladin/Ranger 2 first-level slots — those
  // classes get no Spellcasting at all until level 2 (PHB).
  it('a level-1 solo Paladin/Ranger gets no spell slots (Spellcasting starts at level 2)', () => {
    expect(computeSpellSlots([{ level: 1, definition: { name: 'Paladin' } }])).toEqual({});
    expect(computeSpellSlots([{ level: 1, definition: { name: 'Ranger' } }])).toEqual({});
  });

  it('a level-1 Artificer DOES get its first spell slot (unlike Paladin/Ranger)', () => {
    expect(computeSpellSlots([{ level: 1, definition: { name: 'Artificer' } }])).toEqual({
      '1': { max: 2, used: 0 },
    });
  });

  // Regression for a PR #1950 review finding: every synthesized slot pool was persisted
  // with used:0, discarding the sheet's actual current expenditure and granting a free
  // long rest on import.
  it('computeSpellSlots preserves the sheet\'s current slot expenditure, clamped to max', () => {
    // Level 5 Wizard: PHB max is 4/3/2 at levels 1/2/3 (see the fallback-table test above).
    const slots = computeSpellSlots([{ level: 5, definition: { name: 'Wizard' } }], { '1': 2, '2': 1 });
    expect(slots).toEqual({
      '1': { max: 4, used: 2 },
      '2': { max: 3, used: 1 },
      '3': { max: 2, used: 0 },
    });
  });

  it('computeSpellSlots clamps an implausible source used-count to the computed max', () => {
    const slots = computeSpellSlots([{ level: 5, definition: { name: 'Wizard' } }], { '1': 999 });
    expect(slots?.['1']).toEqual({ max: 4, used: 4 });
  });

  it('mapDdbCharacter reads used slots from data.spellSlots', () => {
    const c = mapDdbCharacter({
      classes: [{ level: 5, definition: { name: 'Wizard' } }],
      spellSlots: [{ level: 1, used: 3 }, { level: 2, used: 1 }],
    });
    expect(c.spellSlots).toEqual({
      '1': { max: 4, used: 3 },
      '2': { max: 3, used: 1 },
      '3': { max: 2, used: 0 },
    });
  });

  // Regression for a PR #1950 review finding: a solo half-caster used the multiclass
  // floor(level/2) formula, undercounting slots at every odd level.
  it('a solo level-5 Paladin gets its own class table (ceil), not the multiclass floor', () => {
    const slots = computeSpellSlots([{ level: 5, definition: { name: 'Paladin' } }]);
    // PHB Paladin table at level 5: 4 first-level, 2 second-level. floor(5/2)=2 would have
    // given only 3 first-level and nothing else.
    expect(slots).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 2, used: 0 },
    });
  });

  it('a solo level-5 Ranger gets the same single-class table as a solo Paladin', () => {
    const slots = computeSpellSlots([{ level: 5, definition: { name: 'Ranger' } }]);
    expect(slots).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 2, used: 0 },
    });
  });

  it('a genuine multiclass (Paladin 3 / Wizard 2) still uses the combining floor(level/2)', () => {
    const slots = computeSpellSlots([
      { level: 3, definition: { name: 'Paladin' } },
      { level: 2, definition: { name: 'Wizard' } },
    ]);
    // floor(3/2)=1 (Paladin) + 2 (Wizard) = effective level 3 -> row3 = 4 first, 2 second.
    expect(slots).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 2, used: 0 },
    });
  });

  it('Artificer uses the same solo half-caster curve as Paladin/Ranger', () => {
    const slots = computeSpellSlots([{ level: 5, definition: { name: 'Artificer' } }]);
    expect(slots).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 2, used: 0 },
    });
  });

  // Regression for a PR #1950 review finding: Artificer rounds UP when multiclassed
  // (Tasha's/Sage Advice), unlike Paladin/Ranger which round DOWN when combined.
  it('Artificer rounds up (not down) when multiclassed with another caster', () => {
    const slots = computeSpellSlots([
      { level: 3, definition: { name: 'Artificer' } },
      { level: 2, definition: { name: 'Wizard' } },
    ]);
    // ceil(3/2)=2 (Artificer, rounds up even combined) + 2 (Wizard) = effective level 4 ->
    // row4 = 4 first, 3 second. The Paladin/Ranger (floor) rule would give effective level 3.
    expect(slots).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 3, used: 0 },
    });
  });

  it('recognizes Eldritch Knight and Arcane Trickster as 1/3 casters by subclass', () => {
    // A level-7 solo Eldritch Knight: PHB Fighter spellcasting table row for level 7 is
    // 4 first-level, 2 second-level (ceil(7/3) = 3 -> full-caster row 3).
    const ek = computeSpellSlots([{ level: 7, definition: { name: 'Fighter' }, subclassDefinition: { name: 'Eldritch Knight' } }]);
    expect(ek).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 2, used: 0 },
    });
    const at = computeSpellSlots([{ level: 7, definition: { name: 'Rogue' }, subclassDefinition: { name: 'Arcane Trickster' } }]);
    expect(at).toEqual(ek);
    // A plain Fighter with no matching subclass is still a non-caster.
    expect(computeSpellSlots([{ level: 7, definition: { name: 'Fighter' }, subclassDefinition: { name: 'Champion' } }])).toEqual({});
  });

  // Regression for a Devin/Kilo review finding on PR #1950: an unclamped ceil(level/3) for a
  // SOLO third-caster read row 7 of the full-caster table (4/3/3/1) at class levels 19-20,
  // inventing a 4th-level slot the real Eldritch Knight/Arcane Trickster table never grants
  // (it stops progressing at 4/3/3 for levels 16-20 — full-caster row 6).
  it('a solo Eldritch Knight/Arcane Trickster at level 19-20 does not get an invented 4th-level slot', () => {
    const level19 = computeSpellSlots([{ level: 19, definition: { name: 'Fighter' }, subclassDefinition: { name: 'Eldritch Knight' } }]);
    expect(level19).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 3, used: 0 },
      '3': { max: 3, used: 0 },
    });
    const level20 = computeSpellSlots([{ level: 20, definition: { name: 'Rogue' }, subclassDefinition: { name: 'Arcane Trickster' } }]);
    expect(level20).toEqual(level19);
  });

  // Regression for a PR #1950 review finding: an overlong spell name must never abort the
  // whole import — CharacterAction.name is capped at 120 chars (mirrors
  // expandRawStatblockAction's identical clamp for weapon/feature actions).
  it('clamps an overlong spell name to 120 chars instead of throwing', () => {
    const longName = 'A'.repeat(150);
    const c = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Wizard' } }],
      classSpells: [{ spells: [{ definition: { name: longName, level: 0 }, prepared: true }] }],
    });
    const spell = c.actions?.find((a) => a.kind === 'spell');
    expect(spell).toBeDefined();
    expect(spell?.name).toBe('A'.repeat(120));
    expect(spell?.name.length).toBe(120);
  });

  // Regression for a PR #1950 review finding: `ActionUses.spellLevel` has no "unknown"
  // representation (a plain 0-9 int defaulting to 0), and 0 means a real thing — a free
  // cantrip. A missing/invalid `definition.level` used to silently become 0, misrepresenting
  // a sparse/malformed sheet's leveled spell as a free cantrip. It must omit `spec` entirely
  // instead (still imported, still visible in the summary, just without spellLevel tracking).
  it('a spell with a missing or invalid level omits spec instead of defaulting to a free cantrip', () => {
    const c = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Wizard' } }],
      classSpells: [
        {
          spells: [
            { definition: { name: 'Missing Level Spell' }, prepared: true },
            { definition: { name: 'Bad Level Spell', level: 99 }, prepared: true },
            { definition: { name: 'Fine Cantrip', level: 0 }, prepared: true },
          ],
        },
      ],
    });
    expect(c.actions?.find((a) => a.name === 'Missing Level Spell')?.spec).toBeUndefined();
    expect(c.actions?.find((a) => a.name === 'Bad Level Spell')?.spec).toBeUndefined();
    // A genuinely-confirmed level-0 cantrip is unaffected — still gets its spec.
    expect(c.actions?.find((a) => a.name === 'Fine Cantrip')?.spec?.uses.spellLevel).toBe(0);
  });

  // Regression for a PR #1950 review finding: `DDB_HTML_ENTITIES` is a plain object literal
  // and inherits `Object.prototype`; the entity regex accepts any [a-zA-Z]+, so untrusted
  // sheet text containing "&constructor;"/"&toString;"/"&valueOf;"/"&hasOwnProperty;" used to
  // resolve to an INHERITED FUNCTION (truthy, so `??` never fell back), which got stringified
  // into the imported note as garbled text instead of being left as written.
  it('an HTML entity matching an inherited Object.prototype property is left as written, not stringified', () => {
    const c = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Fighter' } }],
      actions: {
        class: [{ name: 'Prototype Pollution Check', description: 'Weird &constructor; and &toString; and &hasOwnProperty; text.' }],
      },
    });
    const feature = c.actions?.find((a) => a.name === 'Prototype Pollution Check');
    expect(feature?.notes).toBe('Weird &constructor; and &toString; and &hasOwnProperty; text.');
    expect(feature?.notes).not.toContain('function');
    expect(feature?.notes).not.toContain('[native code]');
  });

  // Regression for a PR #1950 review finding: a magic (+1/+2/+3) weapon was rolled as
  // mundane — the enchantment bonus was never read (the simplified item shape here has no
  // reliable numeric field for it), so the reported attack/damage silently under-counted.
  it('a magic weapon lands text-only instead of being rolled as mundane', () => {
    const c = mapDdbCharacter({
      classes: [{ level: 5, definition: { name: 'Fighter' } }],
      inventory: [
        {
          equipped: true,
          definition: {
            name: 'Longsword +1',
            filterType: 'Weapon',
            attackType: 1,
            damage: { diceString: '1d8' },
            damageType: 'Slashing',
            magic: true,
          },
        },
      ],
    });
    const weapon = c.actions?.find((a) => a.name === 'Longsword +1');
    expect(weapon).toBeDefined();
    expect(weapon?.spec).toBeUndefined();
    expect(weapon?.notes).toContain('enchantment bonus');
    const summary = summarizeDdbImport(c);
    expect(summary.textOnly).toContain('Longsword +1');
  });

  // Regression for a PR #1950 review finding: entries beyond the internal per-category
  // caps used to be silently discarded even when there was room under the schema's
  // Character.actions max(100). computeDdbActionEntryCount + summarizeDdbImport's
  // entriesOmitted must report the true overflow honestly instead.
  it('reports entriesOmitted honestly when raw entries exceed the 100-action schema cap', () => {
    const manyFeatures = Array.from({ length: 130 }, (_, i) => ({ name: `Feature ${i}` }));
    const data = { actions: { feat: manyFeatures } };
    const c = mapDdbCharacter(data);
    expect(c.actions?.length).toBe(100);
    const rawCount = computeDdbActionEntryCount(data);
    expect(rawCount).toBe(130);
    const summary = summarizeDdbImport(c, Math.max(0, rawCount - 100));
    expect(summary.entriesOmitted).toBe(30);
  });

  it('summarizeDdbImport defaults entriesOmitted to 0 when not given a raw count', () => {
    const c = mapDdbCharacter(PUBLIC_DDB_CHARACTER);
    expect(summarizeDdbImport(c).entriesOmitted).toBe(0);
  });

  // Regression for a PR #1950 review finding: an earlier version of computeDdbActionEntryCount
  // reused the capped mapping functions, so a category with MORE raw entries than
  // RAW_ENTRY_SAFETY_CAP (300) was itself undercounted by exactly the excess — the reported
  // entriesOmitted was silently wrong past that point, contradicting the "always reported"
  // promise. The dedicated counting pass must stay accurate well past that cap.
  it('computeDdbActionEntryCount stays accurate past the mapping pass\'s 300-entry safety cap', () => {
    const manyFeatures = Array.from({ length: 350 }, (_, i) => ({ name: `Feature ${i}` }));
    const data = { actions: { feat: manyFeatures } };
    expect(computeDdbActionEntryCount(data)).toBe(350);
  });

  // Regression for a PR #1950 review finding: an out-of-range numeric HTML entity (outside
  // Unicode's 0..0x10FFFF) made String.fromCodePoint throw, aborting the entire import with
  // an unhandled 500 over one bad character in a description.
  it('an out-of-range numeric HTML entity does not crash the import', () => {
    const c = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Wizard' } }],
      classSpells: [
        {
          spells: [{ definition: { name: 'Weird Spell', level: 0, description: 'Bad entity &#9999999; here.' }, prepared: true }],
        },
      ],
    });
    const spell = c.actions?.find((a) => a.name === 'Weird Spell');
    expect(spell).toBeDefined();
    expect(spell?.notes).toContain('Bad entity');
    expect(spell?.notes).toContain('here.');
  });

  // Regression for a PR #1950 review finding: a feature with attackTypeRange set but no
  // resolvable governing ability (missing/unknown abilityModifierStatId) used to default to
  // a modifier of 0 and still be marked resolvable — a guessed to-hit presented as real, and
  // never flagged in the summary. It must land text-only instead.
  it('an attack-shaped feature with no resolvable ability lands text-only, not a guessed +0', () => {
    const c = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Fighter' } }],
      actions: { class: [{ name: 'Mystery Strike', attackTypeRange: 5 }] },
    });
    const feature = c.actions?.find((a) => a.name === 'Mystery Strike');
    expect(feature).toBeDefined();
    expect(feature?.spec).toBeUndefined();
    const summary = summarizeDdbImport(c);
    expect(summary.textOnly).toContain('Mystery Strike');
  });

  // Regression for a PR #1950 review finding: a fixedSaveDc feature with no resolvable
  // saveStatId used to default to a DEX save and be marked resolvable — inventing which
  // ability the target saves with. It must land text-only instead.
  it('a save-shaped feature with no resolvable save ability lands text-only, not an invented DEX save', () => {
    const c = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Fighter' } }],
      actions: { class: [{ name: 'Mystery Breath', fixedSaveDc: 15 }] },
    });
    const feature = c.actions?.find((a) => a.name === 'Mystery Breath');
    expect(feature).toBeDefined();
    expect(feature?.spec).toBeUndefined();
    const summary = summarizeDdbImport(c);
    expect(summary.textOnly).toContain('Mystery Breath');
  });

  // Regression for a PR #1950 review finding: an attack-shaped feature's `spec.cost.slot`
  // was hardcoded to 'action' regardless of the feature's real DDB activation type, so an
  // imported reaction or bonus-action feature would consume the actor's ACTION when
  // resolved in an encounter instead of the correct action-economy resource.
  it('an attack-shaped feature reads its cost.slot from the DDB activation type (bonus/reaction/default action)', () => {
    const stats = [{ id: 1, value: 16 }];
    const bonusFeature = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Fighter' } }],
      stats,
      actions: { class: [{ name: 'Bonus Strike', attackTypeRange: 5, abilityModifierStatId: 1, activation: { activationType: 3 } }] },
    }).actions?.find((a) => a.name === 'Bonus Strike');
    expect(bonusFeature?.spec?.cost.slot).toBe('bonus');

    const reactionFeature = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Fighter' } }],
      stats,
      actions: { class: [{ name: 'Reaction Strike', attackTypeRange: 5, abilityModifierStatId: 1, activation: { activationType: 4 } }] },
    }).actions?.find((a) => a.name === 'Reaction Strike');
    expect(reactionFeature?.spec?.cost.slot).toBe('reaction');

    // An explicit ordinary-action activationType (1) is the only other supported case.
    const actionFeature = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Fighter' } }],
      stats,
      actions: { class: [{ name: 'Plain Strike', attackTypeRange: 5, abilityModifierStatId: 1, activation: { activationType: 1 } }] },
    }).actions?.find((a) => a.name === 'Plain Strike');
    expect(actionFeature?.spec?.cost.slot).toBe('action');

    // Regression for a follow-up review finding: an activation type this importer can't map
    // to a real action-economy slot (no action, minute, hour, special, legendary — or a
    // missing/unrecognized value) must not silently fall back to 'action' either, since that
    // would still spend a resource the source feature doesn't actually cost. The whole entry
    // goes text-only instead, even though attackTypeRange/abilityModifierStatId both resolve.
    for (const activation of [undefined, { activationType: 2 }, { activationType: 5 }, { activationType: 6 }, { activationType: 7 }, { activationType: 8 }, { activationType: 999 }]) {
      const c = mapDdbCharacter({
        classes: [{ level: 1, definition: { name: 'Fighter' } }],
        stats,
        actions: { class: [{ name: 'Unsupported Activation Strike', attackTypeRange: 5, abilityModifierStatId: 1, activation }] },
      });
      const feature = c.actions?.find((a) => a.name === 'Unsupported Activation Strike');
      expect(feature?.spec).toBeUndefined();
      expect(summarizeDdbImport(c).textOnly).toContain('Unsupported Activation Strike');
    }
  });

  // Regression for a PR #1950 review finding: same principle as the two feature-action
  // cases above, applied to equipped weapons — a sparse/changed sheet that omits the
  // governing STR/DEX score used to default to a modifier of 0 and stay resolvable.
  it('an equipped weapon with no resolvable ability score lands text-only, not a guessed +0', () => {
    const c = mapDdbCharacter({
      // No `stats` at all -> computeAbilityScores omits every ability key entirely.
      classes: [{ level: 1, definition: { name: 'Fighter' } }],
      inventory: [
        {
          equipped: true,
          definition: { name: 'Mystery Sword', filterType: 'Weapon', attackType: 1, damage: { diceString: '1d8' }, damageType: 'Slashing' },
        },
      ],
    });
    const weapon = c.actions?.find((a) => a.name === 'Mystery Sword');
    expect(weapon).toBeDefined();
    expect(weapon?.spec).toBeUndefined();
    const summary = summarizeDdbImport(c);
    expect(summary.textOnly).toContain('Mystery Sword');
  });

  // Regression for a PR #1950 review finding: a Monk/Warlock/Artificer can attack with a
  // non-STR ability for some weapons (Martial Arts, Hex Warrior, Battle Ready) that this
  // importer cannot detect from the sparse item shape it reads. A non-finesse, non-ranged
  // weapon used to default to STR unconditionally and stay resolvable even for these
  // classes, presenting a plausibly-wrong to-hit/damage as confident.
  it('a Monk/Warlock/Artificer non-finesse weapon lands text-only instead of assuming STR', () => {
    const inventory = [
      { equipped: true, definition: { name: 'Quarterstaff', filterType: 'Weapon', attackType: 1, damage: { diceString: '1d6' }, damageType: 'Bludgeoning' } },
    ];
    const stats = [
      { id: 1, value: 10 },
      { id: 2, value: 16 },
    ];
    for (const className of ['Monk', 'Warlock', 'Artificer']) {
      const c = mapDdbCharacter({ classes: [{ level: 1, definition: { name: className } }], stats, inventory });
      const weapon = c.actions?.find((a) => a.name === 'Quarterstaff');
      expect(weapon).toBeDefined();
      expect(weapon?.spec).toBeUndefined();
      expect(summarizeDdbImport(c).textOnly).toContain('Quarterstaff');
    }
  });

  it('a Fighter still gets a resolvable STR attack for the same non-finesse weapon (STR default is safe for this class)', () => {
    const c = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Fighter' } }],
      stats: [
        { id: 1, value: 16 },
        { id: 2, value: 10 },
      ],
      inventory: [
        { equipped: true, definition: { name: 'Quarterstaff', filterType: 'Weapon', attackType: 1, damage: { diceString: '1d6' }, damageType: 'Bludgeoning' } },
      ],
    });
    const weapon = c.actions?.find((a) => a.name === 'Quarterstaff');
    expect(weapon?.spec).toBeDefined();
  });

  // Regression for a PR #1950 review finding: D&D Beyond's item builder lets any class
  // equip any weapon regardless of proficiency, so unconditionally adding the proficiency
  // bonus (the previous behavior) over-counted the to-hit for a class without full martial
  // weapon proficiency — e.g. a Wizard equipping and being credited proficiency with a
  // martial longsword they were never trained with.
  it('a non-full-martial-proficiency class (Wizard) gets a text-only weapon instead of an assumed proficiency bonus', () => {
    const c = mapDdbCharacter({
      classes: [{ level: 5, definition: { name: 'Wizard' } }],
      stats: [{ id: 1, value: 16 }],
      inventory: [{ equipped: true, definition: { name: 'Longsword', filterType: 'Weapon', attackType: 1, damage: { diceString: '1d8' }, damageType: 'Slashing' } }],
    });
    const weapon = c.actions?.find((a) => a.name === 'Longsword');
    expect(weapon).toBeDefined();
    expect(weapon?.spec).toBeUndefined();
    expect(summarizeDdbImport(c).textOnly).toContain('Longsword');
  });

  it('every full-martial-proficiency class (Barbarian, Fighter, Paladin, Ranger) still gets a resolvable weapon attack', () => {
    for (const className of ['Barbarian', 'Fighter', 'Paladin', 'Ranger']) {
      const c = mapDdbCharacter({
        classes: [{ level: 5, definition: { name: className } }],
        stats: [{ id: 1, value: 16 }],
        inventory: [{ equipped: true, definition: { name: 'Longsword', filterType: 'Weapon', attackType: 1, damage: { diceString: '1d8' }, damageType: 'Slashing' } }],
      });
      expect(c.actions?.find((a) => a.name === 'Longsword')?.spec).toBeDefined();
    }
  });

  // Regression for a PR #1950 review finding: a Fighting-Style-shaped bonus modifier (e.g.
  // Archery's +2 to ranged attack rolls, Dueling's +2 to melee damage) is not read anywhere
  // in the weapon-attack math, so it used to be silently omitted while the action still
  // came back resolvable — a confident but incomplete to-hit/damage number.
  it('a weapon affected by an unmodeled attack/damage bonus modifier (Fighting Style) lands text-only', () => {
    const stats = [
      { id: 1, value: 16 },
      { id: 2, value: 12 },
    ];
    // Archery (ranged-attacks) affects the ranged weapon only.
    const archer = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Fighter' } }],
      stats,
      modifiers: { class: [{ type: 'bonus', subType: 'ranged-attacks', value: 2 }] },
      inventory: [
        { equipped: true, definition: { name: 'Shortbow', filterType: 'Weapon', attackType: 2, damage: { diceString: '1d6' }, damageType: 'Piercing' } },
        { equipped: true, definition: { name: 'Handaxe', filterType: 'Weapon', attackType: 1, damage: { diceString: '1d6' }, damageType: 'Slashing' } },
      ],
    });
    const bow = archer.actions?.find((a) => a.name === 'Shortbow');
    expect(bow?.spec).toBeUndefined();
    expect(summarizeDdbImport(archer).textOnly).toContain('Shortbow');
    // The melee weapon is unaffected by an Archery-only bonus and stays resolvable.
    const axe = archer.actions?.find((a) => a.name === 'Handaxe');
    expect(axe?.spec).toBeDefined();

    // Dueling (melee-damage) affects the melee weapon only.
    const duelist = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Fighter' } }],
      stats,
      modifiers: { class: [{ type: 'bonus', subType: 'melee-damage', value: 2 }] },
      inventory: [{ equipped: true, definition: { name: 'Longsword', filterType: 'Weapon', attackType: 1, damage: { diceString: '1d8' }, damageType: 'Slashing' } }],
    });
    const sword = duelist.actions?.find((a) => a.name === 'Longsword');
    expect(sword?.spec).toBeUndefined();
    expect(summarizeDdbImport(duelist).textOnly).toContain('Longsword');

    // No such modifier at all -> unaffected, matches the pre-existing resolvable behavior.
    const plain = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Fighter' } }],
      stats,
      inventory: [{ equipped: true, definition: { name: 'Longsword', filterType: 'Weapon', attackType: 1, damage: { diceString: '1d8' }, damageType: 'Slashing' } }],
    });
    expect(plain.actions?.find((a) => a.name === 'Longsword')?.spec).toBeDefined();
  });

  // Regression for a PR #1950 review finding: DDB spell/feature descriptions are HTML, not
  // plain text, and the character sheet renders notes as plain text — so literal tags were
  // showing up on imported characters' sheets.
  it('strips HTML markup from spell and feature descriptions', () => {
    const c = mapDdbCharacter({
      classes: [{ level: 1, definition: { name: 'Wizard' } }],
      classSpells: [
        {
          spells: [
            {
              definition: { name: 'Fire Bolt', level: 0, description: '<p>Hurl a mote of fire at <strong>a creature</strong>.</p>' },
              prepared: true,
            },
          ],
        },
      ],
      actions: {
        feat: [{ name: 'Toughness', description: '<p>You gain 2 extra hit points &amp; more.</p>' }],
      },
    });
    const spell = c.actions?.find((a) => a.name === 'Fire Bolt');
    expect(spell?.notes).not.toMatch(/<[^>]+>/);
    expect(spell?.notes).toContain('Hurl a mote of fire at a creature.');
    const feature = c.actions?.find((a) => a.name === 'Toughness');
    expect(feature?.notes).not.toMatch(/<[^>]+>/);
    expect(feature?.notes).toContain('You gain 2 extra hit points & more.');
  });

  it('tolerates a sparse sheet without throwing', () => {
    const c = mapDdbCharacter({ name: 'Nobody' });
    expect(c.name).toBe('Nobody');
    expect(c.species).toBe('');
    expect(c.className).toBe('');
    expect(c.level).toBe(1);
    expect(c.stats).toEqual({});
    // No armor + no Dex score -> unarmored 10 + 0.
    expect(c.ac).toBe(10);
    expect(c.hpMax).toBe(1);
    expect(c.saveProficiencies).toEqual([]);
    expect(c.skills).toEqual({});
  });

  it('overrideStats and overrideHitPoints win over the computed values', () => {
    const c = mapDdbCharacter({
      name: 'Override',
      stats: [{ id: 1, value: 10 }],
      overrideStats: [{ id: 1, value: 20 }],
      overrideHitPoints: 123,
      classes: [{ level: 4, definition: { name: 'Wizard' } }],
    });
    expect(c.stats?.STR).toBe(20);
    expect(c.hpMax).toBe(123);
    expect(c.className).toBe('Wizard'); // single class, no subclass -> bare class name
    expect(c.level).toBe(4);
  });
});

describe('D&D Beyond character import — endpoint (e2e)', () => {
  let ctx: TestAppContext;
  let fake: FakeDdb;
  let campaignId: number;
  const prevBaseUrl = process.env.DDB_CHARACTER_SERVICE_BASE_URL;

  beforeAll(async () => {
    fake = await startFakeDdb();
    process.env.DDB_CHARACTER_SERVICE_BASE_URL = fake.baseUrl;
    ctx = await createTestApp();
    // Seed the rule packs these tests reference as installed, so campaign-create validation
    // (campaigns.service validateRuleSystem) accepts the slugs. Mirrors campaigns.e2e-spec.ts.
    // 'open5e-srd' is the real 5e pack slug; the gate suite also uses 'pf2e-srd' (incompatible)
    // and 'dnd5e' (the adapter family id, treated as installed here for the accept-case).
    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = new Date().toISOString();
    for (const slug of ['open5e-srd', 'pf2e-srd', 'dnd5e']) {
      await db
        .insert(rulePacks)
        .values({ slug, name: slug, version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 0 })
        .onConflictDoNothing();
    }
    const server = ctx.app.getHttpServer();
    // Issue #714: the import is only valid for an explicitly-D&D-5e campaign. The happy-path
    // tests below therefore create the campaign WITH the 5e SRD pack slug selected, mirroring
    // a real campaign where the DM has installed the Open5e pack. The gate-rejection cases
    // (incompatible / homebrew / malicious) live in their own describe block below.
    const res = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'DDB Import Campaign', ruleSystem: 'open5e-srd' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    await fake.close();
    if (prevBaseUrl === undefined) delete process.env.DDB_CHARACTER_SERVICE_BASE_URL;
    else process.env.DDB_CHARACTER_SERVICE_BASE_URL = prevBaseUrl;
  });

  it('imports a public sheet by ddbId (201) and persists the mapped character', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: String(PUBLIC_DDB_CHARACTER_ID) });
    expect(res.status).toBe(201);
    // Issue #1903: response is { character, summary }.
    const { character, summary } = res.body;
    expect(character.name).toBe('Thornbeard Ironfist');
    expect(character.species).toBe('Hill Dwarf');
    expect(character.className).toBe('Fighter 3 / Rogue 2');
    expect(character.level).toBe(5);
    expect(character.stats).toEqual({ STR: 16, DEX: 12, CON: 16, INT: 10, WIS: 13, CHA: 8 });
    expect(character.ac).toBe(18);
    expect(character.hpMax).toBe(54);
    expect(character.hpCurrent).toBe(47);
    expect(character.ddbId).toBe(String(PUBLIC_DDB_CHARACTER_ID));
    // Owner is the importing player (normal create ownership rules).
    expect(character.ownerUserId).toBe('dev:ddb-owner');
    // Attacks/actions landed on the created character (issue #1903).
    expect(character.actions.some((a: { name: string; spec?: unknown }) => a.name === 'Longsword' && a.spec)).toBe(true);
    expect(character.spellSlots).toEqual({});
    expect(summary.actionsImported).toBeGreaterThanOrEqual(2);
    expect(summary.textOnly).toContain('Second Wind');

    // It's a real persisted character.
    const list = await request(server).get(`/api/v1/campaigns/${campaignId}/characters`).set(player);
    expect(list.body.some((c: { ddbId: string | null }) => c.ddbId === String(PUBLIC_DDB_CHARACTER_ID))).toBe(true);
  });

  it('imports by character URL (id parsed from the link)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({ url: `https://www.dndbeyond.com/characters/${PUBLIC_DDB_CHARACTER_ID}` });
    expect(res.status).toBe(201);
    expect(res.body.character.ddbId).toBe(String(PUBLIC_DDB_CHARACTER_ID));
  });

  it('imports a caster sheet with spells and spell slots (issue #1903)', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: String(CASTER_DDB_CHARACTER_ID) });
    expect(res.status).toBe(201);
    const { character, summary } = res.body;
    expect(character.ddbId).toBe(String(CASTER_DDB_CHARACTER_ID));
    expect(character.spellSlots).toEqual({ '1': { max: 4, used: 0 }, '2': { max: 3, used: 0 }, '3': { max: 2, used: 0 } });
    const spellNames = character.actions.filter((a: { kind: string }) => a.kind === 'spell').map((a: { name: string }) => a.name).sort();
    expect(spellNames).toEqual(['Find Familiar', 'Fire Bolt', 'Magic Missile']);
    expect(summary.spellsImported).toBe(3);
    expect(summary.spellSlotsImported).toBe(true);
  });

  it('private sheet (403) -> clean 400 with a make-it-public hint', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: '777' });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/private/i);
  });

  it('unavailable sheet (200 success:false) -> clean 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: '9999' });
    expect(res.status).toBe(400);
  });

  it('unknown id (404) -> clean 404', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: '424242' });
    expect(res.status).toBe(404);
  });

  it('empty body (neither ddbId nor url) -> 400', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters/import-ddb`)
      .set(player)
      .send({});
    expect(res.status).toBe(400);
  });
});

/**
 * Issue #714 — the import endpoint is the server-side enforcement of the same gate the UI
 * applies. A direct API request (curl, a scripted client, a browser extension bypassing the
 * form) must be rejected with 400 BEFORE any DDB network/parse work happens, so an
 * incompatible campaign can never end up with a character whose numbers belong to a
 * different game. These cases cover the three acceptance categories the issue calls out:
 *
 *   - incompatible: a real non-5e pack is selected (Pathfinder 2e) — different AC/HP/skill
 *     math; importing a 5e-shaped sheet would produce silently wrong numbers.
 *   - homebrew: no pack selected at all (empty `ruleSystem`). Combat still falls back to
 *     the 5e adapter, but that fallback is a default, not a declaration that the campaign
 *     IS 5e — the issue requires an EXPLICITLY compatible D&D pack.
 *   - malicious direct API: the gate must hold even when the request is otherwise perfectly
 *     formed (a valid public id, a logged-in owner). The system mismatch alone is the
 *     rejection reason, and the DDB service is never reached.
 *
 * The fake DDB server is shared with the happy-path suite; these tests assert it is NOT
 * contacted for a rejected campaign by checking the response is the system-gate 400 (not a
 * DDB-derived 400/404), which arrives before the fetch.
 */
describe('D&D Beyond import — system gate (issue #714)', () => {
  let ctx: TestAppContext;
  let fake: FakeDdb;
  const prevBaseUrl = process.env.DDB_CHARACTER_SERVICE_BASE_URL;

  beforeAll(async () => {
    fake = await startFakeDdb();
    process.env.DDB_CHARACTER_SERVICE_BASE_URL = fake.baseUrl;
    ctx = await createTestApp();
    // Seed the same slugs as the happy-path suite (separate app/DB instance).
    const db = ctx.app.get<DrizzleDb>(DB);
    const ts = new Date().toISOString();
    for (const slug of ['open5e-srd', 'pf2e-srd', 'dnd5e']) {
      await db
        .insert(rulePacks)
        .values({ slug, name: slug, version: '1', license: '', sourceUrl: '', installedAt: ts, entryCount: 0 })
        .onConflictDoNothing();
    }
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    await fake.close();
    if (prevBaseUrl === undefined) delete process.env.DDB_CHARACTER_SERVICE_BASE_URL;
    else process.env.DDB_CHARACTER_SERVICE_BASE_URL = prevBaseUrl;
  });

  async function createCampaign(ruleSystem?: string): Promise<number> {
    const server = ctx.app.getHttpServer();
    const body: { name: string; ruleSystem?: string } = { name: `714 Gate Campaign ${Math.random()}` };
    if (ruleSystem !== undefined) body.ruleSystem = ruleSystem;
    const res = await request(server).post('/api/v1/campaigns').set(dm).send(body);
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  it('REJECTS a Pathfinder 2e campaign with 400 before reaching DDB (incompatible system)', async () => {
    // Reset the fake's request counter: any hit after this means the gate leaked.
    fake.resetHitCount();
    const pf2eCampaignId = await createCampaign('pf2e-srd');

    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${pf2eCampaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: String(PUBLIC_DDB_CHARACTER_ID) }); // a valid public id — the system is the only problem

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/5e|D&D Beyond|rule system/i);
    // The gate ran before the fetch, so the fake was never contacted.
    expect(fake.hitCount).toBe(0);
  });

  it('REJECTS a homebrew campaign (no ruleSystem) with 400 — fallback-to-5e is not "explicitly 5e"', async () => {
    fake.resetHitCount();
    const homebrewCampaignId = await createCampaign(); // no ruleSystem -> homebrew

    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${homebrewCampaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: String(PUBLIC_DDB_CHARACTER_ID) });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/5e|D&D Beyond|rule system/i);
    expect(fake.hitCount).toBe(0);
  });

  it('REJECTS a campaign whose ruleSystem slug is unrecognized (e.g. an uninstalled pack)', async () => {
    fake.resetHitCount();
    // The campaigns service refuses to CREATE a campaign with an unknown slug (validateRuleSystem),
    // so the realistic way a campaign ends up with one is: the pack was installed, the campaign
    // selected it, then the pack was uninstalled — leaving a stale slug in the row. Simulate that
    // by creating a homebrew campaign and writing the stale slug straight to the DB.
    const staleCampaignId = await createCampaign(); // homebrew, then stamp a stale slug below
    const db = ctx.app.get<DrizzleDb>(DB);
    const { eq } = await import('drizzle-orm');
    const { campaigns: campaignsTable } = await import('../src/db/schema');
    await db.update(campaignsTable).set({ ruleSystem: 'my-uninstalled-5e-ish' }).where(eq(campaignsTable.id, staleCampaignId));

    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${staleCampaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: String(PUBLIC_DDB_CHARACTER_ID) });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/5e|D&D Beyond|rule system/i);
    expect(fake.hitCount).toBe(0);
  });

  it('malicious direct-API: a perfectly-formed request is still rejected on a non-5e campaign', async () => {
    fake.resetHitCount();
    // Same id the happy path imports successfully — proves the ONLY difference is the system.
    const pf2eCampaignId = await createCampaign('pf2e-srd');

    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${pf2eCampaignId}/characters/import-ddb`)
      .set(player)
      .send({ url: `https://www.dndbeyond.com/characters/${PUBLIC_DDB_CHARACTER_ID}` });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/5e|D&D Beyond|rule system/i);
    expect(fake.hitCount).toBe(0);
  });

  it('ACCEPTS the import on an explicitly-5e campaign (the family id resolves to the 5e adapter)', async () => {
    fake.resetHitCount();
    // 'dnd5e' is the adapter family id; a campaign could store it directly. It must be
    // recognized as explicitly-5e, not rejected as an unknown slug.
    const dnd5eCampaignId = await createCampaign('dnd5e');

    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${dnd5eCampaignId}/characters/import-ddb`)
      .set(player)
      .send({ ddbId: String(PUBLIC_DDB_CHARACTER_ID) });

    expect(res.status).toBe(201);
    expect(res.body.character.ddbId).toBe(String(PUBLIC_DDB_CHARACTER_ID));
    // And in this case the fake WAS contacted — proves the counter is wired correctly and
    // the 0-assertions above aren't passing because the counter is broken.
    expect(fake.hitCount).toBe(1);
  });
});
