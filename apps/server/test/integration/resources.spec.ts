import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { openDatabase } from '../../src/db/db.module';
import { characters, combatants, encounters, encounterEvents, campaigns, auditLog, attachments } from '../../src/db/schema';
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
import * as encounterIdempotency from '../../src/modules/encounters/encounter-idempotency';

describe('inline spell slots & character resources (issue #422)', () => {
  let dataDir: string;
  let db: any;
  let charactersService: any;
  let encountersService: any;
  let events: CampaignEventsService;

  beforeEach(() => {
    dataDir = makeTempDataDir();
    const dbModule = openDatabase(dataDir);
    db = dbModule.orm;

    const audit = new AuditService(db);
    events = new CampaignEventsService();
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

  // Issue #1909 review (Codex): the outer `getCombatantRowOrThrow` runs BEFORE the
  // transaction starts — if the combatant is removed (a real DELETE, not soft) in that
  // window, the character branch must not go on to write the character sheet and log a
  // resource_changed event for a combatant no longer in the encounter using only the
  // stale outer row. Simulate the race by wrapping the outer read so it deletes the
  // combatant, exactly as a concurrent removeCombatant would, right after the outer read
  // resolves but before the transaction below re-reads it.
  it("a combatant removed between the outer read and the transaction aborts the write instead of updating an orphaned character sheet (Codex review)", async () => {
    const user = { id: 1, username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'TOCTOU Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Seelah',
        ownerUserId: '1',
        resources: JSON.stringify({ layOnHands: { max: 3, used: 0, name: 'Lay on Hands', recharge: 'long-rest' } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [enc] = db
      .insert(encounters)
      .values({ campaignId: camp.id, name: 'Goblin Ambush', status: 'active', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Seelah', sortOrder: 1 })
      .returning()
      .all();

    const original = encountersService.getCombatantRowOrThrow.bind(encountersService);
    const spy = jest.spyOn(encountersService, 'getCombatantRowOrThrow').mockImplementation(async (...args: unknown[]) => {
      const result = await original(...(args as [number, number]));
      // Simulate a concurrent removeCombatant landing in the window between this outer
      // read and the transaction below.
      db.delete(combatants).where(eq(combatants.id, comb.id)).run();
      return result;
    });

    try {
      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'layOnHands', delta: 1 }, user, 'dm'),
      ).rejects.toThrow(NotFoundException);

      const cAfter = await charactersService.getRowOrThrow(c.id);
      expect(JSON.parse(cAfter.resources).layOnHands.used).toBe(0);
      const events = db.select().from(encounterEvents).where(eq(encounterEvents.encounterId, enc.id)).all();
      expect(events.some((e: any) => e.type === 'resource_changed')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  // Issue #1909 review (Codex P2): `assertMutable` only covers the ENCOUNTER's own
  // deleted/ended status, not the CAMPAIGN's lifecycle — if the campaign is archived or
  // trashed in the window between the controller/MCP tool's role gate and this
  // transaction, the write must still be rejected. Character branch counterpart to the
  // statblock-branch test in the "issue #1909: statblock combatants" describe block below.
  it("an archived campaign rejects a character resource write, even though the encounter itself is still running (Codex review)", async () => {
    const user = { id: '1', username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db.insert(campaigns).values({ name: 'Archive Race Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts }).returning().all();
    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Seelah',
        ownerUserId: '1',
        resources: JSON.stringify({ layOnHands: { max: 3, used: 0, name: 'Lay on Hands', recharge: 'long-rest' } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [enc] = db
      .insert(encounters)
      .values({ campaignId: camp.id, name: 'Archive Race Fight', status: 'running', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Seelah', sortOrder: 1 })
      .returning()
      .all();

    // Simulates the campaign being archived in the window between the REST/MCP role gate
    // (which runs before this call, outside the service) and this transaction — the
    // encounter itself is untouched (still 'running'), so only a campaign-lifecycle
    // recheck INSIDE the transaction can catch this.
    db.update(campaigns).set({ status: 'archived' }).where(eq(campaigns.id, camp.id)).run();

    await expect(
      encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'layOnHands', delta: 1 }, user, 'dm'),
    ).rejects.toThrow(ForbiddenException);

    const character = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(character.resources)['layOnHands'].used).toBe(0);
  });

  // Issue #1909 review (Codex P2): character-branch counterpart to the statblock-branch
  // stale-click tests below — `delta` encodes an ABSOLUTE pip intent converted to a
  // relative delta against a RENDERED `used`; `expectedUsed` catches a second, now-stale
  // caller before it silently double-applies.
  it('a second stale pip click on the SAME character resource 409s instead of silently double-applying (Codex review)', async () => {
    const user = { id: '1', username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db.insert(campaigns).values({ name: 'Stale Click Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts }).returning().all();
    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Seelah',
        ownerUserId: '1',
        resources: JSON.stringify({ layOnHands: { max: 3, used: 0, name: 'Lay on Hands', recharge: 'long-rest' } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [enc] = db.insert(encounters).values({ campaignId: camp.id, name: 'Stale Click Fight', status: 'running', createdAt: ts, updatedAt: ts }).returning().all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Seelah', sortOrder: 1 })
      .returning()
      .all();

    await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'layOnHands', delta: 1, expectedUsed: 0 }, user, 'dm');
    await expect(
      encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'layOnHands', delta: 1, expectedUsed: 0 }, user, 'dm'),
    ).rejects.toThrow(ConflictException);

    const character = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(character.resources)['layOnHands'].used).toBe(1);
  });

  // Issue #1909 review (Devin, eleventh finding): the character branch had the SAME
  // synthesized-`{max: 1, used: 0, ...}`-on-missing-key fallback as the statblock branch —
  // a typo or a hallucinated AI-driver key would silently fabricate a brand-new max-1
  // resource on the CHARACTER and mark it spent, instead of 400ing the way the spell-slot
  // path already does for an out-of-range level. Proves the unknown key 400s AND that
  // nothing was written to the character's stored resources.
  it("an unknown resource key 400s naming it, instead of silently fabricating a max-1 resource on the character (Devin review)", async () => {
    const user = { id: '1', username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db.insert(campaigns).values({ name: 'Unknown Resource Key Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts }).returning().all();
    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Seelah',
        ownerUserId: '1',
        resources: JSON.stringify({ layOnHands: { max: 3, used: 0, name: 'Lay on Hands', recharge: 'long-rest' } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [enc] = db.insert(encounters).values({ campaignId: camp.id, name: 'Unknown Resource Key Fight', status: 'running', createdAt: ts, updatedAt: ts }).returning().all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Seelah', sortOrder: 1 })
      .returning()
      .all();

    await expect(
      encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'nonexistentResource', delta: 1 }, user, 'dm'),
    ).rejects.toThrow(BadRequestException);

    const character = await charactersService.getRowOrThrow(c.id);
    const resources = JSON.parse(character.resources);
    expect(resources.nonexistentResource).toBeUndefined();
    // The EXISTING resource is untouched too — nothing else was silently modified.
    expect(resources.layOnHands.used).toBe(0);
  });

  // Issue #1909 review (Devin, thirteenth finding): the statblock branch got a malformed-
  // entry guard and its character twin did not — the same one-of-two-symmetric-branches
  // omission as the twelfth finding. `character.resources`/`spellSlots` are read with a bare
  // `fromJsonText` carrying a claimed type and no runtime validation, so a legacy or
  // imported row can hold a non-numeric `used`/`max`. Every NaN comparison is false, so the
  // bounds check passes in BOTH directions and persists `used: NaN` → `null`. These two are
  // the character-branch counterparts to the statblock tests in the describe block below —
  // the asymmetry survived precisely because only one side had coverage.
  async function seedCharacterCombatant(resources: string, spellSlots = '{}') {
    const user = { id: '1', username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db.insert(campaigns).values({ name: 'Malformed Entry Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts }).returning().all();
    const [c] = db
      .insert(characters)
      .values({ campaignId: camp.id, name: 'Seelah', ownerUserId: '1', resources, spellSlots, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [enc] = db.insert(encounters).values({ campaignId: camp.id, name: 'Malformed Fight', status: 'running', createdAt: ts, updatedAt: ts }).returning().all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Seelah', sortOrder: 1 })
      .returning()
      .all();
    return { user, c, enc, comb };
  }

  it("a character resource entry missing `used` 400s naming it, instead of silently persisting used: NaN (Devin review)", async () => {
    const { user, c, enc, comb } = await seedCharacterCombatant(JSON.stringify({ layOnHands: { max: 3, name: 'Lay on Hands' } }));

    await expect(
      encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'layOnHands', delta: 1 }, user, 'dm'),
    ).rejects.toThrow(BadRequestException);

    // The corruption this prevents: `undefined + 1` is NaN, `NaN < 0 || NaN > 3` is false
    // both ways, so pre-fix this resolved and wrote `used: null` to the sheet.
    const character = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(character.resources).layOnHands.used).toBeUndefined();
  });

  it("a character resource entry with a non-numeric `max` 400s instead of silently disabling the upper bound (Devin review)", async () => {
    const { user, c, enc, comb } = await seedCharacterCombatant(JSON.stringify({ layOnHands: { max: 'three', used: 0, name: 'Lay on Hands' } }));

    // Without the guard `nextUsed > 'three'` is false for ANY nextUsed, so a huge overspend
    // silently succeeds instead of 400ing.
    await expect(
      encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'layOnHands', delta: 1000 }, user, 'dm'),
    ).rejects.toThrow(BadRequestException);

    const character = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(character.resources).layOnHands.used).toBe(0);
  });

  it("a character spell-slot entry with a non-numeric `max` 400s, since `'three' <= 0` does not catch it (Devin review)", async () => {
    const { user, c, enc, comb } = await seedCharacterCombatant('{}', JSON.stringify({ '2': { max: 'three', used: 0 } }));

    // The pre-existing `!slot || slot.max <= 0` check is NOT a substitute: a string `max`
    // compares false against 0 and sails straight through to the arithmetic.
    await expect(
      encountersService.adjustCombatantResource(enc.id, comb.id, { spellLevel: 2, delta: 1000 }, user, 'dm'),
    ).rejects.toThrow(BadRequestException);

    const character = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(character.spellSlots)['2'].used).toBe(0);
  });

  // Issue #1909 review (Codex P2): for a character-linked combatant the resource lives on
  // the CHARACTER row, not the combatant — `Combatant` has no resources/spellSlots field at
  // all, so the response cannot show the committed value regardless of freshness. Pins the
  // now-documented contract (see adjustCombatantResource's own doc comment) that a caller
  // wanting the new value must read the character separately, rather than leaving the
  // "Updated combatant" route summary silently over-promising.
  it("the character branch's response never carries the new resource value (it lives on the character, not the combatant) — read the character separately to confirm it", async () => {
    const user = { id: '1', username: 'test_user', displayName: 'Test', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db.insert(campaigns).values({ name: 'Response Contract Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts }).returning().all();
    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Ezren',
        ownerUserId: '1',
        resources: JSON.stringify({ arcaneRecovery: { max: 3, used: 0, name: 'Arcane Recovery', recharge: 'long-rest' } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [enc] = db.insert(encounters).values({ campaignId: camp.id, name: 'Contract Fight', status: 'running', createdAt: ts, updatedAt: ts }).returning().all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Ezren', sortOrder: 1 })
      .returning()
      .all();

    const before = await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'arcaneRecovery', delta: 1 }, user, 'dm');
    const after = await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'arcaneRecovery', delta: 1 }, user, 'dm');
    // The two responses are for two DIFFERENT commits (used 0->1, then 1->2), yet the
    // returned Combatant is identical both times: it never carried resource state to begin
    // with, so there is nothing on it that COULD show which commit this response is for.
    expect(after).toEqual(before);
    expect((after as { statblock: unknown }).statblock).toBeNull();

    // The actual committed value only shows up on a SEPARATE read of the character.
    const character = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(character.resources)['arcaneRecovery'].used).toBe(2);
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

  // Issue #1909 review (Codex P2, secrecy): the outer `isVisibleTo` check runs against the
  // STALE outer `encounter` row, fetched before the transaction. If a DM hides the encounter
  // in the window between that check and the transaction actually running, an owning
  // player's in-flight write must still be refused — not merely that a helper gets called,
  // but that the write is ACTUALLY rejected and nothing is persisted. Simulate the race by
  // wrapping the outer read so it hides the encounter, exactly as a concurrent DM would,
  // right after the outer check passes but before the transaction re-reads it.
  it("a DM hiding the encounter between the outer visibility check and the transaction still refuses the owning player's in-flight write (Codex review)", async () => {
    const owner = { id: '1', username: 'owner', displayName: 'Owner', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Concurrent Hide Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
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
      .values({ campaignId: camp.id, name: 'Concurrent Hide Fight', status: 'running', hidden: false, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Ezren', sortOrder: 1 })
      .returning()
      .all();

    const original = encountersService.getRowOrThrow.bind(encountersService);
    // Typed against the real signature rather than cast to `[number]`. The spread already
    // forwarded `includeDeleted` at runtime, so the old cast was a compile-time lie rather
    // than a behavioral bug — but it read as though the flag were being dropped, which is
    // exactly the ambiguity a deleted-row regression could hide behind.
    const spy = jest.spyOn(encountersService, 'getRowOrThrow').mockImplementation(async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      // Simulate a concurrent DM hiding the encounter in the window between the outer
      // visibility check (which already read this now-stale, non-hidden snapshot) and the
      // transaction below re-reading it fresh.
      db.update(encounters).set({ hidden: true }).where(eq(encounters.id, enc.id)).run();
      return result;
    });

    try {
      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'arcaneRecovery', delta: 1 }, owner, 'player'),
      ).rejects.toThrow(NotFoundException);

      // Nothing was written — the write was genuinely refused, not merely logged.
      const cAfter = await charactersService.getRowOrThrow(c.id);
      expect(JSON.parse(cAfter.resources)['arcaneRecovery'].used).toBe(0);
      const events = db.select().from(encounterEvents).where(eq(encounterEvents.encounterId, enc.id)).all();
      expect(events.some((e: any) => e.type === 'resource_changed')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  // Issue #1990 review (Devin): `updateCombatant` grew the same outer `isVisibleTo` gate
  // as `adjustCombatantResource` but did NOT re-check it against the transaction-local
  // encounter row, so the identical mid-flight hide raced past it. That is exactly the
  // shape the test above pins for the sibling — a guard applied to one of two symmetric
  // paths with coverage only on the covered side. This test pins the other side.
  it("a DM hiding the encounter mid-request still refuses the owning player's in-flight updateCombatant (Devin review)", async () => {
    const owner = { id: '1', username: 'owner', displayName: 'Owner', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Concurrent Hide Update', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [c] = db
      .insert(characters)
      .values({ campaignId: camp.id, name: 'Merisiel', ownerUserId: '1', hpCurrent: 20, hpMax: 20, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [enc] = db
      .insert(encounters)
      .values({ campaignId: camp.id, name: 'Concurrent Hide Update Fight', status: 'running', hidden: false, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Merisiel', hpCurrent: 20, hpMax: 20, sortOrder: 1 })
      .returning()
      .all();

    const original = encountersService.getRowOrThrow.bind(encountersService);
    // Typed against the real signature rather than cast to `[number]`. The spread already
    // forwarded `includeDeleted` at runtime, so the old cast was a compile-time lie rather
    // than a behavioral bug — but it read as though the flag were being dropped, which is
    // exactly the ambiguity a deleted-row regression could hide behind.
    const spy = jest.spyOn(encountersService, 'getRowOrThrow').mockImplementation(async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      db.update(encounters).set({ hidden: true }).where(eq(encounters.id, enc.id)).run();
      return result;
    });

    try {
      await expect(encountersService.updateCombatant(enc.id, comb.id, { hpDelta: -5 }, owner, 'player')).rejects.toThrow(
        NotFoundException,
      );

      // Nothing was written — neither the combatant nor its character-sheet mirror moved,
      // and no combat-log event was emitted for the now-invisible fight.
      const combAfter = db.select().from(combatants).where(eq(combatants.id, comb.id)).all()[0];
      expect(combAfter.hpCurrent).toBe(20);
      const cAfter = await charactersService.getRowOrThrow(c.id);
      expect(cAfter.hpCurrent).toBe(20);
      const events = db.select().from(encounterEvents).where(eq(encounterEvents.encounterId, enc.id)).all();
      expect(events.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  // Issue #1909 review (Devin/Codex secrecy finding): a keyed replay used to return
  // `prior.response` verbatim with no comparison against the CALLER'S CURRENT role — but
  // the stored body was rendered for whatever role committed it, and can embed a DM-only
  // projection (here: a fog-hidden token's EXACT position). If the SAME actor's role has
  // since dropped (a co-DM demoted to player who still happens to own the linked
  // character — the realistic case, since the ownership gate blocks a demoted non-owner
  // from ever reaching replay at all), replaying that body verbatim would leak it.
  it("a keyed replay under a REDUCED role re-derives the response instead of leaking the DM-committed body's fog-hidden token position", async () => {
    const user = { id: '1', username: 'dm_and_owner', displayName: 'DM', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db.insert(campaigns).values({ name: 'Replay Secrecy Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts }).returning().all();
    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Seelah',
        ownerUserId: '1',
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
        name: 'Foggy Ambush',
        status: 'running',
        // Fog revealed only the far corner (60-100, 60-100) — the combatant below sits at
        // (10, 10), squarely in the UNREVEALED area.
        fog: JSON.stringify({ enabled: true, revealed: [{ x: 60, y: 60, w: 40, h: 40 }] }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Seelah', sortOrder: 1, tokenX: 10, tokenY: 10 })
      .returning()
      .all();

    // First commit as 'dm': the fresh-write response is never redacted regardless of role
    // (only a DM, or the character's own owning player, can ever reach this write; a
    // monster/npc-kind statblock write is DM-only outright), so it carries the EXACT
    // token position — this is the DM-only projection a lower-privileged replay must not
    // leak. Stored with responseRole: 'dm'.
    const committed = await encountersService.adjustCombatantResource(
      enc.id, comb.id, { key: 'layOnHands', delta: 1, idempotencyKey: 'replay-secrecy' }, user, 'dm',
    );
    expect(committed.tokenX).toBe(10);
    expect(committed.tokenY).toBe(10);

    // SAME actor, SAME key, but now calling as 'player' — realistic if this DM is demoted
    // to player mid-session but (as set up here) still owns the linked character, so the
    // ownership gate lets them reach the replay lookup at all. Under the pre-fix code this
    // would return the stored dm-role body verbatim (tokenX: 10, unredacted). Fixed: the
    // responseRole ('dm') no longer matches the caller's current role ('player'), so the
    // response is re-derived fresh via getWithCombatantsOrThrow('player'), which redacts
    // the fog-hidden position.
    const replayed = await encountersService.adjustCombatantResource(
      enc.id, comb.id, { key: 'layOnHands', delta: 1, idempotencyKey: 'replay-secrecy' }, user, 'player',
    );
    expect(replayed.tokenX).toBeNull();
    expect(replayed.tokenY).toBeNull();
    expect(replayed.tokenHiddenByFog).toBe(true);

    // The replay did not re-run the effect: still used: 1 (the first commit), not 2.
    const character = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(character.resources)['layOnHands'].used).toBe(1);
  });

  // Issue #1909 review (Devin, tenth finding): the round-7 fix that let a keyed replay
  // survive a TRASHED encounter (the outer `getRowOrThrow(encounterId, true)` plus the
  // early `findPriorEncounterOp` short-circuit) only ever got pinned by a SAME-role replay
  // test. `resolveReplay` has a SECOND exit — the role-MISMATCH fallback, which used to call
  // `getWithCombatantsOrThrow` with its default `includeDeleted: false` — so a role-
  // mismatched replay against a since-trashed encounter 404ed even though the same-role path
  // for the identical scenario succeeded. Commits under one role, trashes the encounter, then
  // replays the SAME key under a DIFFERENT role — the committed outcome must still replay.
  it("a retried idempotencyKey under a DIFFERENT role replays its already-committed outcome even after the encounter has since been trashed (Devin review)", async () => {
    const user = { id: '1', username: 'dm_and_owner', displayName: 'DM', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Mismatched-Role Trashed-Encounter Replay Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Valeros',
        ownerUserId: '1',
        resources: JSON.stringify({ secondWind: { max: 1, used: 0, name: 'Second Wind', recharge: 'short-rest' } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [enc] = db
      .insert(encounters)
      .values({ campaignId: camp.id, name: 'Mismatched-Role Trash Fight', status: 'running', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Valeros', sortOrder: 1 })
      .returning()
      .all();

    // Original commit as 'dm'.
    const first = await encountersService.adjustCombatantResource(
      enc.id, comb.id, { key: 'secondWind', delta: 1, idempotencyKey: 'mismatched-role-trash-replay' }, user, 'dm',
    );
    expect(first).toBeTruthy();

    // Another actor trashes the encounter (soft delete) before the retry.
    db.update(encounters).set({ deletedAt: new Date().toISOString() }).where(eq(encounters.id, enc.id)).run();

    // SAME key, DIFFERENT role ('player') — this must still replay the committed outcome
    // instead of 404ing. Under the pre-fix code, the role mismatch (`dm` !== `player`) sent
    // this through `getWithCombatantsOrThrow(encounterId, role)`'s default
    // `includeDeleted: false`, which itself 404ed on the trashed encounter before the
    // combatant projection was ever built.
    const replayed = await encountersService.adjustCombatantResource(
      enc.id, comb.id, { key: 'secondWind', delta: 1, idempotencyKey: 'mismatched-role-trash-replay' }, user, 'player',
    );
    expect(replayed).toBeTruthy();

    // The replay did not re-run the effect: still used: 1 (the first commit), not 2.
    const character = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(character.resources)['secondWind'].used).toBe(1);
  });

  // Issue #1909 review (Codex, eighth finding): a SAME-role replay is not automatically
  // safe either — the stored body was redacted against the fog state as it stood at the
  // ORIGINAL commit, not as it stands at replay time. If a DM enables fog AFTER the
  // original commit, a later same-role replay must still come back redacted against the
  // CURRENT fog, not the stored (then-unredacted) raw position.
  it("a same-role replay is redacted against CURRENT fog even though the ORIGINAL commit had no fog to redact against (Codex review)", async () => {
    const player = { id: '1', username: 'owner', displayName: 'Owner', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Fog-Enabled-After-Commit Secrecy Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Merisiel',
        ownerUserId: '1',
        resources: JSON.stringify({ sneakAttack: { max: 1, used: 0, name: 'Sneak Attack Die', recharge: 'short-rest' } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    // NO fog at all at the time of the original commit — nothing to redact against yet.
    const [enc] = db
      .insert(encounters)
      .values({ campaignId: camp.id, name: 'No-Fog-Yet Fight', status: 'running', fog: null, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Merisiel', sortOrder: 1, tokenX: 10, tokenY: 10 })
      .returning()
      .all();

    // Original commit: no fog yet, so the (correctly, at the time) unredacted position is
    // stored in the idempotency claim's response body.
    const first = await encountersService.adjustCombatantResource(
      enc.id, comb.id, { key: 'sneakAttack', delta: 1, idempotencyKey: 'fog-enabled-after-commit' }, player, 'player',
    );
    expect(first.tokenX).toBe(10);
    expect(first.tokenY).toBe(10);

    // A DM enables fog AFTER the original commit, concealing the combatant's position.
    db.update(encounters)
      .set({ fog: JSON.stringify({ enabled: true, revealed: [{ x: 60, y: 60, w: 40, h: 40 }] }) })
      .where(eq(encounters.id, enc.id))
      .run();

    // SAME actor, SAME role ('player'), SAME key — a same-role replay must NOT return the
    // stored (now-stale) unredacted body; it must re-derive redaction against the CURRENT
    // fog and come back concealed.
    const replayed = await encountersService.adjustCombatantResource(
      enc.id, comb.id, { key: 'sneakAttack', delta: 1, idempotencyKey: 'fog-enabled-after-commit' }, player, 'player',
    );
    expect(replayed.tokenX).toBeNull();
    expect(replayed.tokenY).toBeNull();
    expect(replayed.tokenHiddenByFog).toBe(true);

    // The replay did not re-run the effect: still used: 1 (the first commit), not 2.
    const character = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(character.resources)['sneakAttack'].used).toBe(1);
  });

  // Issue #1909 review (Codex P1, secrecy): the finding above only ever exercised a ROLE
  // MISMATCH between the committing call and the replay. This test proves the deeper half:
  // a non-DM owning player's OWN fresh write — and a SAME-ROLE replay of it — must never
  // carry the raw fog-hidden position either. A test that only checks a DM's response, or
  // only a cross-role replay, proves nothing about this.
  it("a non-DM owning player's own fresh write, and a SAME-role replay of it, both redact a fog-hidden token position (Codex review)", async () => {
    const player = { id: '1', username: 'owner', displayName: 'Owner', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db.insert(campaigns).values({ name: 'Same-Role Fog Secrecy Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts }).returning().all();
    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Seelah',
        ownerUserId: '1',
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
        name: 'Same-Role Foggy Ambush',
        status: 'running',
        // Fog revealed only the far corner — the combatant below sits at (10, 10), squarely
        // in the UNREVEALED area.
        fog: JSON.stringify({ enabled: true, revealed: [{ x: 60, y: 60, w: 40, h: 40 }] }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Seelah', sortOrder: 1, tokenX: 10, tokenY: 10 })
      .returning()
      .all();

    // The owning player's OWN fresh write (no replay involved at all) must not leak the raw
    // position in its own response.
    const fresh = await encountersService.adjustCombatantResource(
      enc.id, comb.id, { key: 'layOnHands', delta: 1 }, player, 'player',
    );
    expect(fresh.tokenX).toBeNull();
    expect(fresh.tokenY).toBeNull();
    expect(fresh.tokenHiddenByFog).toBe(true);

    // A SAME-role replay (same actor, same key, same 'player' role — no role mismatch at
    // all) of a KEYED write must also come back redacted, proving the STORED claim body
    // itself was redacted at write time, not just re-derived on a role-mismatch fallback.
    const keyed = await encountersService.adjustCombatantResource(
      enc.id, comb.id, { key: 'layOnHands', delta: 1, idempotencyKey: 'same-role-fog-secrecy' }, player, 'player',
    );
    expect(keyed.tokenX).toBeNull();
    expect(keyed.tokenY).toBeNull();
    const replayedSameRole = await encountersService.adjustCombatantResource(
      enc.id, comb.id, { key: 'layOnHands', delta: 1, idempotencyKey: 'same-role-fog-secrecy' }, player, 'player',
    );
    expect(replayedSameRole.tokenX).toBeNull();
    expect(replayedSameRole.tokenY).toBeNull();
    expect(replayedSameRole.tokenHiddenByFog).toBe(true);

    // The replay did not re-run the effect: only the first `keyed` call's delta landed.
    const character = await charactersService.getRowOrThrow(c.id);
    expect(JSON.parse(character.resources)['layOnHands'].used).toBe(2); // fresh (1) + keyed (1)
  });

  // Issue #1909 review (Codex, sixth finding): the fog-redaction fix above only checked
  // THIS encounter's own fog, mirroring `getWithCombatantsOrThrow`'s per-encounter check
  // but omitting its async SIBLING-map check (`isFogProtectedEncounterMap`) — when this
  // encounter's own fog is absent or fully revealed but a SIBLING encounter sharing the
  // same `mapAttachmentId` still conceals it, the shared map's tokens must stay masked
  // here too. Proves both the fresh write's own response AND a same-role keyed replay's
  // STORED body are redacted — not merely that the field is absent for a DM.
  it("a non-DM owning player's write is redacted when a SIBLING encounter sharing the map still conceals it, even though THIS encounter has no concealing fog of its own (Codex review)", async () => {
    const player = { id: '1', username: 'owner', displayName: 'Owner', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'Sibling Fog Secrecy Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [map] = db
      .insert(attachments)
      .values({
        campaignId: camp.id,
        uploaderUserId: '1',
        kind: 'map',
        filename: 'shared-map.png',
        mime: 'image/png',
        size: 1,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [c] = db
      .insert(characters)
      .values({
        campaignId: camp.id,
        name: 'Kyra',
        ownerUserId: '1',
        resources: JSON.stringify({ channelEnergy: { max: 3, used: 0, name: 'Channel Energy', recharge: 'long-rest' } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    // THIS encounter shares the map but has NO concealing fog of its own (null fog).
    const [enc] = db
      .insert(encounters)
      .values({ campaignId: camp.id, name: 'Sibling Fog Fight', status: 'running', mapAttachmentId: map.id, fog: null, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    // The SIBLING encounter shares the same map and STILL conceals pixels via its own fog.
    db.insert(encounters)
      .values({
        campaignId: camp.id,
        name: 'Sibling Fog Fight (protecting sibling)',
        status: 'running',
        mapAttachmentId: map.id,
        fog: JSON.stringify({ enabled: true, revealed: [{ x: 60, y: 60, w: 40, h: 40 }] }),
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Kyra', sortOrder: 1, tokenX: 10, tokenY: 10 })
      .returning()
      .all();

    const fresh = await encountersService.adjustCombatantResource(
      enc.id, comb.id, { key: 'channelEnergy', delta: 1 }, player, 'player',
    );
    expect(fresh.tokenX).toBeNull();
    expect(fresh.tokenY).toBeNull();
    expect(fresh.tokenHiddenByFog).toBe(true);

    // A same-role replay of a KEYED write must ALSO come back redacted, proving the
    // STORED claim body was itself redacted at write time.
    const replayed = await encountersService.adjustCombatantResource(
      enc.id, comb.id, { key: 'channelEnergy', delta: 1, idempotencyKey: 'sibling-fog-secrecy' }, player, 'player',
    );
    expect(replayed.tokenX).toBeNull();
    expect(replayed.tokenY).toBeNull();
    const replayedAgain = await encountersService.adjustCombatantResource(
      enc.id, comb.id, { key: 'channelEnergy', delta: 1, idempotencyKey: 'sibling-fog-secrecy' }, player, 'player',
    );
    expect(replayedAgain.tokenX).toBeNull();
    expect(replayedAgain.tokenY).toBeNull();
    expect(replayedAgain.tokenHiddenByFog).toBe(true);
  });

  // Issue #1909 review (Codex P2, secrecy): the `encounter.updated` SSE nudge used to gate
  // on the OUTER `encounter.hidden` value, read before the write. If another DM hides the
  // encounter in the window between that read and the emit, the id would still reach the
  // shared campaign stream — the exact leak `emitEncounterEvent`'s own re-check exists to
  // close for every OTHER encounter-write path. Proves the actual frame never arrives, not
  // merely that a helper gets called.
  it("hiding the encounter mid-flight suppresses the encounter.updated SSE frame entirely (Codex review)", async () => {
    const owner = { id: '1', username: 'owner', displayName: 'Owner', serverRole: 'user' as const };
    const ts = new Date().toISOString();
    const [camp] = db
      .insert(campaigns)
      .values({ name: 'SSE Mid-Flight Hide Test', ruleSystem: 'dnd5e', createdAt: ts, updatedAt: ts })
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
      .values({ campaignId: camp.id, name: 'SSE Hide Fight', status: 'running', hidden: false, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [comb] = db
      .insert(combatants)
      .values({ encounterId: enc.id, kind: 'character', characterId: c.id, name: 'Ezren', sortOrder: 1 })
      .returning()
      .all();

    const received: Array<{ type: string; encounterId?: number }> = [];
    const sub = events.streamFor(camp.id).subscribe((e) => received.push(e as { type: string; encounterId?: number }));

    // Simulate a concurrent DM hiding the encounter in the window between the outer
    // visibility read and the emit at the end of the write — right after the combatant row
    // is fetched, well before the final `emitEncounterEvent` call.
    const original = encountersService.getCombatantRowOrThrow.bind(encountersService);
    const spy = jest.spyOn(encountersService, 'getCombatantRowOrThrow').mockImplementation(async (...args: unknown[]) => {
      const result = await original(...(args as [number, number]));
      db.update(encounters).set({ hidden: true }).where(eq(encounters.id, enc.id)).run();
      return result;
    });

    try {
      // The DM role sees the hidden encounter throughout (unaffected by the hide), so the
      // write itself still succeeds — this test is about the SSE emission, not the write's
      // own authorization.
      await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'arcaneRecovery', delta: 1 }, owner, 'dm');
    } finally {
      spy.mockRestore();
      sub.unsubscribe();
    }

    expect(received.some((e) => e.type === 'encounter.updated' && e.encounterId === enc.id)).toBe(false);
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

    // Issue #1909 review (Devin, seventh finding): the statblock branch's `encounterEvents`
    // insert used the PRE-TRANSACTION `combatant` snapshot's name/id instead of the
    // in-transaction re-read (`row`, reassigned after the write) — the character branch
    // already uses the fresh re-read for exactly this reason (a name change in the window
    // between the outer read and the transaction must not be lost). Renames the combatant
    // as a side effect of the in-transaction combatant re-read (the same spy technique used
    // for the concurrent-hide and SSE tests above), then asserts the logged actor is the
    // NEW name, not the stale one — the two names are deliberately distinct so the
    // assertion cannot pass by matching either.
    it("renaming a statblock combatant in the window between the outer read and the transaction logs the resource_changed event under the NEW name, not the stale pre-transaction snapshot (Devin review)", async () => {
      const { user, enc, comb } = await seedStatblockEncounter();
      expect(comb.name).toBe('Monk Boss');

      // Simulate the rename landing AFTER the outer `getCombatantRowOrThrow` snapshot is
      // taken but BEFORE the transaction's own fresh re-read — the same spy-side-effect
      // technique used for the concurrent-hide and SSE tests above.
      const original = encountersService.getCombatantRowOrThrow.bind(encountersService);
      const spy = jest.spyOn(encountersService, 'getCombatantRowOrThrow').mockImplementation(async (...args: unknown[]) => {
        const result = await original(...(args as [number, number]));
        db.update(combatants).set({ name: 'Renamed Mid-Flight Boss' }).where(eq(combatants.id, comb.id)).run();
        return result;
      });

      try {
        await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm');
      } finally {
        spy.mockRestore();
      }

      const events = db.select().from(encounterEvents).where(eq(encounterEvents.encounterId, enc.id)).all();
      const resourceEvent = events.find((e: any) => e.type === 'resource_changed');
      expect(resourceEvent?.actor).toBe('Renamed Mid-Flight Boss');
      expect(resourceEvent?.actorId).toBe(comb.id);
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

    // Issue #1909 review (Codex P2): `delta` encodes an ABSOLUTE pip intent converted to a
    // relative delta client-side against a RENDERED `used`. Two callers who both last
    // rendered `used: 0` and both click "set to 1" both send `delta: 1` — the transactional
    // fresh-row read (proven by the test above) does not stop the SECOND delta from
    // applying on top of the FIRST's fresh result, landing on `used: 2` when both callers
    // intended `1`. `expectedUsed` closes this: the second call's stale expectation (0) no
    // longer matches the fresh value (1) that the first call already committed.
    it('a second stale pip click on the SAME statblock resource 409s instead of silently double-applying (Codex review)', async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      // Both "callers" last rendered used: 0 and both click the first pip (used: 0 -> 1),
      // so both compute delta: 1, expectedUsed: 0 — exactly what combatantResourceAdjustBody
      // would send from two tabs open to the same pre-spend state.
      const first = await encountersService.adjustCombatantResource(
        enc.id, comb.id, { key: 'kiPoints', delta: 1, expectedUsed: 0 }, user, 'dm',
      );
      expect(first.statblock.resources.kiPoints.used).toBe(1);

      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1, expectedUsed: 0 }, user, 'dm'),
      ).rejects.toThrow(ConflictException);

      // Still 1 — the stale second click did not land on top of the first's fresh result.
      const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
      expect(JSON.parse(row.statblockJson!).resources.kiPoints.used).toBe(1);
    });

    it('a stale pip click on a statblock spell slot 409s the same way (Codex review)', async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      await encountersService.adjustCombatantResource(enc.id, comb.id, { spellLevel: 2, delta: 1, expectedUsed: 0 }, user, 'dm');
      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { spellLevel: 2, delta: 1, expectedUsed: 0 }, user, 'dm'),
      ).rejects.toThrow(ConflictException);

      const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
      expect(JSON.parse(row.statblockJson!).spellSlots['2'].used).toBe(1);
    });

    it('omitting expectedUsed keeps a purely relative write unguarded, matching the documented opt-in contract (Codex review)', async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      // No expectedUsed at all: an AI DM's "restore 2 charges" intent, no rendered baseline
      // to compare against. Both calls succeed, landing on used: 2 — this is NOT the race
      // the finding describes (that requires a rendered, now-stale, absolute intent).
      await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm');
      const second = await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm');
      expect(second.statblock.resources.kiPoints.used).toBe(2);
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

    // Issue #1909 review (Codex P2): CombatantStatblock.resources/.spellSlots are
    // `z.record(..., z.any())` — no per-entry shape enforcement — so a stored entry can be
    // malformed. Simulates that directly via a raw DB write (bypassing the endpoint, the
    // only way a legacy/corrupt row like this could exist), then exercises the endpoint
    // against it.
    it("a resource entry missing `used` 400s naming the entry, instead of silently persisting used: NaN (Codex review)", async () => {
      const { user, enc, comb } = await seedStatblockEncounter();
      db.update(combatants)
        .set({ statblockJson: JSON.stringify({ resources: { kiPoints: { max: 3 } }, spellSlots: {} }) })
        .where(eq(combatants.id, comb.id))
        .run();

      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm'),
      ).rejects.toThrow(BadRequestException);

      // Nothing written: still the malformed pre-write shape, not `used: NaN` (which would
      // serialize to `used: null`).
      const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
      expect(JSON.parse(row.statblockJson!).resources.kiPoints.used).toBeUndefined();
    });

    it("a resource entry with a non-numeric `max` 400s instead of silently disabling the upper bound (Codex review)", async () => {
      const { user, enc, comb } = await seedStatblockEncounter();
      db.update(combatants)
        .set({ statblockJson: JSON.stringify({ resources: { kiPoints: { used: 0, max: 'three' } }, spellSlots: {} }) })
        .where(eq(combatants.id, comb.id))
        .run();

      // Without the fix, `nextUsed > 'three'` is false for ANY nextUsed, so a huge overspend
      // would silently succeed instead of 400ing.
      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1000 }, user, 'dm'),
      ).rejects.toThrow(BadRequestException);
    });

    // Issue #1909 review (Devin, eleventh finding): `key` used to fall back to a
    // SYNTHESIZED `{max: 1, used: 0, ...}` entry when it didn't already exist on the
    // statblock, silently creating a brand-new resource and marking it spent — a typo or a
    // hallucinated AI-driver key (this PR added `adjust_combatant_resource` to the driver
    // allow-list) would fabricate a resource rather than 400 the way the spell-slot path
    // already does for an out-of-range level. Proves the unknown key 400s AND that nothing
    // was written to the statblock (no new entry fabricated).
    it("an unknown resource key 400s naming it, instead of silently fabricating a max-1 resource (Devin review)", async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'nonexistentResource', delta: 1 }, user, 'dm'),
      ).rejects.toThrow(BadRequestException);

      const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
      expect(JSON.parse(row.statblockJson!).resources.nonexistentResource).toBeUndefined();
      // The EXISTING resource is untouched too — nothing else was silently modified.
      expect(JSON.parse(row.statblockJson!).resources.kiPoints.used).toBe(0);
    });

    // Issue #1909 review (Devin, twelfth finding): the statblock branch's in-transaction
    // re-read answered only ONE of the two questions the character branch answers at
    // `encounters.service.ts:8946-8949`. These two tests are the statblock-branch
    // counterparts to "a combatant removed between the outer read and the transaction…"
    // above, which only ever covered the character branch — which is exactly why the
    // divergence survived.
    it('a statblock combatant removed between the outer read and the transaction 404s, rather than reporting a broken statblock (Devin review)', async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      const original = encountersService.getCombatantRowOrThrow.bind(encountersService);
      const spy = jest.spyOn(encountersService, 'getCombatantRowOrThrow').mockImplementation(async (...args: unknown[]) => {
        const result = await original(...(args as [number, number]));
        // Simulate a co-DM's `removeCombatant` landing in the window between this outer
        // read and the transaction below.
        db.delete(combatants).where(eq(combatants.id, comb.id)).run();
        return result;
      });

      try {
        // The distinction under test: NOT the BadRequestException("no inline statblock
        // resources") this used to throw, which tells the DM their statblock is malformed
        // when the real answer is that the monster is gone.
        await expect(
          encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm'),
        ).rejects.toThrow(NotFoundException);

        const events = db.select().from(encounterEvents).where(eq(encounterEvents.encounterId, enc.id)).all();
        expect(events.some((e: any) => e.type === 'resource_changed')).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('a statblock combatant moved to another encounter mid-request 404s instead of being written unscoped (Devin review)', async () => {
      const { user, enc, comb, camp } = await seedStatblockEncounter();
      const ts = new Date().toISOString();
      const [otherEnc] = db
        .insert(encounters)
        .values({ campaignId: camp.id, name: 'Other Fight', status: 'running', createdAt: ts, updatedAt: ts })
        .returning()
        .all();

      const original = encountersService.getCombatantRowOrThrow.bind(encountersService);
      const spy = jest.spyOn(encountersService, 'getCombatantRowOrThrow').mockImplementation(async (...args: unknown[]) => {
        const result = await original(...(args as [number, number]));
        db.update(combatants).set({ encounterId: otherEnc.id }).where(eq(combatants.id, comb.id)).run();
        return result;
      });

      try {
        // The encounter-scoping half was absent entirely: the row still exists and still has
        // a statblock, so every pre-fix guard passed and the write went through against an
        // encounter the request was never scoped to.
        await expect(
          encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm'),
        ).rejects.toThrow(NotFoundException);

        const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
        expect(JSON.parse(row.statblockJson!).resources.kiPoints.used).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it("a spell-slot entry missing `used` 400s naming the level, instead of silently persisting used: NaN (Codex review)", async () => {
      const { user, enc, comb } = await seedStatblockEncounter();
      db.update(combatants)
        .set({ statblockJson: JSON.stringify({ resources: {}, spellSlots: { '2': { max: 2 } } }) })
        .where(eq(combatants.id, comb.id))
        .run();

      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { spellLevel: 2, delta: 1 }, user, 'dm'),
      ).rejects.toThrow(BadRequestException);

      const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
      expect(JSON.parse(row.statblockJson!).spellSlots['2'].used).toBeUndefined();
    });

    // Issue #1909 review (Devin P2): a genuinely schema-invalid stored statblock (not just a
    // malformed resource/spell-slot entry, which the tests above already cover) must 400,
    // not throw a raw ZodError that escapes as an unhandled 500 — matching every READ path
    // for this column (parseCombatantStatblock), which degrades the same shape to null
    // rather than throwing.
    it("a schema-invalid stored statblock 400s instead of throwing an unhandled 500 (Devin review)", async () => {
      const { user, enc, comb } = await seedStatblockEncounter();
      // abilityScores must be a record of numbers; a string value makes the WHOLE object
      // fail CombatantStatblock's schema, not just one resource entry.
      db.update(combatants)
        .set({
          statblockJson: JSON.stringify({
            abilityScores: { STR: 'not-a-number' },
            resources: { kiPoints: { max: 3, used: 0 } },
            spellSlots: {},
          }),
        })
        .where(eq(combatants.id, comb.id))
        .run();

      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm'),
      ).rejects.toThrow(BadRequestException);
    });

    // Issue #1909 review (Devin P2): the fix must not "fix" the 500 by re-serializing the
    // SCHEMA-DEFAULTED/stripped object back to storage — that would silently normalize every
    // OTHER untouched part of the stored statblock (here: a legacy/unknown top-level field,
    // and AC) on a single pip click. Only the touched resource/spell-slot entry may change.
    it("adjusting one resource does not silently rewrite unrelated stored statblock fields (Devin review)", async () => {
      const { user, enc, comb } = await seedStatblockEncounter();
      db.update(combatants)
        .set({
          statblockJson: JSON.stringify({
            ac: 17,
            legacyUnknownField: 'preserve-me',
            resources: { kiPoints: { max: 3, used: 0, name: 'Ki Points', recharge: 'short-rest' } },
            spellSlots: { '2': { max: 2, used: 0 } },
          }),
        })
        .where(eq(combatants.id, comb.id))
        .run();

      await encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm');

      const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
      const stored = JSON.parse(row.statblockJson!);
      expect(stored.resources.kiPoints.used).toBe(1);
      // Untouched fields survive byte-for-byte, including one z.object()'s default
      // strip-unknown-keys behavior would otherwise have dropped on a re-parse/reserialize.
      expect(stored.ac).toBe(17);
      expect(stored.legacyUnknownField).toBe('preserve-me');
      expect(stored.spellSlots['2'].used).toBe(0);
    });

    // Issue #1909 review (Codex P2): `assertMutable` only covers the ENCOUNTER's own
    // deleted/ended status, not the CAMPAIGN's lifecycle. Every other encounter-write
    // transaction that re-reads a fresh encounter row pairs it with
    // `assertCampaignWritableInTx` (addCombatant, removeCombatant, undoRemoveCombatant,
    // rollCombatantInitiative) — this endpoint's statblock branch was missing it.
    it('an archived campaign rejects a statblock resource write, even though the encounter itself is still running (Codex review)', async () => {
      const { user, camp, enc, comb } = await seedStatblockEncounter();
      db.update(campaigns).set({ status: 'archived' }).where(eq(campaigns.id, camp.id)).run();

      await expect(
        encountersService.adjustCombatantResource(enc.id, comb.id, { key: 'kiPoints', delta: 1 }, user, 'dm'),
      ).rejects.toThrow(ForbiddenException);

      const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
      expect(JSON.parse(row.statblockJson!).resources.kiPoints.used).toBe(0);
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

    // Issue #1909 review (Codex): a keyed retry must replay an already-committed outcome
    // even if the combatant was removed since the original commit — an ordinary post-action
    // roster change (the DM removing the monster this pip was just spent on) must not break
    // replay for a request whose effect already landed. The outer `getCombatantRowOrThrow`
    // would otherwise 404 before the idempotency check is ever reached.
    it("a retried idempotencyKey replays its already-committed outcome even after the combatant has since been removed, while a FRESH write in the same state still 404s", async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      const first = await encountersService.adjustCombatantResource(
        enc.id,
        comb.id,
        { key: 'kiPoints', delta: 1, idempotencyKey: 'retry-key-removed-combatant' },
        user,
        'dm',
      );
      expect(first.statblock.resources['kiPoints'].used).toBe(1);

      // Simulate another actor removing the combatant between the original call and this
      // retry — a real DELETE, exactly what removeCombatant performs.
      db.delete(combatants).where(eq(combatants.id, comb.id)).run();

      const replay = await encountersService.adjustCombatantResource(
        enc.id,
        comb.id,
        { key: 'kiPoints', delta: 1, idempotencyKey: 'retry-key-removed-combatant' },
        user,
        'dm',
      );
      expect(replay.statblock.resources['kiPoints'].used).toBe(1);

      // A genuinely FRESH write (a new key) against the same now-removed combatant still
      // 404s — only an already-committed replay is exempt from requiring a live row.
      await expect(
        encountersService.adjustCombatantResource(
          enc.id,
          comb.id,
          { key: 'kiPoints', delta: 1, idempotencyKey: 'fresh-key-after-removal' },
          user,
          'dm',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    // Issue #1909 review (Codex + Devin, same defect): the outer `getRowOrThrow` used the
    // default `includeDeleted = false`, so a keyed retry against an encounter TRASHED since
    // the original commit would 404 before the idempotency-replay check (added above for the
    // combatant-removal case) was ever reached — mirrors that same fix, one level up.
    it("a retried idempotencyKey replays its already-committed outcome even after the ENCOUNTER has since been trashed, while a FRESH write in the same state still 404s", async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      const first = await encountersService.adjustCombatantResource(
        enc.id,
        comb.id,
        { key: 'kiPoints', delta: 1, idempotencyKey: 'retry-key-trashed-encounter' },
        user,
        'dm',
      );
      expect(first.statblock.resources['kiPoints'].used).toBe(1);

      // Simulate another actor trashing the encounter between the original call and this
      // retry — a soft delete, exactly what deleting an encounter performs.
      db.update(encounters).set({ deletedAt: new Date().toISOString() }).where(eq(encounters.id, enc.id)).run();

      const replay = await encountersService.adjustCombatantResource(
        enc.id,
        comb.id,
        { key: 'kiPoints', delta: 1, idempotencyKey: 'retry-key-trashed-encounter' },
        user,
        'dm',
      );
      expect(replay.statblock.resources['kiPoints'].used).toBe(1);

      // A genuinely FRESH write (a new key) against the same now-trashed encounter still
      // 404s — only an already-committed replay is exempt from requiring a live row.
      await expect(
        encountersService.adjustCombatantResource(
          enc.id,
          comb.id,
          { key: 'kiPoints', delta: 1, idempotencyKey: 'fresh-key-after-trash' },
          user,
          'dm',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    // Review finding (Devin + Copilot, same defect): the unit spec on the shared primitives
    // (encounter-idempotency-race.spec.ts) proves `recordEncounterOp` throws
    // `EncounterOpRaceMarker` on a colliding insert and that `readEncounterOpAfterRace`
    // returns the winner's stored response — but a bare source-grep confirming the catch
    // TEXT exists cannot distinguish a CORRECT catch from a broken one (`catch (err) {
    // throw err }`, one that returns the loser's own result, or one missing the `opClaim &&`
    // guard would all still match). This test instead drives `adjustCombatantResource`
    // itself through the real race path: `recordEncounterOp` is stubbed to throw
    // `EncounterOpRaceMarker` (standing in for a genuinely concurrent same-key insert that
    // collided), and `readEncounterOpAfterRace` is stubbed to resolve with a DISTINCTIVE
    // "winner" response the local write's own effect could never produce (`used: 999` on a
    // max-3 pool it never touched). If the catch is wired correctly, `adjustCombatantResource`
    // RESOLVES with that exact winner body; if the catch were a bare rethrow (or any other
    // broken shape), the call would reject instead — a real, failable assertion on behavior,
    // not on source text.
    it('a race-marker thrown by recordEncounterOp makes adjustCombatantResource resolve with the WINNER\'s replayed response, not reject', async () => {
      const { user, enc, comb } = await seedStatblockEncounter();

      const claim = {
        actorId: String(user.id),
        operation: 'combatant.resource_adjust' as const,
        key: 'race-marker-wiring',
        encounterId: enc.id,
        campaignId: enc.campaignId,
        fingerprint: 'irrelevant-for-this-stub',
      };
      const winnerResponse = { id: comb.id, statblock: { resources: { kiPoints: { max: 3, used: 999 } }, spellSlots: {} } };

      const recordSpy = jest
        .spyOn(encounterIdempotency, 'recordEncounterOp')
        .mockImplementation(() => {
          throw new encounterIdempotency.EncounterOpRaceMarker(claim);
        });
      const raceSpy = jest
        .spyOn(encounterIdempotency, 'readEncounterOpAfterRace')
        .mockResolvedValue({ response: winnerResponse, responseRole: 'dm' });

      try {
        const result = await encountersService.adjustCombatantResource(
          enc.id,
          comb.id,
          { key: 'kiPoints', delta: 1, idempotencyKey: 'race-marker-wiring' },
          user,
          'dm',
        );
        // The WINNER's stubbed body, not the loser's own would-be effect (used: 1) and not
        // a rejection.
        expect(result).toEqual(winnerResponse);
        expect(raceSpy).toHaveBeenCalledTimes(1);

        // The loser's own write must have rolled back with the transaction — nothing was
        // actually persisted from THIS call.
        const [row] = db.select().from(combatants).where(eq(combatants.id, comb.id)).all();
        expect(JSON.parse(row.statblockJson!).resources.kiPoints.used).toBe(0);
      } finally {
        recordSpy.mockRestore();
        raceSpy.mockRestore();
      }
    });
  });
});
