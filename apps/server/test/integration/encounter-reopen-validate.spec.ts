import fs from 'node:fs';
import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, combatants, encounterEvents, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
// Issue #604: AttachmentsService now delegates responsive derivative generation.
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #489 — reopen must re-validate combatants and the turn pointer.
 *
 * Covers: missing current combatant, null-initiative current, zero combatants (409).
 */
describe('encounter reopen turn-pointer validation (issue #489, service layer)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    // Issue #601: RevisionsService fires the moderation pre-mutation evidence hook
    // on restore, so it takes a real ModerationService. Deliberately not optional —
    // an absent hook would silently stop capturing abuse evidence.
    const revisions = new RevisionsService(orm, new ModerationService(orm, audit));
    const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit), new AttachmentDerivativesService(orm));
    const campaignLibrary = new CampaignLibraryService(orm, audit, events);
    const encountersService = new EncountersService(orm, audit, events, rolls, revisions, attachments, campaignLibrary, { notifyCampaign: jest.fn().mockResolvedValue(undefined), notifyUser: jest.fn().mockResolvedValue(undefined) } as any);
    return { orm, encountersService };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };

  function seedEndedEncounter(opts: {
    combatants: Array<{ name: string; initiative: number | null; sortOrder: number }>;
    currentCombatantId?: number | 'first' | 'second' | null;
    turnIndex?: number;
    /** Campaign rule system; omitted means the 5e default (issue #2123). */
    ruleSystem?: string;
  }) {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Reopen Validate', createdAt: ts, updatedAt: ts, ...(opts.ruleSystem ? { ruleSystem: opts.ruleSystem } : {}) })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({
        campaignId: campaign.id,
        name: 'Ended Fight',
        status: 'ended',
        round: 3,
        turnIndex: opts.turnIndex ?? 0,
        currentCombatantId: null,
        endedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();

    const inserted = opts.combatants.map((c) => {
      const [row] = orm
        .insert(combatants)
        .values({
          encounterId: encounter.id,
          kind: 'monster',
          name: c.name,
          initiative: c.initiative,
          initMod: 0,
          hpCurrent: 10,
          hpMax: 10,
          conditions: '[]',
          sortOrder: c.sortOrder,
        })
        .returning()
        .all();
      return row;
    });

    let currentCombatantId: number | null = null;
    if (opts.currentCombatantId === 'first') currentCombatantId = inserted[0]?.id ?? null;
    else if (opts.currentCombatantId === 'second') currentCombatantId = inserted[1]?.id ?? null;
    else if (typeof opts.currentCombatantId === 'number') currentCombatantId = opts.currentCombatantId;
    else if (opts.currentCombatantId === null) currentCombatantId = null;

    orm
      .update(encounters)
      .set({ currentCombatantId, turnIndex: opts.turnIndex ?? 0 })
      .where(eq(encounters.id, encounter.id))
      .run();

    return { orm, encountersService, encounterId: encounter.id, combatants: inserted };
  }

  it('refuses reopen with zero combatants (409)', async () => {
    const ctx = seedEndedEncounter({ combatants: [], currentCombatantId: null });
    // Remove any rows (seed already empty) and reopen.
    await expect(ctx.encountersService.reopen(ctx.encounterId, dmUser, 'dm')).rejects.toBeInstanceOf(ConflictException);
    try {
      await ctx.encountersService.reopen(ctx.encounterId, dmUser, 'dm');
    } catch (err) {
      const body = (err as ConflictException).getResponse() as { code?: string };
      expect(body.code).toBe('REOPEN_NO_COMBATANTS');
    }
  });

  it('snaps turn pointer to top when current combatant was removed', async () => {
    const ctx = seedEndedEncounter({
      combatants: [
        { name: 'Goblin A', initiative: 15, sortOrder: 0 },
        { name: 'Goblin B', initiative: 10, sortOrder: 1 },
      ],
      currentCombatantId: 'second',
      turnIndex: 1,
    });
    // Delete the current combatant. FK ON DELETE SET NULL clears currentCombatantId
    // (bootstrap.sql), leaving a null pointer that reopen must repair.
    ctx.orm.delete(combatants).where(eq(combatants.id, ctx.combatants[1].id)).run();
    const [before] = ctx.orm.select().from(encounters).where(eq(encounters.id, ctx.encounterId)).limit(1).all();
    expect(before.currentCombatantId).toBeNull();

    const reopened = await ctx.encountersService.reopen(ctx.encounterId, dmUser, 'dm');
    expect(reopened.status).toBe('running');
    expect(reopened.currentCombatantId).toBe(ctx.combatants[0].id);
    expect(reopened.turnIndex).toBe(0);

    const notes = ctx.orm
      .select()
      .from(encounterEvents)
      .where(eq(encounterEvents.encounterId, ctx.encounterId))
      .all()
      .filter((e) => e.type === 'note');
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].detail).toMatch(/missing/i);
  });

  it('snaps turn pointer to top when current combatant has null initiative', async () => {
    const ctx = seedEndedEncounter({
      combatants: [
        { name: 'Alpha', initiative: 18, sortOrder: 0 },
        { name: 'Bravo', initiative: 12, sortOrder: 1 },
      ],
      currentCombatantId: 'second',
      turnIndex: 1,
    });
    // Null out the current combatant's initiative while ended.
    ctx.orm.update(combatants).set({ initiative: null }).where(eq(combatants.id, ctx.combatants[1].id)).run();

    const reopened = await ctx.encountersService.reopen(ctx.encounterId, dmUser, 'dm');
    // Sorted running order: Alpha (18) first, Bravo (null) last → top is Alpha.
    expect(reopened.currentCombatantId).toBe(ctx.combatants[0].id);
    expect(reopened.turnIndex).toBe(0);

    const notes = ctx.orm
      .select()
      .from(encounterEvents)
      .where(eq(encounterEvents.encounterId, ctx.encounterId))
      .all()
      .filter((e) => e.type === 'note');
    expect(notes.some((n) => /no initiative/i.test(n.detail))).toBe(true);
  });

  /**
   * Issue #2123 (Devin review on #2128): the null-initiative half of the pointer-validity
   * test only makes sense for a system that HAS an initiative roll. Ironsworn: Starforged
   * runs an entire fight with every combatant at `initiative === null` — turn order is the
   * roster order — so treating that as a dangling pointer would snap EVERY reopen back to
   * the top of the roster mid-round and log a notice blaming a missing initiative the game
   * never has. The 5e case above (same shape, default rule system) is the contrast: there a
   * null really does mean the pointer is broken.
   */
  it('preserves an unrolled current combatant when the rule system has no initiative roll', async () => {
    const ctx = seedEndedEncounter({
      ruleSystem: 'starforged',
      combatants: [
        { name: 'Vanguard', initiative: null, sortOrder: 0 },
        { name: 'Sentinel', initiative: null, sortOrder: 1 },
        { name: 'Harrier', initiative: null, sortOrder: 2 },
      ],
      currentCombatantId: 'second',
      turnIndex: 1,
    });

    const reopened = await ctx.encountersService.reopen(ctx.encounterId, dmUser, 'dm');
    expect(reopened.status).toBe('running');
    expect(reopened.currentCombatantId).toBe(ctx.combatants[1].id);
    expect(reopened.turnIndex).toBe(1);
    // Roster order is preserved too — an all-null roster sorts by sortOrder.
    expect(reopened.combatants.map((c) => c.id)).toEqual(ctx.combatants.map((c) => c.id));

    const notes = ctx.orm
      .select()
      .from(encounterEvents)
      .where(eq(encounterEvents.encounterId, ctx.encounterId))
      .all()
      .filter((e) => e.type === 'note');
    expect(notes.some((n) => /Turn pointer reset/i.test(n.detail ?? ''))).toBe(false);
  });

  it('still snaps a genuinely missing pointer for that same no-initiative system', async () => {
    const ctx = seedEndedEncounter({
      ruleSystem: 'starforged',
      combatants: [
        { name: 'Vanguard', initiative: null, sortOrder: 0 },
        { name: 'Sentinel', initiative: null, sortOrder: 1 },
      ],
      currentCombatantId: 'second',
      turnIndex: 1,
    });
    // FK ON DELETE SET NULL clears currentCombatantId, leaving a truly dangling pointer —
    // that half of the predicate is unconditional under every rule system.
    ctx.orm.delete(combatants).where(eq(combatants.id, ctx.combatants[1].id)).run();

    const reopened = await ctx.encountersService.reopen(ctx.encounterId, dmUser, 'dm');
    expect(reopened.currentCombatantId).toBe(ctx.combatants[0].id);
    expect(reopened.turnIndex).toBe(0);

    const notes = ctx.orm
      .select()
      .from(encounterEvents)
      .where(eq(encounterEvents.encounterId, ctx.encounterId))
      .all()
      .filter((e) => e.type === 'note');
    expect(notes.some((n) => /missing/i.test(n.detail ?? ''))).toBe(true);
  });

  it('preserves a still-valid current combatant and re-derives turnIndex', async () => {
    const ctx = seedEndedEncounter({
      combatants: [
        { name: 'High', initiative: 20, sortOrder: 0 },
        { name: 'Low', initiative: 5, sortOrder: 1 },
      ],
      currentCombatantId: 'second',
      // Stale positional index (as if order reshuffled) — should be corrected to 1.
      turnIndex: 0,
    });

    const reopened = await ctx.encountersService.reopen(ctx.encounterId, dmUser, 'dm');
    expect(reopened.currentCombatantId).toBe(ctx.combatants[1].id);
    expect(reopened.turnIndex).toBe(1);
  });
});
