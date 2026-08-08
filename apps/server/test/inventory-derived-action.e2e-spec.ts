import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { eq } from 'drizzle-orm';
import { startFakeOpen5e, type FakeOpen5e } from './fake-open5e';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { inventoryItems, ruleEntries } from '../src/db/schema';

const dm = { 'x-dev-user': 'dm', 'x-dev-role': 'dm' };
const player = { 'x-dev-user': 'player', 'x-dev-role': 'player' };

/**
 * Issue #2097 — the whole point of the feature, asserted end to end: acquire a weapon from
 * the compendium, equip it, and find a usable attack on the encounter card without anyone
 * hand-authoring anything. Before this, that flow produced an "equipped" badge and no action.
 */
describe('derived equipped-item actions (issue #2097)', () => {
  let ctx: TestAppContext;
  let fake: FakeOpen5e;
  let campaignId: number;
  let characterId: number;
  let longswordEntryId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    fake = await startFakeOpen5e();
    const server = ctx.app.getHttpServer();

    const install = await request(server)
      .post('/api/v1/rules/packs/install')
      .set(dm)
      .send({ source: 'open5e', url: fake.baseUrl, sections: ['weapons'] });
    expect([200, 201, 202]).toContain(install.status);
    // Installs are enqueued; wait for the pack to land before acquiring from it.
    for (let i = 0; i < 60; i++) {
      const search = await request(server).get('/api/v1/rules/search').query({ q: 'longsword', type: 'item' }).set(dm);
      const hit = (search.body.items ?? search.body).find?.((e: { name: string }) => e.name === 'Longsword');
      if (hit) {
        longswordEntryId = hit.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(longswordEntryId).toBeDefined();

    // No explicit ruleSystem: an unset one resolves to the 5e adapter (`ruleSystemAdapter`
    // falls back to Dnd5eAdapter), which is the math under test, and it avoids coupling this
    // spec to which packs happen to be installed.
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Derived Actions' });
    campaignId = camp.body.id;
    const char = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Sword Fighter', level: 5, stats: { STR: 16, DEX: 12 } });
    characterId = char.body.id;
  });

  afterAll(async () => {
    await fake.close();
    await closeTestApp(ctx);
  });

  /** The fake server's Longsword, as the #2096 importer stores it. */
  const LONGSWORD_DATA = {
    itemKind: 'weapon',
    damageDice: '1d8',
    damageType: 'Slashing',
    range: 0,
    longRange: 0,
    isSimple: false,
    properties: [{ name: 'Versatile', type: null, detail: '1d10' }],
  };

  /**
   * Rewrite the installed rule entry's data. Several specs need to simulate an upstream
   * change; every one of them restores the fixture afterwards through `restoreLongswordEntry`,
   * so the suite stays order-independent — an earlier version of this file left the entry
   * mutated and quietly changed what later specs were testing.
   */
  function setLongswordEntryData(data: unknown): void {
    const db = ctx.app.get<DrizzleDb>(DB);
    db.update(ruleEntries)
      .set({ dataJson: JSON.stringify(data), updatedAt: new Date().toISOString() })
      .where(eq(ruleEntries.id, longswordEntryId))
      .run();
  }

  function restoreLongswordEntry(): void {
    setLongswordEntryData(LONGSWORD_DATA);
  }

  async function acquireLongsword(): Promise<number> {
    const server = ctx.app.getHttpServer();
    const acquired = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/inventory/from-compendium`)
      .set(dm)
      .send({ ruleEntryId: longswordEntryId, ownerType: 'character', characterId, duplicateMode: 'separate' });
    expect(acquired.status).toBe(201);
    // Acquiring alone grants nothing — an item in a bag is not a weapon in a hand.
    expect(acquired.body.equipped).toBe(false);
    expect(acquired.body.equippedAction).toBeNull();
    expect(acquired.body.equippedActionSource).toBeNull();
    return acquired.body.id as number;
  }

  it('equipping a compendium weapon derives its attack from the wielder', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();

    const equipped = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equipped: true, equipSlot: 'main-hand' });
    expect(equipped.status).toBe(200);
    expect(equipped.body.equippedActionSource).toBe('derived');
    // STR 16 (+3) at level 5 (proficiency +3).
    expect(equipped.body.equippedAction.name).toBe('Longsword');
    expect(equipped.body.equippedAction.toHit).toBe('+6');
    expect(equipped.body.equippedAction.damage).toContain('1d8+3');
    expect(equipped.body.equippedAction.damage).toContain('slashing');
  });

  it('the derived attack reaches the encounter card through the merged action list', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'off-hand' });

    // Creating an encounter auto-adds the campaign's active PCs as combatants.
    const enc = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Derived Fight' });
    expect(enc.status).toBe(201);
    const encounterId = enc.body.id;
    const combatant = enc.body.combatants.find((c: { characterId: number | null }) => c.characterId === characterId);
    expect(combatant).toBeDefined();
    const combatantId = combatant.id;

    const actions = await request(server).get(`/api/v1/encounters/${encounterId}/combatants/${combatantId}/actions`).set(dm);
    expect(actions.status).toBe(200);
    const longsword = actions.body.find((a: { name: string }) => a.name === 'Longsword');
    expect(longsword).toBeDefined();
    // Labelled with the item it came from (issue #1901's "equipped: <item>" tag), so a
    // player can tell a sheet action from one their gear grants.
    expect(longsword.source).toBe('equipped: Longsword');
    expect(longsword.toHit).toBe('+6');
  });

  it('an edit makes the action manual, and re-equipping never regenerates over it', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'edit-slot' });

    const edited = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'Longsword +1', kind: 'melee', toHit: '+7', damage: '1d8+4 slashing', notes: 'Magic.' } });
    expect(edited.status).toBe(200);
    expect(edited.body.equippedActionSource).toBe('manual');

    // The promise that makes the editor safe: unequip/equip must not overwrite the edit.
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: false });
    const reEquipped = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equipped: true, equipSlot: 'edit-slot' });
    expect(reEquipped.status).toBe(200);
    expect(reEquipped.body.equippedActionSource).toBe('manual');
    expect(reEquipped.body.equippedAction.name).toBe('Longsword +1');
    expect(reEquipped.body.equippedAction.toHit).toBe('+7');
  });

  it('clearing the action re-opens the item to derivation on the next equip', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'reset-slot' });
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equippedAction: { name: 'Custom', kind: '', toHit: '+1', damage: '', notes: '' } });

    const cleared = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equippedAction: null, equipped: false });
    expect(cleared.body.equippedAction).toBeNull();
    expect(cleared.body.equippedActionSource).toBeNull();

    const reEquipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'reset-slot' });
    expect(reEquipped.body.equippedActionSource).toBe('derived');
    expect(reEquipped.body.equippedAction.toHit).toBe('+6');
  });

  it('handing an equipped weapon to another character and equipping it derives for the NEW wielder', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'handoff-slot' });

    // A weaker character: STR 8 (-1) at level 1 (proficiency +2) → +1, not the +6 above. The
    // old owner's action is discarded by the ownership-change rule, so there is nothing to
    // overwrite — and the recipient must not be left holding a sword that grants nothing.
    const recipient = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Weak Squire', level: 1, stats: { STR: 8, DEX: 8 } });

    const moved = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ ownerType: 'character', characterId: recipient.body.id, equipped: true, equipSlot: 'handoff-slot' });
    expect(moved.status).toBe(200);
    expect(moved.body.equippedActionSource).toBe('derived');
    expect(moved.body.equippedAction.toHit).toBe('+1');
    expect(moved.body.equippedAction.damage).toContain('1d8-1');
  });

  it('a non-weapon grants nothing, so equipping a bedroll stays silent', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/inventory`)
      .set(dm)
      .send({ name: 'Bedroll', ownerType: 'character', characterId });
    const equipped = await request(server)
      .patch(`/api/v1/inventory/${created.body.id}`)
      .set(dm)
      .send({ equipped: true, equipSlot: 'bedroll-slot' });
    expect(equipped.status).toBe(200);
    expect(equipped.body.equippedAction).toBeNull();
    expect(equipped.body.equippedActionSource).toBeNull();
  });

  // ---- review findings (chatgpt-codex-connector, devin, Copilot) ----

  it('an unrelated PATCH to an already-equipped item never derives an action', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'unrelated-slot' });
    // Deliberately removed — "delete the action, re-equip" is the documented reset flow.
    const removed = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equippedAction: null });
    expect(removed.body.equippedAction).toBeNull();

    // A notes edit and a qty change are not equip transitions. Before the fix, `nextEquipped`
    // fell back to `existing.equipped`, so either of these silently brought the action back —
    // and did it without emitting the invalidation that keeps open encounter cards honest.
    const noted = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ notes: 'just a note' });
    expect(noted.status).toBe(200);
    expect(noted.body.equippedAction).toBeNull();
    expect(noted.body.equippedActionSource).toBeNull();

    const requantified = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ qtyDelta: 1, idempotencyKey: `derive-guard-${itemId}` });
    expect(requantified.status).toBe(200);
    expect(requantified.body.equippedAction).toBeNull();
  });

  it('re-asserting the same equip state still derives, and still says so', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'reassert-slot' });
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equippedAction: null });

    // Identical equip state, so `equipChanged` is false — but the action list DOES change,
    // and the invalidation that keeps open encounter cards honest has to fire anyway.
    const again = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'reassert-slot' });
    expect(again.status).toBe(200);
    expect(again.body.equippedActionSource).toBe('derived');
    expect(again.body.equippedAction.toHit).toBe('+6');
  });

  it('editing the numbers rewrites the spec the resolver actually rolls', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'magic-slot' });
    expect(equipped.body.equippedAction.spec.attack.bonus).toBe('+6');

    // The advertised edit: a +1 weapon. The displayed numbers and the rolled ones must agree —
    // carrying the old spec through would show +7 and keep rolling +6.
    const edited = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'Longsword +1', kind: 'melee', toHit: '+7', damage: '1d8+4 slashing', targetAc: '', notes: '' } });
    expect(edited.status).toBe(200);
    expect(edited.body.equippedAction.spec.attack.bonus).toBe('+7');
    expect(edited.body.equippedAction.spec.outcomes.hit.damage[0]).toMatchObject({ formula: '1d8', flat: 4, type: 'slashing' });
  });

  it('derives from the revision this campaign accepted, not an unaccepted upstream one', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();

    // The installed pack's entry changes upstream. `withCompendiumStates` reports the item as
    // linked_updated without persisting it, and adopting the new revision is what the explicit
    // refresh endpoint is for — so equipping must NOT silently pick it up.
    setLongswordEntryData({ itemKind: 'weapon', damageDice: '4d12', damageType: 'Force', properties: [] });
    try {
      const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'snapshot-slot' });
      expect(equipped.status).toBe(200);
      expect(equipped.body.equippedAction.damage).toContain('1d8+3');
      expect(equipped.body.equippedAction.damage).not.toContain('4d12');
    } finally {
      restoreLongswordEntry();
    }
  });

  it('restoring a trashed item to the party stash clears the provenance with the action', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'trash-slot' });

    // Trash the owning character, then the item, so restore() takes its party fallback.
    const doomed = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Doomed Owner', level: 1, stats: { STR: 10 } });
    await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ ownerType: 'character', characterId: doomed.body.id, equipped: true, equipSlot: 'trash-slot' });
    await request(server).delete(`/api/v1/inventory/${itemId}`).set(dm);
    // Trashing the owner is what makes `restore()` take its party fallback — `validateOwner`
    // no longer resolves the character (same setup as case 5 of the enumerated clearing spec).
    const delChar = await request(server).delete(`/api/v1/characters/${doomed.body.id}`).set(dm);
    expect(delChar.status).toBe(200);

    const restored = await request(server).post(`/api/v1/inventory/${itemId}/restore`).set(dm).send({});
    expect([200, 201]).toContain(restored.status);
    expect(restored.body.ownerType).toBe('party');
    expect(restored.body.equippedAction).toBeNull();
    // redactEquippedActions short-circuits on a null action, so a surviving source would be
    // published campaign-wide as the origin of an action that no longer exists.
    expect(restored.body.equippedActionSource).toBeNull();
  });

  it('a derived action is regenerated when the wielder changes, but a manual one never is', async () => {
    const server = ctx.app.getHttpServer();
    // A character of their own, so levelling them cannot disturb the shared fixture.
    const grower = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Growing Fighter', level: 4, stats: { STR: 16, DEX: 12 } });
    const acquired = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/inventory/from-compendium`)
      .set(dm)
      .send({ ruleEntryId: longswordEntryId, ownerType: 'character', characterId: grower.body.id, duplicateMode: 'separate' });
    const itemId = acquired.body.id;

    // Level 4: STR +3, proficiency +2.
    const first = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'grow-slot' });
    expect(first.body.equippedAction.toHit).toBe('+5');

    // Level 5 crosses a proficiency step, and the derivation is a snapshot of the wielder at
    // the moment it was built — so leaving it alone would keep the character attacking with
    // level-4 numbers forever.
    const levelled = await request(server).patch(`/api/v1/characters/${grower.body.id}`).set(dm).send({ level: 5 });
    expect(levelled.status).toBe(200);
    expect(levelled.body.level).toBe(5);
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: false });
    const regenerated = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'grow-slot' });
    expect(regenerated.body.equippedActionSource).toBe('derived');
    expect(regenerated.body.equippedAction.toHit).toBe('+6');

    // A manual action is still never regenerated — that promise is what the editor rests on.
    await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'My Sword', kind: 'melee', toHit: '+2', damage: '1d8+1 slashing', targetAc: '', notes: '' } });
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: false });
    const afterManual = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'grow-slot' });
    expect(afterManual.body.equippedActionSource).toBe('manual');
    expect(afterManual.body.equippedAction.toHit).toBe('+2');
  });

  it('a regeneration that yields nothing clears the stale derived action', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'stale-slot' });
    expect(equipped.body.equippedAction).not.toBeNull();

    // The accepted snapshot stops identifying this as a weapon. Re-equipping must not leave
    // the item granting an attack built from source data that no longer says so.
    const db = ctx.app.get<DrizzleDb>(DB);
    const snapshot = JSON.parse(
      db.select({ s: inventoryItems.compendiumSnapshot }).from(inventoryItems).where(eq(inventoryItems.id, itemId)).get()!.s!,
    );
    snapshot.dataJson = JSON.stringify({ category: 'Wondrous Item', rarity: 'Uncommon' });
    db.update(inventoryItems)
      .set({ compendiumSnapshot: JSON.stringify(snapshot), ruleEntryId: null })
      .where(eq(inventoryItems.id, itemId))
      .run();

    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: false });
    const reEquipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'stale-slot' });
    expect(reEquipped.status).toBe(200);
    expect(reEquipped.body.equippedAction).toBeNull();
    expect(reEquipped.body.equippedActionSource).toBeNull();
  });

  it('a rename-and-equip in one PATCH derives under the NEW name', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    // Reachable from REST and MCP alike — the row would otherwise carry the new name while
    // granting an action titled with the old one.
    const renamed = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ name: 'Ancestral Blade', equipped: true, equipSlot: 'rename-slot' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Ancestral Blade');
    expect(renamed.body.equippedAction.name).toBe('Ancestral Blade');
  });

  it('accepting a compendium refresh regenerates the derived action immediately', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'refresh-slot' });
    expect(equipped.body.equippedAction.damage).toContain('1d8+3');

    // The pack updates upstream. Equipping still derives from the ACCEPTED snapshot (asserted
    // elsewhere) — but accepting the refresh is exactly the moment the new revision becomes
    // this campaign's truth, so the action must follow without waiting for an unequip cycle.
    setLongswordEntryData({ itemKind: 'weapon', damageDice: '2d6', damageType: 'Slashing', properties: [] });
    try {
      const refreshed = await request(server).post(`/api/v1/inventory/${itemId}/compendium/refresh`).set(dm);
      expect([200, 201]).toContain(refreshed.status);
      expect(refreshed.body.equippedActionSource).toBe('derived');
      expect(refreshed.body.equippedAction.damage).toContain('2d6+3');
    } finally {
      restoreLongswordEntry();
    }
  });

  it('a compendium refresh never regenerates over a manual action', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'refresh-manual-slot' });
    await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'Hand Written', kind: 'melee', toHit: '+9', damage: '1d8+5 slashing', targetAc: '', notes: '' } });

    const refreshed = await request(server).post(`/api/v1/inventory/${itemId}/compendium/refresh`).set(dm);
    expect([200, 201]).toContain(refreshed.status);
    expect(refreshed.body.equippedActionSource).toBe('manual');
    expect(refreshed.body.equippedAction.name).toBe('Hand Written');
    expect(refreshed.body.equippedAction.toHit).toBe('+9');
  });

  it('a refresh regeneration that loses the race writes nothing', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'race-slot' });

    // Stand in for a concurrent writer that authored a manual action between the refresh
    // endpoint reading the row and its regeneration write landing. The predicate on that
    // write requires the row to still be `derived`, so the authored action must survive.
    const db = ctx.app.get<DrizzleDb>(DB);
    setLongswordEntryData({ itemKind: 'weapon', damageDice: '2d6', damageType: 'Slashing', properties: [] });
    try {
      db.update(inventoryItems)
        .set({
          equippedAction: JSON.stringify({ name: 'Raced In', kind: 'melee', toHit: '+9', damage: '1d8+5 slashing', targetAc: '', notes: '' }),
          equippedActionSource: 'manual',
        })
        .where(eq(inventoryItems.id, itemId))
        .run();

      const refreshed = await request(server).post(`/api/v1/inventory/${itemId}/compendium/refresh`).set(dm);
      expect([200, 201]).toContain(refreshed.status);
      expect(refreshed.body.equippedActionSource).toBe('manual');
      expect(refreshed.body.equippedAction.name).toBe('Raced In');
    } finally {
      restoreLongswordEntry();
    }
  });

  it('after a refresh, the persisted action always matches the persisted revision', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'revision-slot' });

    setLongswordEntryData({ itemKind: 'weapon', damageDice: '2d6', damageType: 'Slashing', properties: [] });
    try {
      const refreshed = await request(server).post(`/api/v1/inventory/${itemId}/compendium/refresh`).set(dm);
      expect([200, 201]).toContain(refreshed.status);

      // The invariant the update's snapshot fence exists to hold: the action a row grants is
      // derived from the revision that row actually accepted. Without the fence a racing
      // refresh could leave these two disagreeing — revision B's snapshot beside revision A's
      // mechanics — which no reader could detect from the row itself.
      const persisted = JSON.parse(refreshed.body.compendiumSnapshot.dataJson);
      expect(persisted.damageDice).toBe('2d6');
      expect(refreshed.body.equippedAction.damage).toContain('2d6');
    } finally {
      restoreLongswordEntry();
    }
  });

  it('an unrepresentable attack bonus is rejected as unresolvable, not as a server error', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'bonus-slot' });

    // A REST/MCP caller can send a schema-valid 20-character bonus; it used to reach the
    // statblock expander and throw a ZodError, 500ing the save.
    const saved = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'Huge', kind: 'melee', toHit: '99999999999999999999', damage: '1d8+4 slashing', targetAc: '', notes: '' } });
    expect(saved.status).toBe(200);
    expect(saved.body.equippedActionSource).toBe('manual');
    expect(saved.body.equippedAction.toHit).toBe('99999999999999999999');
    expect(saved.body.equippedAction.spec).toBeUndefined();
  });

  it("honours a homebrew campaign's own mechanics when validating an edited action", async () => {
    const server = ctx.app.getHttpServer();
    // Review (chatgpt-codex-connector P2): resolving the adapter from the `ruleSystem` slug
    // alone fell back to 5e for a homebrew campaign, so its own damage types were rejected as
    // "not in the vocabulary" — a vocabulary that campaign never declared.
    const profile = {
      slug: 'e2e-ichor-hack',
      label: 'E2E Ichor Hack',
      mechanicsSummary: 'A homebrew hack with its own damage vocabulary, for e2e coverage.',
      abilityTable: 'sw-banded',
      abilityCap: 2,
      saves: ['Grit'],
      acMode: 'ascending',
      acAnchor: 10,
      initiativeMode: 'group',
      initiativeDie: 6,
      initiativeUsesDexMod: false,
      tiebreak: 'order-only',
      conditions: ['Soaked'],
    };
    const camp = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Ichor Campaign', ruleSystem: profile.slug, customMechanicsProfile: profile });
    expect(camp.status).toBe(201);
    const char = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/characters`)
      .set(dm)
      .send({ name: 'Ichor Wielder', level: 1, stats: { STR: 12 } });
    const item = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/inventory`)
      .set(dm)
      .send({ name: 'Ichor Lash', ownerType: 'character', characterId: char.body.id });
    await request(server).patch(`/api/v1/inventory/${item.body.id}`).set(dm).send({ equipped: true, equipSlot: 'lash-slot' });

    const authored = await request(server)
      .patch(`/api/v1/inventory/${item.body.id}`)
      .set(dm)
      .send({ equippedAction: { name: 'Lash', kind: 'melee', toHit: '+3', damage: '1d8 ichor', targetAc: '', notes: '' } });
    expect(authored.status).toBe(200);
    // The campaign's adapter declares no damage vocabulary, so there is nothing to reject
    // against and the action stays resolvable.
    expect(authored.body.equippedAction.spec).toBeDefined();
    expect(authored.body.equippedAction.damage).toBe('1d8 ichor');
  });

  it('renaming an equipped item renames the action it grants', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'rename-only-slot' });
    expect(equipped.body.equippedAction.name).toBe('Longsword');

    // A rename alone is not an equip transition, so the derived action used to keep the old
    // name indefinitely while the row and its `equipped: <item>` source label showed the new
    // one. Only a MANUAL action may intentionally carry a name of its own.
    const renamed = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ name: 'Oathkeeper' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Oathkeeper');
    expect(renamed.body.equippedActionSource).toBe('derived');
    expect(renamed.body.equippedAction.name).toBe('Oathkeeper');
  });

  it('renaming an equipped item never renames a MANUAL action', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'rename-manual-slot' });
    await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'Named By Hand', kind: 'melee', toHit: '+6', damage: '1d8+3 slashing', targetAc: '', notes: '' } });

    const renamed = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ name: 'Renamed Again' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Renamed Again');
    expect(renamed.body.equippedActionSource).toBe('manual');
    expect(renamed.body.equippedAction.name).toBe('Named By Hand');
  });

  it('an accepted snapshot with no weapon data derives nothing, even if the live entry has some', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();

    // The item's ACCEPTED snapshot loses its weapon data (as a non-weapon revision would),
    // while the live entry keeps some. Falling through to the live row here would derive from
    // a revision this campaign never accepted — the hole the snapshot-precedence rule closes.
    const db = ctx.app.get<DrizzleDb>(DB);
    const snapshot = JSON.parse(
      db.select({ s: inventoryItems.compendiumSnapshot }).from(inventoryItems).where(eq(inventoryItems.id, itemId)).get()!.s!,
    );
    snapshot.dataJson = null;
    db.update(inventoryItems).set({ compendiumSnapshot: JSON.stringify(snapshot) }).where(eq(inventoryItems.id, itemId)).run();

    const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'nodata-slot' });
    expect(equipped.status).toBe(200);
    expect(equipped.body.equippedAction).toBeNull();
    expect(equipped.body.equippedActionSource).toBeNull();
  });

  it('equipping never activates an action built from a revision the item no longer holds', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'fence-slot' });
    // Unequipped, the item RETAINS its derived action — and a refresh does not regenerate an
    // unequipped item, so this is the state the fence has to survive.
    const unequipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: false });
    expect(unequipped.body.equippedAction).not.toBeNull();

    // Its accepted revision moves on beneath it.
    const db = ctx.app.get<DrizzleDb>(DB);
    const snapshot = JSON.parse(
      db.select({ s: inventoryItems.compendiumSnapshot }).from(inventoryItems).where(eq(inventoryItems.id, itemId)).get()!.s!,
    );
    snapshot.dataJson = JSON.stringify({ itemKind: 'weapon', damageDice: '2d6', damageType: 'Slashing', properties: [] });
    db.update(inventoryItems).set({ compendiumSnapshot: JSON.stringify(snapshot) }).where(eq(inventoryItems.id, itemId)).run();

    // Re-equipping must never leave the OLD revision's mechanics armed against the new
    // snapshot: it derives from the current one.
    const reEquipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'fence-slot' });
    expect(reEquipped.status).toBe(200);
    expect(reEquipped.body.equipped).toBe(true);
    expect(reEquipped.body.equippedAction?.damage ?? '').not.toContain('1d8');
  });

  it("a rename whose owner changed underneath it never lands the old owner's action", async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'owner-race-slot' });

    // Stand in for a concurrent move+equip that landed while a DM rename was mid-derivation:
    // the row is now owned by someone else, with THEIR derived action on it. The rename's
    // pending derivation was computed from the previous owner's stats and carries that
    // owner's private breakdown in its notes — it must not overwrite the new owner's.
    const other = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Race Recipient', level: 1, stats: { STR: 8, DEX: 8 } });
    const db = ctx.app.get<DrizzleDb>(DB);
    db.update(inventoryItems)
      .set({
        characterId: other.body.id,
        equippedAction: JSON.stringify({ name: 'Theirs', kind: 'melee', toHit: '+1', damage: '1d8-1 slashing', targetAc: '', notes: 'their own' }),
        equippedActionSource: 'derived',
      })
      .where(eq(inventoryItems.id, itemId))
      .run();

    const renamed = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ name: 'Renamed Mid-Race' });
    expect(renamed.status).toBe(200);
    // The stale derivation is discarded rather than written over the new owner's row.
    expect(renamed.body.equippedAction?.notes ?? '').not.toContain('STR +3');
  });

  it('a party-stash item can never carry an action — the contract the web editor is gated on', async () => {
    const server = ctx.app.getHttpServer();
    const stashed = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/inventory`)
      .set(dm)
      .send({ name: 'Stashed Blade', ownerType: 'party' });
    const rejected = await request(server)
      .patch(`/api/v1/inventory/${stashed.body.id}`)
      .set(dm)
      .send({ equippedAction: { name: 'Nope', kind: '', toHit: '+1', damage: '', targetAc: '', notes: '' } });
    expect(rejected.status).toBe(400);
  });

  it('a reader who is neither DM nor owner sees neither the derived action nor its provenance', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'secret-slot' });

    await request(server).post(`/api/v1/campaigns/${campaignId}/members`).set(dm).send({ userId: 'player', role: 'player' });
    const asPlayer = await request(server).get(`/api/v1/inventory/${itemId}`).set(player);
    expect(asPlayer.status).toBe(200);
    expect(asPlayer.body.equippedAction).toBeNull();
    // The provenance is withheld with it — 'derived' alone would announce that this
    // character has a granted action, which is the fact being hidden.
    expect(asPlayer.body.equippedActionSource).toBeNull();
  });
});
