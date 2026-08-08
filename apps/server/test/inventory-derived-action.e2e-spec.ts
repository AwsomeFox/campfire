import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { startFakeOpen5e, type FakeOpen5e } from './fake-open5e';

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
