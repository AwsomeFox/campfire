import fs from 'node:fs';
import { BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, combatants, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #2091 — a RUNNING encounter whose roster has emptied must not let next-turn /
 * end-turn silently report success and increment the round.
 *
 * `removeCombatant` (encounters.service.ts) deliberately still permits emptying a
 * running encounter's roster, including its last combatant — the combatant-removal
 * undo window and a death-save-replay-then-end flow both depend on that (see the e2e
 * regression test in encounters.e2e-spec.ts for the full argument). So the state this
 * spec seeds directly at the storage layer is reachable via the ordinary REST/MCP path
 * too, not just via a legacy upgrade — this integration spec exercises it at the
 * service layer for precise control over the round/currentCombatantId snapshot. It
 * proves `advanceCurrentTurn` (shared by next-turn and end-turn) refuses to advance an
 * empty fight rather than quietly incrementing the round forever, which is the actual
 * mechanism issue #2091 reported: "next-turn keeps returning 201 without advancing
 * anything... no other encounter can be started until the DM manually ends the empty
 * one."
 */
describe('encounter next-turn/end-turn on an empty RUNNING roster (issue #2091, service layer)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    const revisions = new RevisionsService(orm, new ModerationService(orm, audit));
    const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit), new AttachmentDerivativesService(orm));
    const campaignLibrary = new CampaignLibraryService(orm, audit, events);
    // A real NotificationsService, not a hand-rolled double (AGENTS.md's test-double
    // convention, review finding on #2104 from Codex): it depends only on `orm`, which
    // this build() already has, so there is no cast and no risk of the double silently
    // drifting from the real class's shape — every other dependency here is already a
    // real instance for the same reason.
    const notifications = new NotificationsService(orm);
    const encountersService = new EncountersService(orm, audit, events, rolls, revisions, attachments, campaignLibrary, notifications);
    return { orm, encountersService };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };

  /** Seed a RUNNING encounter with one combatant, then delete it directly at the
   * storage layer (a raw delete, standing in for removeCombatant's normal DELETE
   * /combatants/:id — see the class doc comment for why that path is left open) to
   * land on a precise round/currentCombatantId snapshot without depending on
   * removeCombatant's own turn-advance bookkeeping. */
  function seedEmptyRunningEncounter() {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const ts = new Date().toISOString();
    const [campaign] = orm.insert(campaigns).values({ name: 'Empty Running Campaign', createdAt: ts, updatedAt: ts }).returning().all();
    const [encounter] = orm
      .insert(encounters)
      .values({
        campaignId: campaign.id,
        name: 'Wedge',
        status: 'running',
        round: 2,
        turnIndex: 0,
        currentCombatantId: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [combatant] = orm
      .insert(combatants)
      .values({
        encounterId: encounter.id,
        kind: 'monster',
        name: 'Doomed Goblin',
        initiative: 15,
        initMod: 0,
        hpCurrent: 7,
        hpMax: 7,
        conditions: '[]',
        sortOrder: 0,
      })
      .returning()
      .all();
    orm.update(encounters).set({ currentCombatantId: combatant.id }).where(eq(encounters.id, encounter.id)).run();
    orm.update(campaigns).set({ activeEncounterId: encounter.id }).where(eq(campaigns.id, campaign.id)).run();

    // A raw delete, standing in for removeCombatant's own DELETE handling (which also
    // nulls currentCombatantId via the same FK, per the class doc comment above).
    orm.delete(combatants).where(eq(combatants.id, combatant.id)).run();

    return { orm, encountersService, encounterId: encounter.id, campaignId: campaign.id };
  }

  it('next-turn on an empty running encounter is rejected, not a silent 201 round bump', async () => {
    const ctx = seedEmptyRunningEncounter();
    const [before] = ctx.orm.select().from(encounters).where(eq(encounters.id, ctx.encounterId)).limit(1).all();
    expect(before.status).toBe('running');
    expect(before.round).toBe(2);

    await expect(ctx.encountersService.nextTurn(ctx.encounterId, {}, dmUser, 'dm')).rejects.toBeInstanceOf(BadRequestException);
    try {
      await ctx.encountersService.nextTurn(ctx.encounterId, {}, dmUser, 'dm');
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as { message?: string };
      expect(String(body.message)).toMatch(/no combatants/i);
    }

    // The round must NOT have advanced — the exact issue #2091 symptom ("next-turn
    // keeps returning 201... round=2" over and over) must now be a hard failure, not
    // a quiet no-op success.
    const [after] = ctx.orm.select().from(encounters).where(eq(encounters.id, ctx.encounterId)).limit(1).all();
    expect(after.status).toBe('running');
    expect(after.round).toBe(2);
  });

  it('end-turn on an empty running encounter is also rejected, not a silent success', async () => {
    const ctx = seedEmptyRunningEncounter();
    // NOTE on why this passes independently of the advanceCurrentTurn fresh-roster guard
    // added for issue #2091: `combatants.id -> encounters.current_combatant_id` is FK
    // ON DELETE SET NULL (bootstrap.sql), so the raw delete in seedEmptyRunningEncounter
    // already nulled the persisted currentCombatantId — meaning ANY reachable "running +
    // zero combatants" row necessarily has currentCombatantId === null. endTurn's own
    // pre-existing check (`if (currentId === null) throw ...'No combatant currently has
    // the turn'`, evaluated on the OUTER pre-transaction read) already refuses this state
    // before advanceCurrentTurn's shared fresh-roster guard is ever reached — verified by
    // this test passing unchanged whether or not that guard exists. The guard still lives
    // in advanceCurrentTurn (shared by both callers) because next-turn has no equivalent
    // pre-check of its own — see the test above, which fails without it.
    await expect(
      ctx.encountersService.endTurn(ctx.encounterId, {}, dmUser, 'dm'),
    ).rejects.toBeInstanceOf(BadRequestException);

    const [after] = ctx.orm.select().from(encounters).where(eq(encounters.id, ctx.encounterId)).limit(1).all();
    expect(after.status).toBe('running');
    expect(after.round).toBe(2);
  });
});
