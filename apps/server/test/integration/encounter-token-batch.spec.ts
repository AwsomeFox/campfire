import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, combatants, encounterEvents, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/** Real-SQLite coverage for issue #761's all-or-nothing batch state machine. */
describe('encounter token batch atomicity (real SQLite, service layer)', () => {
  let dataDir: string;
  const dm: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };
  const otherDm: RequestUser = { id: 'dev:other-dm', name: 'Other DM', serverRole: 'admin', devRole: 'dm' };

  afterEach(() => { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); });

  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    const revisions = new RevisionsService(orm, new ModerationService(orm, audit));
    const attachments = new AttachmentsService(orm, audit, new FsDeletionService(orm, audit), new AttachmentDerivativesService(orm));
    return { orm, service: new EncountersService(orm, audit, events, rolls, revisions, attachments, new CampaignLibraryService(orm, audit)) };
  }

  function seed(orm: ReturnType<typeof build>['orm']) {
    const now = new Date().toISOString();
    const campaign = orm.insert(campaigns).values({ name: 'Batch map', createdAt: now, updatedAt: now }).returning().get()!;
    const encounter = orm.insert(encounters).values({ campaignId: campaign.id, name: 'Battle', status: 'running', round: 1, turnIndex: 0, createdAt: now, updatedAt: now }).returning().get()!;
    const rows = ['A', 'B', 'C'].map((name, sortOrder) => orm.insert(combatants).values({ encounterId: encounter.id, kind: 'monster', name, initiative: 10 - sortOrder, initMod: 0, hpCurrent: 10, hpMax: 10, conditions: '[]', sortOrder, tokenX: sortOrder * 10 + 10, tokenY: 10 }).returning().get()!);
    return { encounterId: encounter.id, first: rows[0], second: rows[1], obstacle: rows[2] };
  }
  const position = (orm: ReturnType<typeof build>['orm'], id: number) => orm.select({ x: combatants.tokenX, y: combatants.tokenY }).from(combatants).where(eq(combatants.id, id)).get()!;

  it('rejects a stale captured position without changing any planned token', async () => {
    dataDir = makeTempDataDir(); const { orm, service } = build(); const { encounterId, first, second } = seed(orm);
    const preview = await service.previewTokenBatch(encounterId, { placements: [{ combatantId: first.id, x: 50, y: 50 }, { combatantId: second.id, x: 60, y: 50 }], mapAspect: 1 }, dm, 'dm');
    orm.update(combatants).set({ tokenX: 11 }).where(eq(combatants.id, first.id)).run();
    await expect(service.applyTokenBatch(encounterId, { previewToken: preview.previewToken, idempotencyKey: 'stale-preview' }, dm, 'dm')).rejects.toThrow('Token positions changed');
    expect(position(orm, first.id)).toEqual({ x: 11, y: 10 });
    expect(position(orm, second.id)).toEqual({ x: 20, y: 10 });
  });

  it('blocks an apply when an unselected token enters a planned footprint, with zero selected writes', async () => {
    dataDir = makeTempDataDir(); const { orm, service } = build(); const { encounterId, first, second, obstacle } = seed(orm);
    const preview = await service.previewTokenBatch(encounterId, { placements: [{ combatantId: first.id, x: 50, y: 50 }, { combatantId: second.id, x: 60, y: 50 }], mapAspect: 1 }, dm, 'dm');
    orm.update(combatants).set({ tokenX: 50, tokenY: 50 }).where(eq(combatants.id, obstacle.id)).run();
    await expect(service.applyTokenBatch(encounterId, { previewToken: preview.previewToken, idempotencyKey: 'obstacle-apply' }, dm, 'dm')).rejects.toThrow('moved into this batch placement');
    expect(position(orm, first.id)).toEqual({ x: 10, y: 10 }); expect(position(orm, second.id)).toEqual({ x: 20, y: 10 });
  });

  it('replays only the same actor-bound apply key', async () => {
    dataDir = makeTempDataDir(); const { orm, service } = build(); const { encounterId, first, second } = seed(orm);
    const preview = await service.previewTokenBatch(encounterId, { placements: [{ combatantId: first.id, x: 50, y: 50 }, { combatantId: second.id, x: 60, y: 50 }], mapAspect: 1 }, dm, 'dm');
    const firstApply = await service.applyTokenBatch(encounterId, { previewToken: preview.previewToken, idempotencyKey: 'apply-one' }, dm, 'dm');
    await expect(service.applyTokenBatch(encounterId, { previewToken: preview.previewToken, idempotencyKey: 'apply-two' }, dm, 'dm')).rejects.toThrow('Idempotency key');
    await expect(service.applyTokenBatch(encounterId, { previewToken: preview.previewToken, idempotencyKey: 'apply-one' }, otherDm, 'dm')).rejects.toThrow('Token batch preview not found');
    expect(await service.applyTokenBatch(encounterId, { previewToken: preview.previewToken, idempotencyKey: 'apply-one' }, dm, 'dm')).toEqual(firstApply);
    expect(position(orm, first.id)).toEqual({ x: 50, y: 50 }); expect(position(orm, second.id)).toEqual({ x: 60, y: 50 });
  });

  it('rejects reuse of an actor key on a different preview before SQLite can surface a raw constraint error', async () => {
    dataDir = makeTempDataDir(); const { orm, service } = build(); const { encounterId, first, second } = seed(orm);
    const firstPreview = await service.previewTokenBatch(encounterId, { placements: [{ combatantId: first.id, x: 50, y: 50 }, { combatantId: second.id, x: 60, y: 50 }], mapAspect: 1 }, dm, 'dm');
    await service.applyTokenBatch(encounterId, { previewToken: firstPreview.previewToken, idempotencyKey: 'shared-key' }, dm, 'dm');
    const secondPreview = await service.previewTokenBatch(encounterId, { placements: [{ combatantId: first.id, x: 40, y: 40 }, { combatantId: second.id, x: 60, y: 40 }], mapAspect: 1 }, dm, 'dm');
    await expect(service.applyTokenBatch(encounterId, { previewToken: secondPreview.previewToken, idempotencyKey: 'shared-key' }, dm, 'dm')).rejects.toThrow('already used for a different token batch');
  });

  it('refuses undo after a token differs from the batch after-state and replays the same undo key', async () => {
    dataDir = makeTempDataDir(); const { orm, service } = build(); const { encounterId, first, second } = seed(orm);
    const preview = await service.previewTokenBatch(encounterId, { placements: [{ combatantId: first.id, x: 50, y: 50 }, { combatantId: second.id, x: 60, y: 50 }], mapAspect: 1 }, dm, 'dm');
    const applied = await service.applyTokenBatch(encounterId, { previewToken: preview.previewToken, idempotencyKey: 'apply' }, dm, 'dm');
    expect(orm.select().from(encounterEvents).where(eq(encounterEvents.encounterId, encounterId)).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'token_batch',
          actor: 'DM',
          actorId: null,
          performedByJson: JSON.stringify({ userId: 'dev:dm', role: 'dm', kind: 'human' }),
        }),
      ]),
    );
    orm.update(combatants).set({ tokenX: 51 }).where(eq(combatants.id, first.id)).run();
    await expect(service.undoTokenBatch(encounterId, { undoToken: applied.undoToken, idempotencyKey: 'undo' }, dm, 'dm')).rejects.toThrow('changed after this batch');
    orm.update(combatants).set({ tokenX: 50 }).where(eq(combatants.id, first.id)).run();
    expect(await service.undoTokenBatch(encounterId, { undoToken: applied.undoToken, idempotencyKey: 'undo' }, dm, 'dm')).toEqual({ ok: true });
    const tokenBatchEvents = orm.select().from(encounterEvents).where(eq(encounterEvents.encounterId, encounterId)).all().filter((event) => event.type === 'token_batch');
    expect(tokenBatchEvents).toHaveLength(2);
    expect(tokenBatchEvents.every((event) => event.performedByJson === JSON.stringify({ userId: 'dev:dm', role: 'dm', kind: 'human' }))).toBe(true);
    expect(await service.undoTokenBatch(encounterId, { undoToken: applied.undoToken, idempotencyKey: 'undo' }, dm, 'dm')).toEqual({ ok: true, idempotent: true });
    expect(position(orm, first.id)).toEqual({ x: 10, y: 10 }); expect(position(orm, second.id)).toEqual({ x: 20, y: 10 });
  });

  it('blocks undo when an unselected token occupies a recorded before-position, with zero rollback', async () => {
    dataDir = makeTempDataDir(); const { orm, service } = build(); const { encounterId, first, second, obstacle } = seed(orm);
    const preview = await service.previewTokenBatch(encounterId, { placements: [{ combatantId: first.id, x: 50, y: 50 }, { combatantId: second.id, x: 60, y: 50 }], mapAspect: 1 }, dm, 'dm');
    const applied = await service.applyTokenBatch(encounterId, { previewToken: preview.previewToken, idempotencyKey: 'obstacle-undo-apply' }, dm, 'dm');
    orm.update(combatants).set({ tokenX: 10, tokenY: 10 }).where(eq(combatants.id, obstacle.id)).run();
    await expect(service.undoTokenBatch(encounterId, { undoToken: applied.undoToken, idempotencyKey: 'obstacle-undo' }, dm, 'dm')).rejects.toThrow('prior position');
    expect(position(orm, first.id)).toEqual({ x: 50, y: 50 }); expect(position(orm, second.id)).toEqual({ x: 60, y: 50 });
  });
});
