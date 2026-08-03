import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { eq } from 'drizzle-orm';
import { CharactersService } from '../src/modules/characters/characters.service';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { characters as charactersTable, combatants, encounters } from '../src/db/schema';
import { HIT_DICE_RESOURCE_KEY } from '@campfire/schema';
import type { RequestUser } from '../src/common/user.types';

/**
 * #1041 — short rest / long rest, end to end.
 *
 * The pure recovery math is pinned in `test/unit/rest-mechanics.spec.ts`. What this suite is
 * for is everything AROUND it that a unit test cannot see: that the write is one transaction
 * over the whole party, that a rejected rest leaves EVERY character untouched, that permission
 * is checked for every named character rather than just the first, and that the reconciled
 * `POST /characters/:id/rest` no longer silently performs a partial rest for `kind: "long"`.
 */

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'rest-dm' };

const dmUser: RequestUser = { id: 'dev:rest-dm', name: 'rest-dm', serverRole: 'user', devRole: 'dm' };

describe('rest mechanics (#1041, e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let characters: CharactersService;
  let db: DrizzleDb;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    characters = ctx.app.get(CharactersService);
    db = ctx.app.get(DB);
    // Campaign create takes a name only; the rule system is set by a follow-up patch.
    const campaign = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Rest Table' });
    expect(campaign.status).toBe(201);
    campaignId = campaign.body.id;
    await request(server).patch(`/api/v1/campaigns/${campaignId}`).set(dm).send({ ruleSystem: 'dnd5e' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  /** Create a battered character with spent slots, spent resources, and conditions. */
  async function batteredCharacter(name: string, over: Record<string, unknown> = {}): Promise<number> {
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({
        name,
        level: 4,
        hpCurrent: 5,
        hpMax: 40,
        stats: { CON: 14 },
        ...over,
      });
    expect(res.status).toBe(201);
    const id = res.body.id as number;
    // Seeded straight through the DB rather than the PATCH route: the update DTO does not
    // accept every column a battered mid-adventure character needs (temp HP, death state, the
    // resource blob), and the point of this suite is what the REST does, not how state got set.
    await db
      .update(charactersTable)
      .set({
        hpTemp: 6,
        conditions: JSON.stringify(['Exhaustion', 'Petrified']),
        spellSlots: JSON.stringify({ '1': { max: 4, used: 4 }, '2': { max: 2, used: 1 } }),
        resources: JSON.stringify({
          [HIT_DICE_RESOURCE_KEY]: { max: 4, used: 4, recharge: 'long-rest' },
          actionSurge: { max: 1, used: 1, recharge: 'short-rest' },
          rage: { max: 3, used: 3, recharge: 'long-rest' },
        }),
      })
      .where(eq(charactersTable.id, id));
    return id;
  }

  it('persists a previewed recovery and replays the same apply key', async () => {
    const id = await batteredCharacter('Preview replay');
    const preview = await characters.previewPartyRecovery(campaignId, { kind: 'long', characterIds: [id] }, dmUser, 'dm');
    expect(preview.failures).toEqual([]);
    const first = await characters.applyPartyRecovery(campaignId, { previewToken: preview.previewToken, idempotencyKey: 'apply-preview-replay', acknowledgeRunningCombatants: true }, dmUser, 'dm');
    const replay = await characters.applyPartyRecovery(campaignId, { previewToken: preview.previewToken, idempotencyKey: 'apply-preview-replay', acknowledgeRunningCombatants: true }, dmUser, 'dm');
    expect(replay).toEqual(first);
    await expect(characters.applyPartyRecovery(campaignId, { previewToken: preview.previewToken, idempotencyKey: 'different-apply-key', acknowledgeRunningCombatants: true }, dmUser, 'dm')).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a stale preview without writing any selected participant', async () => {
    const a = await batteredCharacter('Stale A');
    const b = await batteredCharacter('Stale B');
    const preview = await characters.previewPartyRecovery(campaignId, { kind: 'long', characterIds: [a, b] }, dmUser, 'dm');
    await db.update(charactersTable).set({ hpCurrent: 7, updatedAt: new Date().toISOString() }).where(eq(charactersTable.id, b));
    await expect(characters.applyPartyRecovery(campaignId, { previewToken: preview.previewToken, idempotencyKey: 'stale-party-apply', acknowledgeRunningCombatants: true }, dmUser, 'dm')).rejects.toMatchObject({ status: 409 });
    const [aAfter] = await db.select().from(charactersTable).where(eq(charactersTable.id, a));
    const [bAfter] = await db.select().from(charactersTable).where(eq(charactersTable.id, b));
    expect(aAfter.hpCurrent).toBe(5);
    expect(bAfter.hpCurrent).toBe(7);
  });

  it('requires acknowledgement for a running linked combatant before synchronizing it', async () => {
    const id = await batteredCharacter('Combat rest');
    const now = new Date().toISOString();
    const [encounter] = await db.insert(encounters).values({ campaignId, name: 'Running rest', status: 'running', createdAt: now, updatedAt: now }).returning();
    await db.insert(combatants).values({ encounterId: encounter.id, kind: 'character', characterId: id, name: 'Combat rest', hpCurrent: 5, hpMax: 40 });
    const preview = await characters.previewPartyRecovery(campaignId, { kind: 'long', characterIds: [id] }, dmUser, 'dm');
    expect(preview.runningCombatantCharacterIds).toContain(id);
    await expect(characters.applyPartyRecovery(campaignId, { previewToken: preview.previewToken, idempotencyKey: 'combat-ack-rest', acknowledgeRunningCombatants: false }, dmUser, 'dm')).rejects.toMatchObject({ status: 409 });
    await characters.applyPartyRecovery(campaignId, { previewToken: preview.previewToken, idempotencyKey: 'combat-ack-rest', acknowledgeRunningCombatants: true }, dmUser, 'dm');
    const [combatant] = await db.select().from(combatants).where(eq(combatants.characterId, id));
    expect(combatant.hpCurrent).toBe(40);
  });

  it('#1902: POST /characters/:id/rest mirrors the restored HP into a running combatant immediately — no acknowledgement step, no stale write-back on End', async () => {
    // This is the direct single-character rest endpoint the in-encounter
    // ResourceTrackerPanel calls (issue #1902), as opposed to the DM's bulk
    // preview/apply party-recovery flow exercised by the test above. A PR review
    // (devin-ai-integration) flagged that resting mid-combat "is applied only to the
    // character sheet" and gets silently overwritten when the encounter later ends.
    // That is not what the code does: `CharactersService.rest()` delegates short/long
    // rests to `restParty()`, which calls `syncActiveCombatants()` for every character
    // in the plan straight after the sheet write commits — unconditionally, with no
    // acknowledgement gate (that gate is specific to the bulk party-recovery preview/
    // apply flow above). This test pins that behaviour for the single-character path so
    // a future change cannot silently reintroduce the stale-HP defect the review
    // described.
    const id = await batteredCharacter('Solo combat rest', { hpCurrent: 5, hpMax: 40 });
    const now = new Date().toISOString();
    const [encounter] = await db.insert(encounters).values({ campaignId, name: 'Solo running rest', status: 'running', createdAt: now, updatedAt: now }).returning();
    const [combatant] = await db
      .insert(combatants)
      .values({ encounterId: encounter.id, kind: 'character', characterId: id, name: 'Solo combat rest', hpCurrent: 5, hpMax: 40 })
      .returning();

    const res = await request(server).post(`/api/v1/characters/${id}/rest`).set(dm).send({ type: 'long' });
    expect(res.status).toBe(201);
    expect(res.body.hpCurrent).toBe(40);

    const [mirrored] = await db.select().from(combatants).where(eq(combatants.id, combatant.id));
    expect(mirrored.hpCurrent).toBe(40);

    // Ending the encounter writes the combatant's HP back to the sheet — with the
    // combatant already carrying the rested value, that write-back is a no-op for HP,
    // not a silent revert of the healing the rest just applied.
    const endRes = await request(server).post(`/api/v1/encounters/${encounter.id}/end`).set(dm);
    expect(endRes.status).toBe(201);
    const [afterEnd] = await db.select().from(charactersTable).where(eq(charactersTable.id, id));
    expect(afterEnd.hpCurrent).toBe(40);
  });

  it('replays an undo key and refuses a different key or later sheet edit', async () => {
    const id = await batteredCharacter('Undo replay');
    const preview = await characters.previewPartyRecovery(campaignId, { kind: 'long', characterIds: [id] }, dmUser, 'dm');
    const applied = await characters.applyPartyRecovery(campaignId, { previewToken: preview.previewToken, idempotencyKey: 'undo-apply-key', acknowledgeRunningCombatants: true }, dmUser, 'dm');
    const undo = await characters.undoPartyRecovery(campaignId, applied.batchId, 'undo-replay-key', dmUser, 'dm');
    await expect(characters.undoPartyRecovery(campaignId, applied.batchId, 'undo-replay-key', dmUser, 'dm')).resolves.toEqual(undo);
    await expect(characters.undoPartyRecovery(campaignId, applied.batchId, 'different-undo-key', dmUser, 'dm')).rejects.toMatchObject({ status: 409 });

    const second = await batteredCharacter('Undo changed');
    const secondPreview = await characters.previewPartyRecovery(campaignId, { kind: 'long', characterIds: [second] }, dmUser, 'dm');
    const secondApplied = await characters.applyPartyRecovery(campaignId, { previewToken: secondPreview.previewToken, idempotencyKey: 'undo-changed-apply', acknowledgeRunningCombatants: true }, dmUser, 'dm');
    await db.update(charactersTable).set({ hpCurrent: 17, updatedAt: new Date().toISOString() }).where(eq(charactersTable.id, second));
    await expect(characters.undoPartyRecovery(campaignId, secondApplied.batchId, 'undo-changed-key', dmUser, 'dm')).rejects.toMatchObject({ status: 409 });
    const [after] = await db.select().from(charactersTable).where(eq(charactersTable.id, second));
    expect(after.hpCurrent).toBe(17);
  });

  /** Mark a character dead without going through a route that may not accept the field. */
  async function kill(id: number): Promise<void> {
    await db.update(charactersTable).set({ deathState: 'dead' }).where(eq(charactersTable.id, id));
  }

  function read(id: number) {
    return request(server).get(`/api/v1/characters/${id}`).set(dm);
  }

  it('a long rest restores the whole party in one call', async () => {
    const a = await batteredCharacter('Vesh');
    const b = await batteredCharacter('Bram');

    const result = await characters.restParty(campaignId, 'long', [a, b], {}, dmUser, 'dm');
    expect(result.kind).toBe('long');
    expect(result.characters).toHaveLength(2);

    for (const id of [a, b]) {
      const sheet = (await read(id)).body;
      expect(sheet.hpCurrent).toBe(40);
      expect(sheet.hpTemp).toBe(0);
      expect(sheet.spellSlots['1'].used).toBe(0);
      expect(sheet.spellSlots['2'].used).toBe(0);
      expect(sheet.resources.rage.used).toBe(0);
      expect(sheet.resources.actionSurge.used).toBe(0);
      // 5e returns HALF the hit dice on a long rest: 4 spent → 2 back.
      expect(sheet.resources[HIT_DICE_RESOURCE_KEY].used).toBe(2);
      // Exhaustion ends with a night's sleep; petrification does not.
      expect(sheet.conditions).toEqual(['Petrified']);
    }
  });

  /**
   * Issue #1902 rework, round 7 (codex P2) — `restParty` writes `spellSlots`, the same
   * field `patchSpellSlots`'s `expectedUpdatedAt` compare-and-set guards, but stamped
   * every character in the batch with ONE shared `nowIso()` timestamp. If that shared
   * value happened to equal a character's PRE-rest `updatedAt` (two writes landing in
   * the same millisecond — the identical class of bug fixed for `patchSpellSlots` in an
   * earlier round), the rest would visibly change nothing about the token even though it
   * changed the sheet, and a spell-slot request already in flight with that pre-rest
   * token as `expectedUpdatedAt` would incorrectly pass the CAS check against a sheet the
   * rest had, in fact, just rested. Freezes the clock to reproduce the collision
   * deterministically, matching `spell-slot-concurrency.spec.ts`'s equivalent test for
   * `patchSpellSlots` itself.
   */
  it('#1902 rework: restParty advances each character\'s revision token monotonically, even inside one frozen millisecond', async () => {
    const id = await batteredCharacter('Frozen clock caster');
    const frozen = new Date('2026-01-01T00:00:00.000Z');
    jest.useFakeTimers({ advanceTimers: false });
    jest.setSystemTime(frozen);
    try {
      await db.update(charactersTable).set({ updatedAt: frozen.toISOString() }).where(eq(charactersTable.id, id));
      const [before] = await db.select().from(charactersTable).where(eq(charactersTable.id, id));
      expect(before.updatedAt).toBe(frozen.toISOString());

      await characters.restParty(campaignId, 'long', [id], {}, dmUser, 'dm');
      const [after] = await db.select().from(charactersTable).where(eq(charactersTable.id, id));

      // The defect this guards against: with the old shared `nowIso()` write, `after`'s
      // token would be IDENTICAL to `before`'s — the rest happened (spell slots reset,
      // HP restored), but the CAS token a concurrent request might be holding never
      // visibly moved.
      expect(after.updatedAt).not.toBe(before.updatedAt);
      expect(JSON.parse(after.spellSlots)['1'].used).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports what it did NOT clear, so a DM never has to diff two sheets', async () => {
    const id = await batteredCharacter('Sil');
    const result = await characters.restParty(campaignId, 'long', [id], {}, dmUser, 'dm');
    const entry = result.characters[0];
    expect(entry.conditionsCleared).toEqual(['Exhaustion']);
    expect(entry.conditionsKept).toEqual(['Petrified']);
    expect(entry.logLine).toContain('still Petrified');
  });

  it('#1641: a long rest drops exhaustion by ONE LEVEL, not to zero — and persists the level in conditionInstances', async () => {
    const id = await batteredCharacter('Vael');
    // Seed exhaustion at level 5 via the STRUCTURED column, the way #1073's `stacks` convention
    // actually stores a leveled condition — bare `conditions: ['Exhaustion']` alone (as
    // `batteredCharacter` sets it) carries no level at all.
    await db
      .update(charactersTable)
      .set({
        conditions: JSON.stringify(['Exhaustion']),
        conditionInstances: JSON.stringify([
          {
            id: 'exhaustion-1',
            name: 'Exhaustion',
            ruleEntryId: null,
            source: null,
            sourceCombatantId: null,
            durationRounds: null,
            roundsRemaining: null,
            timing: 'none',
            saveTiming: 'none',
            saveDc: null,
            saveAbility: null,
            isConcentration: false,
            stacks: 5,
            notes: '',
            custom: false,
          },
        ]),
      })
      .where(eq(charactersTable.id, id));

    const result = await characters.restParty(campaignId, 'long', [id], {}, dmUser, 'dm');
    const entry = result.characters[0];
    expect(entry.conditionsCleared).toEqual([]);
    expect(entry.conditionsDecremented).toEqual([{ name: 'Exhaustion', stacksBefore: 5, stacksAfter: 4 }]);
    expect(entry.logLine).toContain('Exhaustion reduced to 4');

    const [row] = await db.select().from(charactersTable).where(eq(charactersTable.id, id));
    expect(JSON.parse(row.conditions!)).toEqual(['Exhaustion']);
    const instances = JSON.parse(row.conditionInstances!);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ name: 'Exhaustion', stacks: 4 });

    // A SECOND long rest continues the countdown rather than re-reading the original level —
    // proves the decremented stacks round-tripped through the write, not just the in-memory plan.
    const again = await characters.restParty(campaignId, 'long', [id], {}, dmUser, 'dm');
    expect(again.characters[0].conditionsDecremented).toEqual([{ name: 'Exhaustion', stacksBefore: 4, stacksAfter: 3 }]);
  });

  it('#759: preview/apply/undo preserves structured condition stacks and linked combatant-only metadata', async () => {
    const id = await batteredCharacter('Structured batch');
    const sheetExhaustion = {
      id: 'sheet-exhaustion', name: 'Exhaustion', ruleEntryId: null, source: 'fatigue', sourceCombatantId: null,
      durationRounds: null, roundsRemaining: null, timing: 'none', saveTiming: 'none', saveDc: null, saveAbility: null,
      isConcentration: false, stacks: 5, notes: 'keep sheet note', custom: false,
    };
    const combatantExhaustion = { ...sheetExhaustion, id: 'combat-exhaustion', source: 'combat-only source', sourceCombatantId: 999, durationRounds: 4, roundsRemaining: 3, timing: 'end-of-turn', saveTiming: 'end-of-turn', saveDc: 14, saveAbility: 'con', notes: 'keep combat note' };
    await db.update(charactersTable).set({ hpTemp: 6, deathSaveSuccesses: 2, deathSaveFailures: 1, conditions: JSON.stringify(['Exhaustion']), conditionInstances: JSON.stringify([sheetExhaustion]) }).where(eq(charactersTable.id, id));
    const now = new Date().toISOString();
    const [encounter] = await db.insert(encounters).values({ campaignId, name: 'Structured recovery', status: 'running', createdAt: now, updatedAt: now }).returning();
    const [combatant] = await db.insert(combatants).values({ encounterId: encounter.id, kind: 'character', characterId: id, name: 'Structured batch', hpCurrent: 5, hpMax: 40, hpTemp: 6, deathSaveSuccesses: 2, deathSaveFailures: 1, conditions: JSON.stringify(['Exhaustion']), conditionInstances: JSON.stringify([combatantExhaustion]) }).returning();

    const preview = await characters.previewPartyRecovery(campaignId, { kind: 'long', characterIds: [id] }, dmUser, 'dm');
    const applied = await characters.applyPartyRecovery(campaignId, { previewToken: preview.previewToken, idempotencyKey: 'structured-batch-apply', acknowledgeRunningCombatants: true }, dmUser, 'dm');
    const [appliedSheet] = await db.select().from(charactersTable).where(eq(charactersTable.id, id));
    const [appliedCombatant] = await db.select().from(combatants).where(eq(combatants.id, combatant.id));
    expect(JSON.parse(appliedSheet.conditions!)).toEqual(['Exhaustion']);
    expect(JSON.parse(appliedSheet.conditionInstances!)[0]).toMatchObject({ name: 'Exhaustion', stacks: 4, notes: 'keep sheet note' });
    expect(JSON.parse(appliedCombatant.conditions!)).toEqual(['Exhaustion']);
    expect(appliedCombatant).toMatchObject({ hpTemp: 0, deathSaveSuccesses: 0, deathSaveFailures: 0 });
    expect(JSON.parse(appliedCombatant.conditionInstances!)[0]).toMatchObject({ name: 'Exhaustion', stacks: 4, id: 'combat-exhaustion', source: 'combat-only source', sourceCombatantId: 999, roundsRemaining: 3, notes: 'keep combat note' });

    await characters.undoPartyRecovery(campaignId, applied.batchId, 'structured-batch-undo', dmUser, 'dm');
    const [undoneSheet] = await db.select().from(charactersTable).where(eq(charactersTable.id, id));
    const [undoneCombatant] = await db.select().from(combatants).where(eq(combatants.id, combatant.id));
    expect(JSON.parse(undoneSheet.conditions!)).toEqual(['Exhaustion']);
    expect(JSON.parse(undoneSheet.conditionInstances!)[0]).toMatchObject({ name: 'Exhaustion', stacks: 5, notes: 'keep sheet note' });
    expect(undoneCombatant).toMatchObject({ hpTemp: 6, deathSaveSuccesses: 2, deathSaveFailures: 1 });
    expect(JSON.parse(undoneCombatant.conditionInstances!)[0]).toMatchObject({ name: 'Exhaustion', stacks: 5, id: 'combat-exhaustion', source: 'combat-only source', sourceCombatantId: 999, roundsRemaining: 3, notes: 'keep combat note' });
  });

  it('a short rest spends hit dice and touches nothing a long rest owns', async () => {
    const id = await batteredCharacter('Kel');
    // The battered fixture has all four hit dice already spent (that is what makes the long-rest
    // half-recovery assertion meaningful); give this one dice to actually spend.
    await db
      .update(charactersTable)
      .set({
        resources: JSON.stringify({
          [HIT_DICE_RESOURCE_KEY]: { max: 4, used: 0, recharge: 'long-rest' },
          actionSurge: { max: 1, used: 1, recharge: 'short-rest' },
          rage: { max: 3, used: 3, recharge: 'long-rest' },
        }),
      })
      .where(eq(charactersTable.id, id));
    const before = (await read(id)).body;
    expect(before.hpCurrent).toBe(5);

    const result = await characters.restParty(
      campaignId,
      'short',
      [id],
      { [id]: { spendHitDice: 2, hitDie: 8 } },
      dmUser,
      'dm',
    );

    const after = (await read(id)).body;
    expect(after.hpCurrent).toBeGreaterThan(5);
    expect(result.characters[0].hitDiceRolls).toHaveLength(2);
    expect(after.resources[HIT_DICE_RESOURCE_KEY].used).toBe(2);
    // Short-rest cadence only.
    expect(after.resources.actionSurge.used).toBe(0);
    expect(after.resources.rage.used).toBe(3);
    expect(after.spellSlots['1'].used).toBe(4);
    // Temp HP survives a short rest; conditions are untouched.
    expect(after.hpTemp).toBe(6);
    expect(after.conditions).toEqual(['Exhaustion', 'Petrified']);
  });

  it('ATOMICITY: one invalid character rejects the rest and leaves EVERY sheet untouched', async () => {
    const healthy = await batteredCharacter('Ana');
    const corpse = await batteredCharacter('Dead Ned');
    await kill(corpse);

    const before = (await read(healthy)).body;

    await expect(characters.restParty(campaignId, 'long', [healthy, corpse], {}, dmUser, 'dm')).rejects.toMatchObject({
      status: 400,
    });

    // This is the property the whole plan-then-apply split exists for: a rest that healed Ana
    // and then rejected Ned would leave the table in a state nobody asked for and no single
    // undo reverses — the same non-atomic mess the tool was added to remove.
    const after = (await read(healthy)).body;
    expect(after.hpCurrent).toBe(before.hpCurrent);
    expect(after.hpTemp).toBe(before.hpTemp);
    expect(after.conditions).toEqual(before.conditions);
    expect(after.spellSlots['1'].used).toBe(4);
    expect(after.resources.rage.used).toBe(3);
  });

  it('reports every failure at once rather than one rejected call at a time', async () => {
    const noDice = await batteredCharacter('Tam');
    const corpse = await batteredCharacter('Dead Mo');
    await kill(corpse);

    await characters
      .restParty(campaignId, 'short', [noDice, corpse], { [noDice]: { spendHitDice: 9, hitDie: 8 } }, dmUser, 'dm')
      .then(
        () => {
          throw new Error('expected the rest to be rejected');
        },
        (err: { response?: { failures?: Array<{ error: string }> } }) => {
          const failures = err.response?.failures ?? [];
          expect(failures.map((f) => f.error).sort()).toEqual(['character_dead', 'insufficient_hit_dice']);
        },
      );
  });

  it('refuses to guess a hit-die size', async () => {
    const id = await batteredCharacter('Gwyn');
    await db
      .update(charactersTable)
      .set({ resources: JSON.stringify({ [HIT_DICE_RESOURCE_KEY]: { max: 4, used: 0, recharge: 'long-rest' } }) })
      .where(eq(charactersTable.id, id));

    await expect(
      characters.restParty(campaignId, 'short', [id], { [id]: { spendHitDice: 1 } }, dmUser, 'dm'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('checks permission for EVERY named character, not just the first', async () => {
    // A player resting "the party" must not quietly rest characters they do not own.
    const mine = await batteredCharacter('Mine', { ownerUserId: 'dev:rest-player' });
    const theirs = await batteredCharacter('Theirs');
    const playerUser: RequestUser = { id: 'dev:rest-player', name: 'rest-player', serverRole: 'user', devRole: 'player' };

    await expect(
      characters.restParty(campaignId, 'long', [mine, theirs], {}, playerUser, 'player'),
    ).rejects.toMatchObject({ status: 403 });

    // ...and nothing was written for the one they DO own.
    expect((await read(mine)).body.hpCurrent).toBe(5);
  });

  it('audits the rest ONCE for the party, not once per character', async () => {
    const a = await batteredCharacter('Audit A');
    const b = await batteredCharacter('Audit B');
    const before = (await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm)).body;
    const beforeCount = (before.items ?? before).filter(
      (e: { action: string }) => e.action === 'character.rest.long',
    ).length;

    await characters.restParty(campaignId, 'long', [a, b], {}, dmUser, 'dm');

    const after = (await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm)).body;
    const entries = (after.items ?? after).filter((e: { action: string }) => e.action === 'character.rest.long');
    expect(entries).toHaveLength(beforeCount + 1);
    const detail = JSON.parse(entries[0].detail);
    expect(detail.characterIds.sort()).toEqual([a, b].sort());
    expect(detail.ruleSystem).toBe('dnd5e');
  });

  it('POST /characters/:id/rest with kind "long" no longer performs a SILENT PARTIAL rest', async () => {
    // Before #1041 this endpoint accepted the word "long" and treated it as the Starfinder
    // night rest: HP healed by LEVEL, and spell slots / resources / conditions ignored
    // entirely. It looked like it worked, which is worse than not existing.
    const id = await batteredCharacter('Endpoint');
    const res = await request(server).post(`/api/v1/characters/${id}/rest`).set(dm).send({ type: 'long' });
    expect(res.status).toBe(201);

    const sheet = (await read(id)).body;
    expect(sheet.hpCurrent).toBe(40); // to FULL, not +level
    expect(sheet.spellSlots['1'].used).toBe(0);
    expect(sheet.resources.rage.used).toBe(0);
    expect(sheet.conditions).toEqual(['Petrified']);
  });

  it('the Starfinder stamina rest keeps its own distinct mechanic', async () => {
    // `stamina` genuinely differs — it SPENDS a Resolve Point — so it is not a worse spelling
    // of a short rest and must not be folded into one.
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Sfer', hpCurrent: 5, hpMax: 40, spCurrent: 0, spMax: 10, rpCurrent: 2, rpMax: 4 });
    const id = res.body.id as number;

    const rest = await request(server).post(`/api/v1/characters/${id}/rest`).set(dm).send({ type: 'stamina' });
    expect(rest.status).toBe(201);
    const sheet = (await read(id)).body;
    expect(sheet.spCurrent).toBe(10);
    expect(sheet.rpCurrent).toBe(1); // a Resolve Point was spent
    expect(sheet.hpCurrent).toBe(5); // stamina rest does not heal HP
  });

  it('exposes both rest tools to the AI driver seat', async () => {
    const { DRIVER_LIVE_PLAY_TOOL_NAMES } = await import('../src/modules/ai-driver/ai-driver.service');
    expect(DRIVER_LIVE_PLAY_TOOL_NAMES).toEqual(expect.arrayContaining(['long_rest', 'short_rest']));
  });

  it('a rest is a no-op for a character with nothing to recover', async () => {
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Fresh', hpCurrent: 30, hpMax: 30 });
    const id = res.body.id as number;
    const result = await characters.restParty(campaignId, 'long', [id], {}, dmUser, 'dm');
    expect(result.characters[0].logLine).toContain('no change');
    expect((await read(id)).body.hpCurrent).toBe(30);
  });

  it('rejects an empty party', async () => {
    await expect(characters.restParty(campaignId, 'long', [], {}, dmUser, 'dm')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a character from another campaign', async () => {
    const other = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Elsewhere' });
    const stranger = await request(server)
      .post(`/api/v1/campaigns/${other.body.id}/characters`)
      .set(dm)
      .send({ name: 'Stranger', hpCurrent: 1, hpMax: 10 });
    await expect(
      characters.restParty(campaignId, 'long', [stranger.body.id], {}, dmUser, 'dm'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('a player may not rest through the MCP-facing path without at least player role', async () => {
    const id = await batteredCharacter('Viewer Target');
    const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'rest-viewer' };
    const res = await request(server).post(`/api/v1/characters/${id}/rest`).set(viewer).send({ type: 'long' });
    expect([403, 404]).toContain(res.status);
  });
});
