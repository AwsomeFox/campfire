import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { openDatabase } from '../../src/db/db.module';
import { characters, combatants, encounters, encounterEvents, campaigns, auditLog } from '../../src/db/schema';
import { CharactersService } from '../../src/modules/characters/characters.service';
import { CampaignAccessService } from '../../src/modules/membership/campaign-access.service';
import { RoleResolver } from '../../src/modules/membership/role-resolver.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
// Issue #604: AttachmentsService now delegates responsive derivative generation.
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { Dnd5eAdapter, Pf2eAdapter, resourceVocabularyForAdapter } from '@campfire/schema';
import { makeTempDataDir } from './fixtures';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';

describe('inline spell slots & character resources (issue #422)', () => {
  let dataDir: string;
  let db: any;
  let charactersService: any;
  let encountersService: any;

  beforeEach(() => {
    dataDir = makeTempDataDir();
    const dbModule = openDatabase(dataDir);
    db = dbModule.orm;

    const audit = new AuditService(db);
    const events = new CampaignEventsService();
    // Issue #601: RevisionsService fires the moderation pre-mutation evidence hook
    // on restore, so it takes a real ModerationService. Deliberately not optional —
    // an absent hook would silently stop capturing abuse evidence.
    const revisions = new RevisionsService(db, new ModerationService(db, audit));
    const rolls = new RollsService(db);
    const fsDeletion = new FsDeletionService(db, audit);
    const attachments = new AttachmentsService(db, audit, fsDeletion, new AttachmentDerivativesService(db));
    const campaignLibrary = new CampaignLibraryService(db, audit, events);

    const access = new CampaignAccessService(db, new RoleResolver(db));
    charactersService = new CharactersService(db, audit, revisions, events, rolls, access);
    encountersService = new EncountersService(db, audit, events, rolls, revisions, attachments, campaignLibrary, { notifyCampaign: jest.fn().mockResolvedValue(undefined), notifyUser: jest.fn().mockResolvedValue(undefined) } as any);
  });

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('resolves adapter resource vocabulary and custom character resources', () => {
    const dndVocab = resourceVocabularyForAdapter(Dnd5eAdapter);
    expect(dndVocab.map((r) => r.key)).toContain('rage');
    expect(dndVocab.map((r) => r.key)).toContain('hitDice');

    const pf2eVocab = resourceVocabularyForAdapter(Pf2eAdapter);
    expect(pf2eVocab.map((r) => r.key)).toContain('focusPoints');

    const customChar = {
      resources: {
        sorceryPoints: { max: 5, used: 2, name: 'Sorcery Points', recharge: 'long-rest' },
      },
    };
    const combined = resourceVocabularyForAdapter(Dnd5eAdapter, customChar);
    expect(combined.map((r) => r.key)).toContain('sorceryPoints');
  });

  it('adjusts character resources and enforces bounded used [0, max]', async () => {
    const user = { id: 1, username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Resource Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Ezren',
        ownerUserId: '1',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();

    // Adjust custom resource
    const updated1 = await charactersService.adjustResource(
      c.id,
      { key: 'focusPoints', delta: 1, max: 3, name: 'Focus Points', recharge: 'refocus' },
      user,
      'player',
    );
    expect(updated1.resources['focusPoints'].used).toBe(1);
    expect(updated1.resources['focusPoints'].max).toBe(3);

    // Overspending throws BadRequestException
    await expect(
      charactersService.adjustResource(c.id, { key: 'focusPoints', delta: 5 }, user, 'player'),
    ).rejects.toThrow(BadRequestException);

    // Over-restoring below 0 throws BadRequestException
    await expect(
      charactersService.adjustResource(c.id, { key: 'focusPoints', delta: -5 }, user, 'player'),
    ).rejects.toThrow(BadRequestException);
  });

  /**
   * Issue #1902 rework, fourth review pass — `source` is a real `ResourcePatch`/
   * `CharacterResource` field (provenance: "granted by the Boots of Speed", "Feat: Alert",
   * etc.), but `adjustResource` used to rebuild `resources[patch.key]` from only
   * max/used/name/recharge, silently dropping it on the very first `used`-only pip write
   * even though the caller never asked to touch `source` at all.
   */
  it('#1902 preserves a resource\'s existing source metadata across a used-only write', async () => {
    const user = { id: 1, username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Source Metadata Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Lini',
        ownerUserId: '1',
        resources: JSON.stringify({
          luckyCharm: { max: 1, used: 0, name: 'Lucky Charm', recharge: 'long-rest', source: 'Boots of Speed' },
        }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();

    // A plain pip click: only `used` changes. `source` is not mentioned in the patch at
    // all — the caller has no way to even express "keep it", it must survive on its own.
    const afterPip = await charactersService.adjustResource(c.id, { key: 'luckyCharm', used: 1 }, user, 'player');
    expect(afterPip.resources['luckyCharm'].used).toBe(1);
    expect(afterPip.resources['luckyCharm'].source).toBe('Boots of Speed');
    expect(afterPip.resources['luckyCharm'].name).toBe('Lucky Charm');
    expect(afterPip.resources['luckyCharm'].recharge).toBe('long-rest');

    // A patch that explicitly sets `source` DOES update it — `source` is a real write
    // field on ResourcePatch, not something the server should refuse to ever change.
    const afterRename = await charactersService.adjustResource(c.id, { key: 'luckyCharm', source: 'Ring of Fortune' }, user, 'player');
    expect(afterRename.resources['luckyCharm'].source).toBe('Ring of Fortune');
    // ...and that explicit write didn't clobber the OTHER untouched fields either.
    expect(afterRename.resources['luckyCharm'].used).toBe(1);
  });

  /**
   * Issue #1073 — inspiration / hero points as first-class COUNTED resources.
   *
   * The issue asked for new fields on the character model. They were not needed: #422 already
   * gave characters a bounded `resources` map and gave each adapter a resource vocabulary, so
   * the gap was that NO adapter declared these two. A first-class column would have been a
   * second source of truth for a fact this model already holds.
   */
  it('#1073 declares inspiration for 5e and hero points for PF2e, with their own economies', () => {
    const dnd = resourceVocabularyForAdapter(Dnd5eAdapter);
    const inspiration = dnd.find((r) => r.key === 'inspiration');
    expect(inspiration).toBeDefined();
    // You either have inspiration or you do not — a second award is not a second point.
    expect(inspiration!.defaultMax).toBe(1);
    // NOT a rest cadence: 5e inspiration is DM-awarded and survives rests, so a long-rest
    // recharge would hand it out free every night — the opposite of how it works.
    expect(inspiration!.recharge).toBe('special');

    const pf2e = resourceVocabularyForAdapter(Pf2eAdapter);
    const heroPoints = pf2e.find((r) => r.key === 'heroPoints');
    expect(heroPoints).toBeDefined();
    // A different economy, which is why each system declares its own rather than one being
    // modelled as the other: hero points accrue during a session and spending ALL three is the
    // avoid-death move.
    expect(heroPoints!.defaultMax).toBe(3);
    expect(heroPoints!.recharge).toBe('special');

    // Neither system inherits the other's resource.
    expect(dnd.map((r) => r.key)).not.toContain('heroPoints');
    expect(pf2e.map((r) => r.key)).not.toContain('inspiration');
  });

  it('#1073 a system that declares no resources offers none — silence means "no such resource"', async () => {
    // Six adapters declare no `resources` at all. That must keep meaning "this system has no
    // such pool", never "fall back to 5e's" — an OSR or Open Legend sheet must not sprout
    // inspiration because D&D has it.
    const { OpenLegendAdapter } = await import('@campfire/schema');
    expect(resourceVocabularyForAdapter(OpenLegendAdapter as never)).toEqual([]);
  });

  it('#1073 spending a resource you do not have ERRORS instead of clamping', async () => {
    const user = { id: '1', name: 'Tester' } as any;
    const ts = new Date().toISOString();
    const [camp] = db.insert(campaigns).values({ name: 'Inspiration', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts }).returning().all();
    const [c] = db.insert(characters).values({ campaignId: camp.id, name: 'Aria', ownerUserId: '1', createdAt: ts, updatedAt: ts }).returning().all();

    // Award, then spend: the normal round trip.
    await charactersService.adjustResource(c.id, { key: 'inspiration', max: 1, used: 0, name: 'Inspiration', recharge: 'special' }, user, 'player');
    const spent = await charactersService.adjustResource(c.id, { key: 'inspiration', delta: 1 }, user, 'player');
    expect(spent.resources['inspiration'].used).toBe(1);

    // Spending again must FAIL, not silently clamp at the bound. A clamp would report success
    // for a spend that never happened, and an AI narrating the result would describe a reroll
    // it never paid for (#1039).
    await expect(
      charactersService.adjustResource(c.id, { key: 'inspiration', delta: 1 }, user, 'player'),
    ).rejects.toThrow(BadRequestException);

    // The failed spend left the stored value untouched — no partial write.
    const after = await charactersService.getOrThrow(c.id, user, 'player');
    expect(after.resources['inspiration'].used).toBe(1);
  });

  it('#1073 concurrent spends cannot lose an update', async () => {
    /**
     * The #1039 race, at the service layer ON PURPOSE. Driving this through HTTP would prove
     * nothing: supertest plus synchronous better-sqlite3 serialises requests end to end, so the
     * window between read and write never opens and the test passes whether or not the bug is
     * fixed. Calling the service concurrently is the only way to open it.
     *
     * Before the fix both calls read `used: 0`, both decided `1`, and the second write landed on
     * the first — three hero points spent, one still on the sheet.
     */
    const user = { id: '1', name: 'Tester' } as any;
    const ts = new Date().toISOString();
    const [camp] = db.insert(campaigns).values({ name: 'Hero Points', ruleSystem: 'pf2e', createdAt: ts, updatedAt: ts }).returning().all();
    const [c] = db.insert(characters).values({ campaignId: camp.id, name: 'Kyra', ownerUserId: '1', createdAt: ts, updatedAt: ts }).returning().all();

    await charactersService.adjustResource(c.id, { key: 'heroPoints', max: 3, used: 0, name: 'Hero Points', recharge: 'special' }, user, 'player');

    const results = await Promise.allSettled([
      charactersService.adjustResource(c.id, { key: 'heroPoints', delta: 1 }, user, 'player'),
      charactersService.adjustResource(c.id, { key: 'heroPoints', delta: 1 }, user, 'player'),
      charactersService.adjustResource(c.id, { key: 'heroPoints', delta: 1 }, user, 'player'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);

    // Every spend was paid for: three succeeded, so three are gone. A lost update would show 1 or 2.
    const after = await charactersService.getOrThrow(c.id, user, 'player');
    expect(after.resources['heroPoints'].used).toBe(3);

    // And the pool is now genuinely empty, so a fourth spend errors rather than going negative.
    await expect(
      charactersService.adjustResource(c.id, { key: 'heroPoints', delta: 1 }, user, 'player'),
    ).rejects.toThrow(BadRequestException);
  });

  it('executes short rest, long rest, and refocus cadences', async () => {
    const user = { id: 1, username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Rest Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Valeros',
        ownerUserId: '1',
        spellSlots: JSON.stringify({ '1': { max: 4, used: 3 } }),
        resources: JSON.stringify({
          rage: { max: 3, used: 2, name: 'Rage', recharge: 'long-rest' },
          secondWind: { max: 1, used: 1, name: 'Second Wind', recharge: 'short-rest' },
          focusPoints: { max: 2, used: 2, name: 'Focus Points', recharge: 'refocus' },
        }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();

    // Refocus resets only refocus resources
    const afterRefocus = await charactersService.restCharacter(c.id, 'refocus', user, 'player');
    expect(afterRefocus.resources['focusPoints'].used).toBe(0);
    expect(afterRefocus.resources['rage'].used).toBe(2);

    // Short rest resets short-rest and refocus
    const afterShort = await charactersService.restCharacter(c.id, 'short-rest', user, 'player');
    expect(afterShort.resources['secondWind'].used).toBe(0);
    expect(afterShort.resources['rage'].used).toBe(2);

    // Long rest resets all slots and resources
    const afterLong = await charactersService.restCharacter(c.id, 'long-rest', user, 'player');
    expect(afterLong.spellSlots['1'].used).toBe(0);
    expect(afterLong.resources['rage'].used).toBe(0);
  });

  it('adjusts combatant inline resources during encounter and logs event', async () => {
    const user = { id: 1, username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Combat Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Seelah',
        ownerUserId: '1',
        spellSlots: JSON.stringify({ '1': { max: 2, used: 0 } }),
        resources: JSON.stringify({ layOnHands: { max: 3, used: 0, name: 'Lay on Hands', recharge: 'long-rest' } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();

    const [enc] = db
      .insert(encounters)
      .values({
        campaignId: camp.id,
        name: 'Goblin Ambush',
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();

    const [comb] = db
      .insert(combatants)
      .values({
        encounterId: enc.id,
        kind: 'character',
        characterId: c.id,
        name: 'Seelah',
        sortOrder: 1,
      })
      .returning()
      .all();

    // Inline adjust spell slot
    await encountersService.adjustCombatantResource(enc.id, comb.id, { spellLevel: 1, delta: 1 }, user, 'dm');
    const cAfter1 = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(cAfter1.spellSlots)['1'].used).toBe(1);

    // Inline adjust custom resource
    await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'layOnHands', delta: 1 }, user, 'dm');
    const cAfter2 = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(cAfter2.resources)['layOnHands'].used).toBe(1);

    // Verify encounter events recorded resource_changed
    const events = db.select().from(encounterEvents).where(eq(encounterEvents.encounterId, enc.id)).all();
    expect(events.some((e: any) => e.type === 'resource_changed')).toBe(true);

    // Issue #1909: the audit-every-domain-write invariant — the character branch never
    // called audit.log before this issue. `String(r.actor).startsWith(...)` tolerates
    // `auditActor`'s numeric-id-as-text quirk with this file's `id: 1` fixture (real
    // `RequestUser.id` is always a string) without pinning to that incidental format.
    const rows = db.select().from(auditLog).where(eq(auditLog.entityId, comb.id)).all();
    expect(rows.some((r: any) => r.action === 'encounter.combatant.resource' && String(r.actor).startsWith(String(user.id)))).toBe(true);
  });

  it("issue #1909: a player adjusts their own character combatant; a different player is forbidden", async () => {
    const owner = { id: '1', username: 'owner', displayName: 'Owner', serverRole: 'user' as const };
    const otherPlayer = { id: '2', username: 'other', displayName: 'Other', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Role Matrix Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Ezren',
        ownerUserId: '1',
        resources: JSON.stringify({ arcaneRecovery: { max: 1, used: 0, name: 'Arcane Recovery', recharge: 'long-rest' } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();

    const [enc] = db
      .insert(encounters)
      .values({ campaignId: camp.id, name: 'Role Matrix Fight', status: 'running', createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Ezren', sortOrder: 1 })
      .returning()
      .all();

    // The owning player may adjust their own combatant.
    const updated = await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'arcaneRecovery', delta: 1 }, owner, 'player');
    expect(updated).toBeTruthy();
    const cAfter = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(cAfter.resources)['arcaneRecovery'].used).toBe(1);

    // A different player (not the owner, not the dm) is forbidden.
    await expect(
      encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'arcaneRecovery', delta: 1 }, otherPlayer, 'player'),
    ).rejects.toThrow(ForbiddenException);
  });

  describe('issue #1909: statblock combatants', () => {
    async function seedStatblockEncounter() {
      const user = { id: '1', username: 'dm_user', displayName: 'DM', serverRole: 'user' as const };
      const ts = new Date().toISOString();
      const [camp] = db
        .insert(campaigns)
        .values({ name: 'Statblock Combat Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
        .returning()
        .all();

      const [enc] = db
        .insert(encounters)
        .values({ campaignId: camp.id, name: 'Monster Fight', status: 'running', createdAt: ts, updatedAt: ts })
        .returning()
        .all();

      const [comb] = db
        .insert(combatants)
        .values({
          encounterId: enc.id,
          kind: 'monster',
          characterId: null,
          name: 'Monk Boss',
          sortOrder: 1,
          statblockJson: JSON.stringify({
            resources: { kiPoints: { max: 3, used: 0, name: 'Ki Points', recharge: 'short-rest' } },
            spellSlots: { '2': { max: 2, used: 0 } },
          }),
        })
        .returning()
        .all();

      return { user, camp, enc, comb };
    }

    it("DM adjusts a statblock combatant's feature resource and spell slot by delta, recording a resource_changed event and an audit row", async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      const afterResource = await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm');
      expect(afterResource.statblock.resources['kiPoints'].used).toBe(1);

      const afterSlot = await encountersService.adjustCombatantResource(enc.id, comb.id, { spellLevel: 2, delta: 1 }, user, 'dm');
      expect(afterSlot.statblock.spellSlots['2'].used).toBe(1);

      const events = db.select().from(encounterEvents).where(eq(encounterEvents.encounterId, enc.id)).all();
      expect(events.filter((e: any) => e.type === 'resource_changed').length).toBe(2);

      const rows = db.select().from(auditLog).where(eq(auditLog.entityId, comb.id)).all();
      expect(rows.filter((r: any) => r.action === 'encounter.combatant.resource' && String(r.actor) === '1').length).toBe(2);
    });

    it('a non-DM (player or viewer) may not adjust a statblock combatant — it has no owning player', async () => {
      const { enc, comb } = await seedStatblockEncounter();
      const other = { id: '2', username: 'other_user', displayName: 'Other', serverRole: 'user' as const };

      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, other, 'player'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, other, 'viewer'),
      ).rejects.toThrow(ForbiddenException);

      // Nothing written on the rejected attempts.
      const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
      expect(JSON.parse(row.statblockJson!).resources.kiPoints.used).toBe(0);
    });

    it('two interleaved single-pip writes to two DIFFERENT statblock resources both persist (lost-update regression)', async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      // Simulates two racing writers (a DM tab + an MCP-driven AI DM) each spending a
      // DIFFERENT resource on the SAME statblock combatant. A whole-statblock PATCH built
      // from a stale client snapshot would have let the second writer's PATCH revert the
      // first's change; this delta-based endpoint reads the row fresh inside its own
      // transaction, so both persist regardless of ordering.
      await Promise.all([
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm'),
        encountersService.adjustCombatantResource(enc.id, comb.id, { spellLevel: 2, delta: 1 }, user, 'dm'),
      ]);

      const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
      const statblock = JSON.parse(row.statblockJson!);
      expect(statblock.resources.kiPoints.used).toBe(1);
      expect(statblock.spellSlots['2'].used).toBe(1);
    });

    it('statblock overspend and below-zero restore return typed 400 with nothing written', async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      // Overspend: kiPoints max is 3, already at 0 — restoring (delta -1) would go below 0.
      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: -1 }, user, 'dm'),
      ).rejects.toThrow(BadRequestException);

      // Spend past max: 4 successive +1s on a max-3 pool.
      await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 3 }, user, 'dm');
      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm'),
      ).rejects.toThrow(BadRequestException);

      const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
      // Still exactly 3 (the successful spend), not 4 — the rejected 4th write left nothing behind.
      expect(JSON.parse(row.statblockJson!).resources.kiPoints.used).toBe(3);
    });

    it('a non-character combatant with no inline statblock resources still 400s', async () => {
      const user = { id: '1', username: 'dm_user', displayName: 'DM', serverRole: 'user' as const };
      const ts = new Date().toISOString();
      const [camp] = db
        .insert(campaigns)
        .values({ name: 'No Statblock Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
        .returning()
        .all();
      const [enc] = db
        .insert(encounters)
        .values({ campaignId: camp.id, name: 'HP-only Fight', status: 'running', createdAt: ts, updatedAt: ts })
        .returning()
        .all();
      const [comb] = db
        .insert(combatants)
        .values({ encounterId: enc.id, kind: 'monster', characterId: null, name: 'Plain Goblin', sortOrder: 1 })
        .returning()
        .all();

      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm'),
      ).rejects.toThrow(BadRequestException);
    });

    it('a retried idempotencyKey replays the original outcome instead of double-spending', async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      const first = await encountersService.adjustCombatantResource(
        enc.id,
        comb.id,
        { key: 'kiPoints', delta: 1, idempotencyKey: 'retry-key-1' },
        user,
        'dm',
      );
      expect(first.statblock.resources['kiPoints'].used).toBe(1);

      const replay = await encountersService.adjustCombatantResource(
        enc.id,
        comb.id,
        { key: 'kiPoints', delta: 1, idempotencyKey: 'retry-key-1' },
        user,
        'dm',
      );
      expect(replay.statblock.resources['kiPoints'].used).toBe(1);

      const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
      expect(JSON.parse(row.statblockJson!).resources.kiPoints.used).toBe(1);

      const rows = db.select().from(auditLog).where(eq(auditLog.entityId, comb.id)).all();
      expect(rows.filter((r: any) => r.action === 'encounter.combatant.resource').length).toBe(1);
    });

    // Review finding (Codex): the keyed replay lookup must run BEFORE the fresh-write
    // mutability check, exactly like updateCombatant's own ordering (`if
    // (!patch.idempotencyKey) this.assertMutable(...)` outside, then the transaction-local
    // replay lookup, then `assertMutable` again only on the non-replay path). A retry whose
    // claim already committed while the encounter was still running must replay that stored
    // outcome even if another DM ended the encounter in the meantime — an already-committed
    // result is a safe read, not a fresh write, and the caller retrying a lost response has
    // no way to know the encounter ended since.
    it('a retried idempotencyKey replays its already-committed outcome even after the encounter has since ended', async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      const first = await encountersService.adjustCombatantResource(
        enc.id,
        comb.id,
        { key: 'kiPoints', delta: 1, idempotencyKey: 'retry-key-end-race' },
        user,
        'dm',
      );
      expect(first.statblock.resources['kiPoints'].used).toBe(1);

      // Simulate another DM ending the fight between the original call and this retry —
      // flip status directly rather than running the full end() lifecycle, which is
      // orthogonal to what this test isolates (the idempotency ordering).
      db.update(encounters).set({ status: 'ended' }).where(eq(encounters.id, enc.id)).run();

      const replay = await encountersService.adjustCombatantResource(
        enc.id,
        comb.id,
        { key: 'kiPoints', delta: 1, idempotencyKey: 'retry-key-end-race' },
        user,
        'dm',
      );
      expect(replay.statblock.resources['kiPoints'].used).toBe(1);

      // A genuinely FRESH (unkeyed, or new-key) write against the now-ended encounter is
      // still rejected — only an already-committed replay is exempt.
      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm'),
      ).rejects.toThrow(ConflictException);
    });
  });
});
