import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, characters, combatants, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #711, service-layer: ending an encounter must reconcile the full combat
 * death/temp-HP slice back onto the persistent character row, not just hpCurrent.
 *
 * The HTTP e2e layer exercises the same path but is verbose; this spec drives
 * the EncountersService directly against a real SQLite file so the assertions
 * stay tight and the persistence (not the HTTP plumbing) is what's under test.
 * Mirrors the shape of encounter-condition-concurrency.spec.ts.
 *
 * Covers the acceptance criteria:
 *  - death, stabilization, healing-from-zero (revival), temp HP carry-over;
 *  - /end reconciliation writes deathState + hpTemp + death-save counters;
 *  - dead PCs flip lifecycle status to 'dead' and are skipped by the next
 *    encounter's auto-add;
 *  - /reopen leaves the reconciled state self-consistent;
 *  - the next encounter seeds a stable PC's combatant row at 0 HP / stable,
 *    not silently revived.
 */
describe('encounter death/temp-HP reconciliation (real SQLite, service layer)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    const revisions = new RevisionsService(orm, audit);
    const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit));
    const encountersService = new EncountersService(orm, audit, events, rolls, revisions, attachments);
    return { orm, encountersService };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };

  /** Seed a campaign + a running encounter + a single character combatant. */
  function seedCharacterFight(opts: {
    hpCurrent?: number;
    hpMax?: number;
    hpTemp?: number;
    deathState?: string;
    deathSaveSuccesses?: number;
    deathSaveFailures?: number;
    status?: string;
  }): {
    orm: ReturnType<typeof build>['orm'];
    encountersService: EncountersService;
    campaignId: number;
    encounterId: number;
    characterId: number;
    combatantId: number;
  } {
    const { orm, encountersService } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Reconcile Test', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [character] = orm
      .insert(characters)
      .values({
        campaignId: campaign.id,
        name: 'Hero',
        hpCurrent: opts.hpCurrent ?? 20,
        hpMax: opts.hpMax ?? 20,
        hpTemp: opts.hpTemp ?? 0,
        deathState: opts.deathState ?? 'none',
        deathSaveSuccesses: opts.deathSaveSuccesses ?? 0,
        deathSaveFailures: opts.deathSaveFailures ?? 0,
        status: opts.status ?? 'active',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({
        campaignId: campaign.id,
        name: 'Fight',
        status: 'running',
        round: 1,
        turnIndex: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [combatant] = orm
      .insert(combatants)
      .values({
        encounterId: encounter.id,
        kind: 'character',
        characterId: character.id,
        name: character.name,
        initiative: 10,
        initMod: 0,
        hpCurrent: opts.hpCurrent ?? 20,
        hpMax: opts.hpMax ?? 20,
        conditions: '[]',
        sortOrder: 0,
      })
      .returning()
      .all();
    return {
      orm,
      encountersService,
      campaignId: campaign.id,
      encounterId: encounter.id,
      characterId: character.id,
      combatantId: combatant.id,
    };
  }

  function readCharacter(orm: ReturnType<typeof build>['orm'], id: number) {
    const [row] = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all();
    return row;
  }

  function readCombatant(orm: ReturnType<typeof build>['orm'], id: number) {
    const [row] = orm.select().from(combatants).where(eq(combatants.id, id)).limit(1).all();
    return row;
  }

  it('ending an encounter writes temp HP back onto the character (#711)', async () => {
    dataDir = makeTempDataDir();
    const ctx = seedCharacterFight({ hpCurrent: 20, hpMax: 20 });
    // Grant 5 temp HP mid-fight.
    await ctx.encountersService.updateCombatant(
      ctx.encounterId,
      ctx.combatantId,
      { hpTemp: 5 },
      dmUser,
      'dm',
    );

    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');

    const persisted = readCharacter(ctx.orm, ctx.characterId);
    expect(persisted.hpCurrent).toBe(20);
    expect(persisted.hpTemp).toBe(5);
    expect(persisted.deathState).toBe('none');
    expect(persisted.deathSaveSuccesses).toBe(0);
    expect(persisted.deathSaveFailures).toBe(0);
  });

  it('a stabilized character persists stable + 3 successes, no death flip (#711)', async () => {
    dataDir = makeTempDataDir();
    const ctx = seedCharacterFight({ hpCurrent: 0, hpMax: 20 });
    // Drop to 0 then stabilize.
    await ctx.encountersService.updateCombatant(
      ctx.encounterId,
      ctx.combatantId,
      { deathSaveSuccesses: 3 },
      dmUser,
      'dm',
    );
    const combatant = readCombatant(ctx.orm, ctx.combatantId);
    expect(combatant.deathState).toBe('stable');

    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');

    const persisted = readCharacter(ctx.orm, ctx.characterId);
    expect(persisted.hpCurrent).toBe(0);
    expect(persisted.deathState).toBe('stable');
    expect(persisted.deathSaveSuccesses).toBe(3);
    expect(persisted.deathSaveFailures).toBe(0);
    // Stable PCs are NOT marked dead — they're still active on the roster.
    expect(persisted.status).toBe('active');
  });

  it('a dead character flips lifecycle status to dead and is excluded from next auto-add (#711)', async () => {
    dataDir = makeTempDataDir();
    const ctx = seedCharacterFight({ hpCurrent: 0, hpMax: 20 });
    // Kill via three failed death saves.
    await ctx.encountersService.updateCombatant(
      ctx.encounterId,
      ctx.combatantId,
      { deathSaveFailures: 3 },
      dmUser,
      'dm',
    );
    const combatant = readCombatant(ctx.orm, ctx.combatantId);
    expect(combatant.deathState).toBe('dead');

    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');

    const persisted = readCharacter(ctx.orm, ctx.characterId);
    expect(persisted.deathState).toBe('dead');
    expect(persisted.deathSaveFailures).toBe(3);
    // The dead PC is now excluded from future auto-add.
    expect(persisted.status).toBe('dead');

    // Create a second encounter — the dead PC must NOT be auto-added.
    const next = await ctx.encountersService.create(
      ctx.campaignId,
      { name: 'Next Fight' },
      dmUser,
      'dm',
    );
    expect(next.combatants.find((c) => c.characterId === ctx.characterId)).toBeUndefined();
  });

  it('revival: healing a downed character above 0 during combat clears death state on /end (#711)', async () => {
    dataDir = makeTempDataDir();
    const ctx = seedCharacterFight({ hpCurrent: 0, hpMax: 20 });
    // Drop, stabilize, then revive with healing.
    await ctx.encountersService.updateCombatant(
      ctx.encounterId,
      ctx.combatantId,
      { deathSaveSuccesses: 3 },
      dmUser,
      'dm',
    );
    await ctx.encountersService.updateCombatant(
      ctx.encounterId,
      ctx.combatantId,
      { hpDelta: 5 },
      dmUser,
      'dm',
    );
    const combatant = readCombatant(ctx.orm, ctx.combatantId);
    expect(combatant.hpCurrent).toBe(5);
    expect(combatant.deathState).toBe('none');

    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');

    const persisted = readCharacter(ctx.orm, ctx.characterId);
    expect(persisted.hpCurrent).toBe(5);
    expect(persisted.deathState).toBe('none');
    expect(persisted.deathSaveSuccesses).toBe(0);
    expect(persisted.deathSaveFailures).toBe(0);
    // A revived character stays active.
    expect(persisted.status).toBe('active');
  });

  it('revival from a previously-dead lifecycle: revival re-marks the character active (#711)', async () => {
    dataDir = makeTempDataDir();
    const ctx = seedCharacterFight({ hpCurrent: 0, hpMax: 20, status: 'dead' });
    // The sheet was carrying a dead lifecycle. The DM drops the character into
    // the encounter tracker, then heals them to 1 HP mid-fight.
    await ctx.encountersService.updateCombatant(
      ctx.encounterId,
      ctx.combatantId,
      { hpSet: 1 },
      dmUser,
      'dm',
    );

    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');

    const persisted = readCharacter(ctx.orm, ctx.characterId);
    expect(persisted.hpCurrent).toBe(1);
    expect(persisted.deathState).toBe('none');
    // The revival flips the dead lifecycle back to active.
    expect(persisted.status).toBe('active');
  });

  it('a downed-but-dying character persists dying and is still active for the next encounter (#711)', async () => {
    dataDir = makeTempDataDir();
    const ctx = seedCharacterFight({ hpCurrent: 5, hpMax: 20 });
    await ctx.encountersService.updateCombatant(
      ctx.encounterId,
      ctx.combatantId,
      { hpDelta: -5 },
      dmUser,
      'dm',
    );
    const combatant = readCombatant(ctx.orm, ctx.combatantId);
    expect(combatant.hpCurrent).toBe(0);
    expect(combatant.deathState).toBe('dying');

    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');

    const persisted = readCharacter(ctx.orm, ctx.characterId);
    expect(persisted.hpCurrent).toBe(0);
    expect(persisted.deathState).toBe('dying');
    // A dying PC stays active — they re-enter the next fight still down.
    expect(persisted.status).toBe('active');
  });

  it('the next encounter seeds a stable PC combatant at 0 HP / stable, not revived (#711)', async () => {
    dataDir = makeTempDataDir();
    const ctx = seedCharacterFight({ hpCurrent: 0, hpMax: 20 });
    await ctx.encountersService.updateCombatant(
      ctx.encounterId,
      ctx.combatantId,
      { deathSaveSuccesses: 3 },
      dmUser,
      'dm',
    );
    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');

    const next = await ctx.encountersService.create(
      ctx.campaignId,
      { name: 'Next Fight' },
      dmUser,
      'dm',
    );
    const nextCombatant = next.combatants.find((c) => c.characterId === ctx.characterId);
    expect(nextCombatant).toBeDefined();
    expect(nextCombatant!.hpCurrent).toBe(0);
    expect(nextCombatant!.deathState).toBe('stable');
    expect(nextCombatant!.deathSaveSuccesses).toBe(3);
  });

  it('the next encounter seeds carried-over temp HP onto the combatant (#711)', async () => {
    dataDir = makeTempDataDir();
    const ctx = seedCharacterFight({ hpCurrent: 12, hpMax: 20 });
    await ctx.encountersService.updateCombatant(
      ctx.encounterId,
      ctx.combatantId,
      { hpTemp: 8 },
      dmUser,
      'dm',
    );
    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');

    const next = await ctx.encountersService.create(
      ctx.campaignId,
      { name: 'Next Fight' },
      dmUser,
      'dm',
    );
    const nextCombatant = next.combatants.find((c) => c.characterId === ctx.characterId);
    expect(nextCombatant).toBeDefined();
    expect(nextCombatant!.hpCurrent).toBe(12);
    expect(nextCombatant!.hpTemp).toBe(8);
  });

  it('reopen leaves the reconciled death state self-consistent (#711)', async () => {
    dataDir = makeTempDataDir();
    const ctx = seedCharacterFight({ hpCurrent: 0, hpMax: 20 });
    await ctx.encountersService.updateCombatant(
      ctx.encounterId,
      ctx.combatantId,
      { deathSaveSuccesses: 3 },
      dmUser,
      'dm',
    );
    await ctx.encountersService.end(ctx.encounterId, dmUser, 'dm');
    const ended = readCharacter(ctx.orm, ctx.characterId);
    expect(ended.deathState).toBe('stable');

    // Reopen — the combatant row still holds its post-fight state.
    await ctx.encountersService.reopen(ctx.encounterId, dmUser, 'dm');
    const combatant = readCombatant(ctx.orm, ctx.combatantId);
    expect(combatant.hpCurrent).toBe(0);
    expect(combatant.deathState).toBe('stable');
    expect(combatant.deathSaveSuccesses).toBe(3);

    // And the character sheet is unchanged by the reopen itself.
    const persisted = readCharacter(ctx.orm, ctx.characterId);
    expect(persisted.deathState).toBe('stable');
  });

  it('a monster combatant is never reconciled onto a character row (#711)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Monster Only', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({
        campaignId: campaign.id,
        name: 'Monster Fight',
        status: 'running',
        round: 1,
        turnIndex: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [monster] = orm
      .insert(combatants)
      .values({
        encounterId: encounter.id,
        kind: 'monster',
        name: 'Goblin',
        initiative: 5,
        initMod: 0,
        hpCurrent: 0,
        hpMax: 7,
        conditions: '[]',
        sortOrder: 0,
      })
      .returning()
      .all();

    // No characters exist; ending must not throw and not invent a write.
    await encountersService.end(encounter.id, dmUser, 'dm');
    const allCharacters = orm.select().from(characters).all();
    expect(allCharacters).toHaveLength(0);
    // The monster row is untouched by reconciliation (only the status flip happens).
    const monsterRow = readCombatant(orm, monster.id);
    expect(monsterRow.hpCurrent).toBe(0);
  });

  it('pre-#711 legacy characters default to alive / temp-less on read (#711)', async () => {
    dataDir = makeTempDataDir();
    const { orm } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Legacy', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    // Insert a character row directly, omitting the new columns to simulate a
    // pre-migration legacy row. Drizzle fills the NOT NULL DEFAULTs.
    const [character] = orm
      .insert(characters)
      .values({
        campaignId: campaign.id,
        name: 'Legacy Hero',
        hpCurrent: 10,
        hpMax: 10,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    expect(character.hpTemp).toBe(0);
    expect(character.deathState).toBe('none');
    expect(character.deathSaveSuccesses).toBe(0);
    expect(character.deathSaveFailures).toBe(0);
  });
});
