import fs from 'node:fs';
import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, characters, combatants, encounters, locations, quests, sessions } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #864 — encounter create must validate location/quest/session links against
 * the target campaign before any write. Service-layer integration against a real
 * SQLite file (mirrors encounter-death-temp-hp-reconcile.spec.ts): covers each link
 * field, mixed valid/invalid payloads, foreign visible vs invisible campaigns, and
 * zero partial rows (no encounter / combatants / audit side-effects on reject).
 */
describe('encounter link validation on create (real SQLite, issue #864)', () => {
  let dataDir: string;
  let sqliteHandle: { close: () => void } | null = null;

  afterEach(() => {
    try {
      sqliteHandle?.close();
    } catch {
      /* already closed */
    }
    sqliteHandle = null;
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      dataDir = '';
    }
  });

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };

  function build() {
    const { orm, sqlite } = openDatabase(dataDir);
    sqliteHandle = sqlite;
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    const revisions = new RevisionsService(orm, audit);
    const encountersService = new EncountersService(orm, audit, events, rolls, revisions);
    // Capture SSE emits without needing a live subscriber — reject paths must not emit.
    const emitted: Array<{ type: string; campaignId: number }> = [];
    jest.spyOn(events, 'emit').mockImplementation((event) => {
      emitted.push({ type: event.type, campaignId: event.campaignId });
    });
    return { orm, sqlite, encountersService, events, emitted };
  }

  function seedTwoCampaigns() {
    dataDir = makeTempDataDir();
    const { orm, encountersService, events, emitted } = build();
    const ts = new Date().toISOString();

    const [campA] = orm.insert(campaigns).values({ name: 'Campaign A', createdAt: ts, updatedAt: ts }).returning().all();
    const [campB] = orm.insert(campaigns).values({ name: 'Campaign B', createdAt: ts, updatedAt: ts }).returning().all();

    // Party member in A — proves a rejected create does not auto-add combatants.
    orm
      .insert(characters)
      .values({
        campaignId: campA.id,
        name: 'Hero',
        hpCurrent: 20,
        hpMax: 20,
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const [locA] = orm
      .insert(locations)
      .values({ campaignId: campA.id, name: 'Thornbridge', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [questA] = orm
      .insert(quests)
      .values({ campaignId: campA.id, title: 'The Everflame', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [sessionA] = orm
      .insert(sessions)
      .values({ campaignId: campA.id, number: 1, title: 'Session One', createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    const [locB] = orm
      .insert(locations)
      .values({ campaignId: campB.id, name: 'Elsewhere', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [questB] = orm
      .insert(quests)
      .values({ campaignId: campB.id, title: 'Foreign Quest', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [sessionB] = orm
      .insert(sessions)
      .values({ campaignId: campB.id, number: 1, title: 'Foreign Session', createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    return {
      orm,
      encountersService,
      events,
      emitted,
      campA,
      campB,
      locA,
      questA,
      sessionA,
      locB,
      questB,
      sessionB,
    };
  }

  async function expectRejectedCreate(
    ctx: ReturnType<typeof seedTwoCampaigns>,
    campaignId: number,
    input: { name: string; locationId?: number | null; questId?: number | null; sessionId?: number | null },
  ) {
    const beforeEncounters = ctx.orm.select().from(encounters).where(eq(encounters.campaignId, campaignId)).all().length;
    const beforeCombatants = ctx.orm.select().from(combatants).all().length;
    const beforeEmits = ctx.emitted.length;

    await expect(ctx.encountersService.create(campaignId, input, dmUser, 'dm')).rejects.toBeInstanceOf(NotFoundException);

    expect(ctx.orm.select().from(encounters).where(eq(encounters.campaignId, campaignId)).all()).toHaveLength(beforeEncounters);
    expect(ctx.orm.select().from(combatants).all()).toHaveLength(beforeCombatants);
    expect(ctx.emitted).toHaveLength(beforeEmits);
  }

  it('accepts valid same-campaign location/quest/session links', async () => {
    const { orm, encountersService, campA, locA, questA, sessionA } = seedTwoCampaigns();

    const created = await encountersService.create(
      campA.id,
      { name: 'Ambush', locationId: locA.id, questId: questA.id, sessionId: sessionA.id },
      dmUser,
      'dm',
    );

    expect(created.locationId).toBe(locA.id);
    expect(created.questId).toBe(questA.id);
    expect(created.sessionId).toBe(sessionA.id);
    // Party auto-add ran (one active character).
    expect(created.combatants).toHaveLength(1);

    const row = orm.select().from(encounters).where(eq(encounters.id, created.id)).all()[0];
    expect(row.locationId).toBe(locA.id);
    expect(row.questId).toBe(questA.id);
    expect(row.sessionId).toBe(sessionA.id);
  });

  it.each([
    ['locationId', (ids: ReturnType<typeof seedTwoCampaigns>) => ({ locationId: ids.locB.id })],
    ['questId', (ids: ReturnType<typeof seedTwoCampaigns>) => ({ questId: ids.questB.id })],
    ['sessionId', (ids: ReturnType<typeof seedTwoCampaigns>) => ({ sessionId: ids.sessionB.id })],
  ] as const)('rejects a foreign %s with 404 and writes nothing', async (_field, pick) => {
    const ctx = seedTwoCampaigns();
    await expectRejectedCreate(ctx, ctx.campA.id, {
      name: 'Bad link',
      ...pick(ctx),
    });
  });

  it('rejects a nonexistent link id with the same non-enumerating 404', async () => {
    const ctx = seedTwoCampaigns();
    try {
      await ctx.encountersService.create(ctx.campA.id, { name: 'Ghost', locationId: 999999 }, dmUser, 'dm');
      throw new Error('expected NotFoundException');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).message).toBe('location not found');
    }
    // Same message shape for a foreign (existing-elsewhere) target — non-enumerating.
    try {
      await ctx.encountersService.create(ctx.campA.id, { name: 'Foreign', locationId: ctx.locB.id }, dmUser, 'dm');
      throw new Error('expected NotFoundException');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).message).toBe('location not found');
    }
  });

  it('rejects mixed valid+invalid links and leaves zero partial rows', async () => {
    const ctx = seedTwoCampaigns();
    // Valid location + foreign quest — must fail before any insert.
    await expectRejectedCreate(ctx, ctx.campA.id, {
      name: 'Mixed',
      locationId: ctx.locA.id,
      questId: ctx.questB.id,
      sessionId: ctx.sessionA.id,
    });
  });

  it('rejects a foreign link even when the caller can see the other campaign', async () => {
    // Visibility of campaign B is irrelevant: the link must belong to the TARGET
    // campaign (A). Seed already creates both campaigns under the same DM user.
    const ctx = seedTwoCampaigns();
    await expectRejectedCreate(ctx, ctx.campA.id, {
      name: 'Visible foreign',
      locationId: ctx.locB.id,
      questId: ctx.questB.id,
      sessionId: ctx.sessionB.id,
    });
  });

  it('rejects a foreign link from an invisible campaign with the same 404', async () => {
    // Campaign B exists in the DB but the create is scoped to A — the service never
    // consults membership on the foreign campaign, so "invisible" and "visible"
    // foreign targets are indistinguishable (non-enumerating).
    const ctx = seedTwoCampaigns();
    try {
      await ctx.encountersService.create(
        ctx.campA.id,
        { name: 'Invisible foreign', questId: ctx.questB.id },
        dmUser,
        'dm',
      );
      throw new Error('expected NotFoundException');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).message).toBe('quest not found');
    }
  });
});
