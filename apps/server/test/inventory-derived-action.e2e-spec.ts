import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { eq } from 'drizzle-orm';
import { startFakeOpen5e, type FakeOpen5e } from './fake-open5e';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { inventoryItems, ruleEntries } from '../src/db/schema';
import { CampaignEventsService } from '../src/modules/events/campaign-events.service';

const dm = { 'x-dev-user': 'dm', 'x-dev-role': 'dm' };
const player = { 'x-dev-user': 'player', 'x-dev-role': 'player' };

/**
 * Issue #2097 — the whole point of the feature, asserted end to end: acquire a weapon from
 * the compendium, equip it, and find a usable attack on the encounter card without anyone
 * hand-authoring anything. Before this, that flow produced an "equipped" badge and no action.
 *
 * A derived action is COMPUTED ON READ and never stored. That is what most of these specs are
 * really testing: change a wielder's stats, a campaign's rule system, an item's name or its
 * accepted compendium revision, and the granted action follows on the very next read, because
 * there is no saved copy that could be left behind. The column holds human-authored actions
 * only.
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

  async function acquireLongsword(owner: number = characterId): Promise<number> {
    const server = ctx.app.getHttpServer();
    const acquired = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/inventory/from-compendium`)
      .set(dm)
      .send({ ruleEntryId: longswordEntryId, ownerType: 'character', characterId: owner, duplicateMode: 'separate' });
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

  it('the encounter card and the inventory sheet always derive the SAME action', async () => {
    const server = ctx.app.getHttpServer();
    // Two readers, two modules, one computation. Nothing is cached on either side, so this is
    // the property that replaces every "did the stored copy get invalidated?" test the
    // persisted design needed.
    const wielder = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Agreement Test', level: 9, stats: { STR: 18 } });
    const itemId = await acquireLongsword(wielder.body.id);
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'agree-slot' });

    const enc = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Agreement Fight' });
    const combatant = enc.body.combatants.find((c: { characterId: number | null }) => c.characterId === wielder.body.id);
    const actions = await request(server).get(`/api/v1/encounters/${enc.body.id}/combatants/${combatant.id}/actions`).set(dm);
    const fromEncounter = actions.body.find((a: { name: string }) => a.name === 'Longsword');
    const fromInventory = (await request(server).get(`/api/v1/inventory/${itemId}`).set(dm)).body.equippedAction;

    // STR 18 (+4) at level 9 (proficiency +4).
    expect(fromInventory.toHit).toBe('+8');
    expect(fromEncounter.toHit).toBe(fromInventory.toHit);
    expect(fromEncounter.damage).toBe(fromInventory.damage);
  });

  it('an edit makes the action manual, and equipping never regenerates over it', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'edit-slot' });

    const edited = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'Longsword +1', kind: 'melee', toHit: '+7', damage: '1d8+4 slashing', notes: 'Magic.' } });
    expect(edited.status).toBe(200);
    expect(edited.body.equippedActionSource).toBe('manual');

    // The promise that makes the editor safe: an authored action is the one thing that IS
    // stored, so nothing computed can displace it.
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

  it('clearing the edit reverts the item to its derived action', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'reset-slot' });
    await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'Custom', kind: '', toHit: '+1', damage: '', notes: '' } });

    // `equippedAction: null` deletes the OVERRIDE, not the action. An equipped weapon grants
    // an attack because it is an equipped weapon; the only way to say otherwise is to unequip
    // it or to author an action that says otherwise.
    const cleared = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equippedAction: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.equippedActionSource).toBe('derived');
    expect(cleared.body.equippedAction.toHit).toBe('+6');

    const unequipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: false });
    expect(unequipped.body.equippedAction).toBeNull();
    expect(unequipped.body.equippedActionSource).toBeNull();
  });

  it('handing an equipped weapon to another character derives for the NEW wielder', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'handoff-slot' });

    // A weaker character: STR 8 (-1) at level 1 (proficiency +2) → +1, not the +6 above.
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

  it("a move discards the previous owner's authored action", async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'move-manual-slot' });
    await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'My Own Blade', kind: 'melee', toHit: '+7', damage: '1d8+4 slashing', notes: '' } });

    // An authored action is private to the character it was written for — an ownership change
    // disposes of it, and the recipient gets the derivation for their own numbers.
    const recipient = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Inheritor', level: 1, stats: { STR: 10 } });
    const moved = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ ownerType: 'character', characterId: recipient.body.id, equipped: true, equipSlot: 'move-manual-slot' });
    expect(moved.status).toBe(200);
    expect(moved.body.equippedActionSource).toBe('derived');
    expect(moved.body.equippedAction.name).toBe('Longsword');
    expect(moved.body.equippedAction.toHit).toBe('+2');
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

  it('an unequipped weapon grants nothing, however good the compendium data is', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    const fetched = await request(server).get(`/api/v1/inventory/${itemId}`).set(dm);
    expect(fetched.status).toBe(200);
    expect(fetched.body.equippedAction).toBeNull();
    expect(fetched.body.equippedActionSource).toBeNull();
  });

  // ---- the inputs a derived action tracks ----

  it("follows the wielder's own numbers as they change, with no write in between", async () => {
    const server = ctx.app.getHttpServer();
    // A character of their own, so levelling them cannot disturb the shared fixture.
    const grower = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Growing Fighter', level: 1, stats: { STR: 12 } });
    const itemId = await acquireLongsword(grower.body.id);
    const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'grow-slot' });
    // STR 12 (+1), level 1 (proficiency +2).
    expect(equipped.body.equippedAction.toHit).toBe('+3');

    // Nothing touches the item. Under the persisted design this needed an invalidation pass
    // over every equipped item the character owned; now the next read simply computes again.
    const levelled = await request(server)
      .patch(`/api/v1/characters/${grower.body.id}`)
      .set(dm)
      .send({ level: 9, stats: { STR: 18 } });
    expect(levelled.status).toBe(200);

    const after = await request(server).get(`/api/v1/inventory/${itemId}`).set(dm);
    // STR 18 (+4), level 9 (proficiency +4).
    expect(after.body.equippedAction.toHit).toBe('+8');
    expect(after.body.equippedAction.damage).toContain('1d8+4');
  });

  it('an authored action never follows the wielder — that is the point of authoring one', async () => {
    const server = ctx.app.getHttpServer();
    const fixed = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Fixed Fighter', level: 1, stats: { STR: 12 } });
    const itemId = await acquireLongsword(fixed.body.id);
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'fixed-slot' });
    await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'Handmade', kind: 'melee', toHit: '+3', damage: '1d8+1 slashing', notes: '' } });

    await request(server).patch(`/api/v1/characters/${fixed.body.id}`).set(dm).send({ level: 9, stats: { STR: 18 } });
    const after = await request(server).get(`/api/v1/inventory/${itemId}`).set(dm);
    expect(after.body.equippedActionSource).toBe('manual');
    expect(after.body.equippedAction.toHit).toBe('+3');
  });

  it('renaming an equipped item renames the action it grants', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'rename-only-slot' });
    expect(equipped.body.equippedAction.name).toBe('Longsword');

    // A derived action is titled after its item, always — only a MANUAL action may carry a
    // name of its own.
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

  it("changing the campaign's rule system changes what its weapons do", async () => {
    const server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'System Switch' });
    const char = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/characters`)
      .set(dm)
      .send({ name: 'Switcher', level: 5, stats: { STR: 16 } });
    const acquired = await request(server)
      .post(`/api/v1/campaigns/${camp.body.id}/inventory/from-compendium`)
      .set(dm)
      .send({ ruleEntryId: longswordEntryId, ownerType: 'character', characterId: char.body.id, duplicateMode: 'separate' });
    const itemId = acquired.body.id;
    const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'switch-slot' });
    expect(equipped.body.equippedAction.toHit).toBe('+6');

    // The 5e attack math is not another system's. Under the persisted design this needed a
    // campaign-wide sweep clearing every derived action, plus the same sweep over journals and
    // tombstones so an undo could not resurrect the old mechanics. None of that exists now:
    // the action is computed from whatever system the campaign has at the moment it is read.
    // (A bare slug would have to match an installed pack; a homebrew profile IS its own
    // system, which is the switch available to a campaign mid-flight.)
    const profile = {
      slug: 'e2e-switch-hack',
      label: 'E2E Switch Hack',
      mechanicsSummary: 'A homebrew system with its own ability table, for e2e coverage.',
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
    const switched = await request(server)
      .patch(`/api/v1/campaigns/${camp.body.id}`)
      .set(dm)
      .send({ ruleSystem: profile.slug, customMechanicsProfile: profile });
    expect(switched.status).toBe(200);

    const after = await request(server).get(`/api/v1/inventory/${itemId}`).set(dm);
    expect(after.status).toBe(200);
    // Whatever the new system computes, it must not still be showing 5e's answer.
    if (after.body.equippedAction) expect(after.body.equippedAction.toHit).not.toBe('+6');
  });

  it('derives from the revision this campaign accepted, not an unaccepted upstream one', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();

    // The installed pack's entry changes upstream. `withCompendiumStates` reports the item as
    // linked_updated without persisting it, and adopting the new revision is what the explicit
    // refresh endpoint is for — so reading must NOT silently pick it up.
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

  it('accepting a compendium refresh changes the derived action with it', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'refresh-slot' });
    expect(equipped.body.equippedAction.damage).toContain('1d8+3');

    // Accepting the refresh is the moment the new revision becomes this campaign's truth, and
    // the derivation reads the snapshot it just wrote.
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

  it('accepting a refresh announces the change to open encounter screens', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'refresh-tick-slot' });

    // Review (chatgpt-codex-connector P2): read-time derivation removed the invalidation WORK
    // (there is no stored action to regenerate) but not the need to ANNOUNCE — `RunSessionPage`
    // refreshes its merged-action and turn caches only on `character.updated`, so without this
    // an already-open encounter card keeps offering the previous revision's attack and
    // resolving it fails the expected-spec check.
    setLongswordEntryData({ itemKind: 'weapon', damageDice: '2d6', damageType: 'Slashing', properties: [] });
    const events = ctx.app.get(CampaignEventsService);
    const emitted: Array<{ type: string; characterId?: number }> = [];
    const spy = jest.spyOn(events, 'emit').mockImplementation((event) => {
      emitted.push(event as { type: string; characterId?: number });
    });
    try {
      const refreshed = await request(server).post(`/api/v1/inventory/${itemId}/compendium/refresh`).set(dm);
      expect([200, 201]).toContain(refreshed.status);
      expect(refreshed.body.equippedAction.damage).toContain('2d6+3');
      expect(emitted.some((e) => e.type === 'character.updated' && e.characterId === characterId)).toBe(true);
    } finally {
      spy.mockRestore();
      restoreLongswordEntry();
    }
  });

  it('a refresh over a MANUAL action announces nothing — it changed nothing', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'refresh-silent-slot' });
    await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'Untouched', kind: 'melee', toHit: '+7', damage: '1d8+4 slashing', targetAc: '', notes: '' } });

    setLongswordEntryData({ itemKind: 'weapon', damageDice: '2d6', damageType: 'Slashing', properties: [] });
    const events = ctx.app.get(CampaignEventsService);
    const emitted: Array<{ type: string }> = [];
    const spy = jest.spyOn(events, 'emit').mockImplementation((event) => {
      emitted.push(event as { type: string });
    });
    try {
      await request(server).post(`/api/v1/inventory/${itemId}/compendium/refresh`).set(dm);
      // A stored action is returned verbatim whatever the snapshot says, so the merged list
      // is unchanged and there is nothing for an open card to refetch.
      expect(emitted.some((e) => e.type === 'character.updated')).toBe(false);
    } finally {
      spy.mockRestore();
      restoreLongswordEntry();
    }
  });

  it('a refresh never regenerates over a manual action', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'refresh-manual-slot' });
    await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'Kept', kind: 'melee', toHit: '+7', damage: '1d8+4 slashing', targetAc: '', notes: '' } });

    setLongswordEntryData({ itemKind: 'weapon', damageDice: '2d6', damageType: 'Slashing', properties: [] });
    try {
      const refreshed = await request(server).post(`/api/v1/inventory/${itemId}/compendium/refresh`).set(dm);
      expect([200, 201]).toContain(refreshed.status);
      expect(refreshed.body.equippedActionSource).toBe('manual');
      expect(refreshed.body.equippedAction.name).toBe('Kept');
      expect(refreshed.body.equippedAction.damage).toBe('1d8+4 slashing');
    } finally {
      restoreLongswordEntry();
    }
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

  it('an item with no accepted snapshot derives from the live entry, and tracks its content', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();

    // Strip the snapshot so the derivation takes the live rule-entry fallback.
    const db = ctx.app.get<DrizzleDb>(DB);
    db.update(inventoryItems).set({ compendiumSnapshot: null }).where(eq(inventoryItems.id, itemId)).run();

    const first = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'live-entry-slot' });
    expect(first.status).toBe(200);
    expect(first.body.equippedAction.damage).toContain('1d8+3');

    // The entry's content changes; the id does not. The next READ follows the content — the
    // fingerprint that used to guard this could only ever see the id.
    setLongswordEntryData({ itemKind: 'weapon', damageDice: '2d6', damageType: 'Slashing', properties: [] });
    try {
      const second = await request(server).get(`/api/v1/inventory/${itemId}`).set(dm);
      expect(second.status).toBe(200);
      expect(second.body.equippedAction.damage).toContain('2d6+3');
    } finally {
      restoreLongswordEntry();
    }
  });

  // ---- the authored half: what a human writes is stored, validated, and trusted ----

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

  it('an MCP-style round-trip edit rebuilds the spec, not just the display fields', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'roundtrip-slot' });
    const derived = equipped.body.equippedAction;
    expect(derived.spec.attack.bonus).toBe('+6');

    // The web editor strips the spec before sending; a REST/MCP client naturally reads the
    // whole action, edits the numbers, and submits it back WITH its original spec. That used
    // to update the display while combat kept resolving the old numbers.
    const roundTripped = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { ...derived, toHit: '+9', damage: '2d6+5 slashing' } });
    expect(roundTripped.status).toBe(200);
    expect(roundTripped.body.equippedAction.spec.attack.bonus).toBe('+9');
    expect(roundTripped.body.equippedAction.spec.outcomes.hit.damage[0]).toMatchObject({ formula: '2d6', flat: 5 });
  });

  it('a spec carried from a read that a later edit superseded is still rebuilt', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'stale-read-slot' });
    // Client A reads the action here, and holds it.
    const readByA = equipped.body.equippedAction;
    expect(readByA.spec.attack.bonus).toBe('+6');

    // Client B edits in the meantime, so the row's action is no longer the one A read.
    await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'B was here', kind: 'melee', toHit: '+8', damage: '1d10+5 slashing', targetAc: '', notes: '' } });

    // A now submits its edit, still carrying the spec it read before B wrote. Review
    // (chatgpt-codex-connector P1): identifying a round trip by comparing against the row's
    // CURRENT action classified this as deliberately authored, so it stored A's stale +6 spec
    // under A's displayed +9 — the exact defect the rebuild exists to prevent, reached through
    // a race. The check now judges the request against itself and has no such window.
    const fromA = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { ...readByA, toHit: '+9', damage: '2d6+5 slashing' } });
    expect(fromA.status).toBe(200);
    expect(fromA.body.equippedAction.spec.attack.bonus).toBe('+9');
    expect(fromA.body.equippedAction.spec.outcomes.hit.damage[0]).toMatchObject({ formula: '2d6', flat: 5 });
  });

  it('a deliberately authored spec is still trusted, not rebuilt', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    const equipped = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'authored-slot' });

    // A caller that changes the spec ITSELF is expressing intent the five text fields cannot
    // — the MCP path for saves, effects, action economy. Only a carried-along spec is stale.
    const spec = JSON.parse(JSON.stringify(equipped.body.equippedAction.spec));
    spec.attack.bonus = '+11';
    const authored = await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { ...equipped.body.equippedAction, toHit: '+11', spec } });
    expect(authored.status).toBe(200);
    expect(authored.body.equippedAction.spec.attack.bonus).toBe('+11');
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

  // ---- ownership and secrecy ----

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

  it('a compendium weapon in the party stash derives nothing — there is no wielder', async () => {
    const server = ctx.app.getHttpServer();
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'stash-derive-slot' });
    const stashed = await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ ownerType: 'party', characterId: null });
    expect(stashed.status).toBe(200);
    expect(stashed.body.equippedAction).toBeNull();
    expect(stashed.body.equippedActionSource).toBeNull();
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
    const delChar = await request(server).delete(`/api/v1/characters/${doomed.body.id}`).set(dm);
    expect(delChar.status).toBe(200);

    const restored = await request(server).post(`/api/v1/inventory/${itemId}/restore`).set(dm).send({});
    expect([200, 201]).toContain(restored.status);
    expect(restored.body.ownerType).toBe('party');
    expect(restored.body.equippedAction).toBeNull();
    expect(restored.body.equippedActionSource).toBeNull();
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

  it('the owning player sees their own derived action', async () => {
    const server = ctx.app.getHttpServer();
    await request(server).post(`/api/v1/campaigns/${campaignId}/members`).set(dm).send({ userId: 'player', role: 'player' });
    const owned = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Player Blade', level: 5, stats: { STR: 16 }, ownerUserId: 'dev:player' });
    const itemId = await acquireLongsword(owned.body.id);
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'owned-slot' });

    // Redaction runs AFTER derivation, so the owner's own computed action survives it — the
    // failure mode being guarded is the reverse of the case above.
    const asPlayer = await request(server).get(`/api/v1/inventory/${itemId}`).set(player);
    expect(asPlayer.status).toBe(200);
    expect(asPlayer.body.equippedActionSource).toBe('derived');
    expect(asPlayer.body.equippedAction.toHit).toBe('+6');
  });

  it('nothing derived is ever written to the row', async () => {
    const server = ctx.app.getHttpServer();
    // The invariant the whole simplification rests on: if a derived action never reaches
    // storage, no writer anywhere has to invalidate it and no copy of it can go stale.
    const itemId = await acquireLongsword();
    await request(server).patch(`/api/v1/inventory/${itemId}`).set(dm).send({ equipped: true, equipSlot: 'never-stored-slot' });
    const db = ctx.app.get<DrizzleDb>(DB);
    const stored = db.select({ a: inventoryItems.equippedAction }).from(inventoryItems).where(eq(inventoryItems.id, itemId)).get();
    expect(stored?.a).toBeNull();

    // ...and an authored one is, because that is the only thing worth saving.
    await request(server)
      .patch(`/api/v1/inventory/${itemId}`)
      .set(dm)
      .send({ equippedAction: { name: 'Written Down', kind: 'melee', toHit: '+6', damage: '1d8+3 slashing', targetAc: '', notes: '' } });
    const after = db.select({ a: inventoryItems.equippedAction }).from(inventoryItems).where(eq(inventoryItems.id, itemId)).get();
    expect(after?.a).toContain('Written Down');
  });

});
