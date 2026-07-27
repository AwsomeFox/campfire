import fs from 'node:fs';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { count, eq } from 'drizzle-orm';
import { openDatabase, type DrizzleDb } from '../../src/db/db.module';
import {
  campaigns,
  comments,
  entityRevisions,
  moderationEvidence,
  moderationReports,
  notes,
} from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CommentsService } from '../../src/modules/comments/comments.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { NotesService } from '../../src/modules/notes/notes.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #601 — the moderation quarantine gate must be decided by the SAME
 * transaction that performs the write, and abuse evidence must only be recorded
 * on the path where the mutation actually commits.
 *
 * WHAT THIS SPEC DOES AND DOES NOT SIMULATE
 * -----------------------------------------
 * It does NOT pretend to be concurrent. Campfire runs one process against a
 * synchronous better-sqlite3 handle, and SQLite serializes write transactions —
 * two writers genuinely overlapping inside a transaction is not a state this
 * process can reach, so a test claiming to produce one would be theatre.
 *
 * The window that IS real is narrower and entirely expressible: every one of
 * these mutations reads its row, `await`s (anchor-visibility lookups, whisper
 * target resolution, revision commits), and only then opens the write
 * transaction. Each `await` yields to the event loop, so another request's
 * handler — a DM working the moderation queue — can and does run to completion in
 * between. The row the pre-transaction read observed is therefore not necessarily
 * the row that gets written.
 *
 * So this spec drives exactly that ordering, deterministically: the mutation's
 * PRE-TRANSACTION read is intercepted for one call, returns the real still-clean
 * row, and the DM's quarantine lands right behind it — precisely what the service
 * sees when a queue action interleaves at an await, with none of the timing luck.
 * Every subsequent read, the one inside the write transaction included, goes to
 * the untouched implementation against the real database. A correct implementation
 * re-decides the gate there and refuses; the pre-fix code consulted only the stale
 * pre-read and let the write through.
 *
 * The interception point is `getRowOrThrow`, each service's own public pre-read
 * entry point, never an internal of the transaction — so the assertions are about
 * the OUTCOME (write refused, row unchanged, evidence trail honest), not about
 * which private method the fix happens to call.
 *
 * Error semantics are asserted as SHIPPED, deliberately: comments answer 403 (the
 * author already sees a "withheld pending moderation review" placeholder, so a 404
 * would buy no privacy) and notes answer 404 (a quarantined note reads as
 * nonexistent on every path). The point of these tests is that the gate binds, not
 * that the two services agree on a status code.
 */
describe('#601 quarantine gate + evidence capture are transaction-bound (real SQLite, service layer)', () => {
  let dataDir: string;

  afterEach(() => {
    jest.restoreAllMocks();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const abuser: RequestUser = { id: '7', name: 'Abuser', serverRole: 'user', devRole: 'player' };

  function build() {
    dataDir = makeTempDataDir();
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const moderation = new ModerationService(orm, audit);
    const notifications = new NotificationsService(orm);
    const revisions = new RevisionsService(orm, moderation);
    const commentsService = new CommentsService(orm, audit, notifications, revisions, moderation);
    const notesService = new NotesService(orm, audit, notifications, revisions, moderation);
    return { orm, moderation, revisions, commentsService, notesService };
  }

  const ts = '2026-07-26T00:00:00.000Z';

  function seedCampaign(orm: DrizzleDb): number {
    const [row] = orm
      .insert(campaigns)
      .values({ name: 'Quarantine Race', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    return row.id;
  }

  /** A comment anchored to its own campaign (always-visible anchor — see anchor-visibility.ts). */
  function seedComment(orm: DrizzleDb, campaignId: number, body: string, deleted = false) {
    const [row] = orm
      .insert(comments)
      .values({
        campaignId,
        entityType: 'campaign',
        entityId: campaignId,
        authorUserId: abuser.id,
        authorName: abuser.name,
        body,
        createdAt: ts,
        updatedAt: ts,
        ...(deleted ? { deletedAt: ts, deletedBy: abuser.id } : {}),
      })
      .returning()
      .all();
    return row;
  }

  function seedNote(orm: DrizzleDb, campaignId: number, body: string, deleted = false) {
    const [row] = orm
      .insert(notes)
      .values({
        campaignId,
        authorUserId: abuser.id,
        authorName: abuser.name,
        kind: 'note',
        visibility: 'private',
        body,
        resolved: false,
        resolvedNote: '',
        createdAt: ts,
        updatedAt: ts,
        ...(deleted ? { deletedAt: ts } : {}),
      })
      .returning()
      .all();
    return row;
  }

  /**
   * File an unresolved report against a target so the pre-mutation evidence hook
   * considers it "watched" (see ModerationService.snapshotCommentIfWatched — the hook
   * is a deliberate no-op for unreported content).
   */
  function seedReport(orm: DrizzleDb, campaignId: number, targetType: string, targetId: number): void {
    const [evidence] = orm
      .insert(moderationEvidence)
      .values({
        campaignId,
        targetType,
        targetId,
        reason: 'report',
        source: 'server_capture',
        authorUserId: abuser.id,
        authorName: abuser.name,
        revisionAt: ts,
        content: 'at report time',
        contentHash: 'seed-hash',
        capturedAt: ts,
      })
      .returning()
      .all();
    orm
      .insert(moderationReports)
      .values({
        campaignId,
        targetType,
        targetId,
        reporterUserId: '9',
        reporterName: 'Victim',
        subjectUserId: abuser.id,
        subjectName: abuser.name,
        reason: 'harassment',
        status: 'open',
        evidenceId: evidence.id,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
  }

  function quarantineComment(orm: DrizzleDb, id: number): void {
    orm.update(comments).set({ quarantinedAt: ts }).where(eq(comments.id, id)).run();
  }

  function quarantineNote(orm: DrizzleDb, id: number): void {
    orm.update(notes).set({ quarantinedAt: ts }).where(eq(notes.id, id)).run();
  }

  function evidenceCount(orm: DrizzleDb): number {
    return orm.select({ value: count() }).from(moderationEvidence).all()[0]?.value ?? 0;
  }

  /**
   * Land the DM's quarantine in the await window immediately after the mutation's
   * PRE-TRANSACTION read — the exact interleaving described in the file header, with
   * the timing luck removed.
   *
   * The service's own `getRowOrThrow` (the public entry point all of these mutations
   * funnel their pre-read through) is intercepted for exactly ONE call: it returns the
   * real, still-clean row, and then the queue action lands. Every later call — the
   * database read inside the write transaction included — goes to the untouched
   * implementation, so the assertions are about the OUTCOME, not about which method
   * the fix happens to call.
   */
  function quarantineAfterPreRead(svc: CommentsService, orm: DrizzleDb, id: number): void;
  function quarantineAfterPreRead(svc: NotesService, orm: DrizzleDb, id: number): void;
  function quarantineAfterPreRead(svc: CommentsService | NotesService, orm: DrizzleDb, id: number): void {
    const isComments = svc instanceof CommentsService;
    jest.spyOn(svc as CommentsService, 'getRowOrThrow').mockImplementationOnce(async () => {
      const row = isComments
        ? orm.select().from(comments).where(eq(comments.id, id)).all()[0]
        : orm.select().from(notes).where(eq(notes.id, id)).all()[0];
      if (isComments) quarantineComment(orm, id);
      else quarantineNote(orm, id);
      return row as never;
    });
  }

  // -------------------------------------------------------------------------
  // Finding 1: the quarantine check must bind the write, not merely precede it.
  // -------------------------------------------------------------------------

  it('comments.update refuses when the quarantine lands after the pre-transaction read', async () => {
    const { orm, commentsService } = build();
    const campaignId = seedCampaign(orm);
    const row = seedComment(orm, campaignId, 'ORIGINAL ABUSE');
    quarantineAfterPreRead(commentsService, orm, row.id);

    await expect(
      commentsService.update(row.id, { body: 'sneaky rewrite' }, abuser, 'player'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const after = orm.select().from(comments).where(eq(comments.id, row.id)).all()[0];
    expect(after.body).toBe('ORIGINAL ABUSE');
  });

  it('comments.remove refuses when the quarantine lands after the pre-transaction read', async () => {
    const { orm, commentsService } = build();
    const campaignId = seedCampaign(orm);
    const row = seedComment(orm, campaignId, 'ORIGINAL ABUSE');
    quarantineAfterPreRead(commentsService, orm, row.id);

    await expect(commentsService.remove(row.id, abuser, 'player')).rejects.toBeInstanceOf(ForbiddenException);

    const after = orm.select().from(comments).where(eq(comments.id, row.id)).all()[0];
    expect(after.deletedAt).toBeNull();
  });

  it('comments.restore refuses when the quarantine lands after the pre-transaction read', async () => {
    const { orm, commentsService } = build();
    const campaignId = seedCampaign(orm);
    const row = seedComment(orm, campaignId, 'ORIGINAL ABUSE', true);
    quarantineAfterPreRead(commentsService, orm, row.id);

    await expect(commentsService.restore(row.id, abuser, 'player')).rejects.toBeInstanceOf(ForbiddenException);

    // Still tombstoned: a withheld comment must not be put back into view by a
    // request that raced the quarantine.
    const after = orm.select().from(comments).where(eq(comments.id, row.id)).all()[0];
    expect(after.deletedAt).toBe(ts);
  });

  it('notes.update refuses when the quarantine lands after the pre-transaction read', async () => {
    const { orm, notesService } = build();
    const campaignId = seedCampaign(orm);
    const row = seedNote(orm, campaignId, 'ORIGINAL WHISPER');
    quarantineAfterPreRead(notesService, orm, row.id);

    await expect(
      notesService.update(row.id, { body: 'sneaky rewrite' }, abuser, 'player'),
    ).rejects.toBeInstanceOf(NotFoundException);

    const after = orm.select().from(notes).where(eq(notes.id, row.id)).all()[0];
    expect(after.body).toBe('ORIGINAL WHISPER');
  });

  it('notes.update writes no revision for an edit its transaction refused', async () => {
    const { orm, notesService } = build();
    const campaignId = seedCampaign(orm);
    const row = seedNote(orm, campaignId, 'ORIGINAL WHISPER');
    quarantineAfterPreRead(notesService, orm, row.id);

    await expect(
      notesService.update(row.id, { body: 'sneaky rewrite' }, abuser, 'player'),
    ).rejects.toBeInstanceOf(NotFoundException);

    // The prose version tip is committed AFTER the write transaction, so a refused
    // edit leaves no history entry claiming prose that was never stored — and in
    // particular no copy of the withheld body sitting in entity_revisions.
    const revisions = orm.select().from(entityRevisions).all();
    expect(revisions).toHaveLength(0);
  });

  it('notes.remove refuses when the quarantine lands after the pre-transaction read', async () => {
    const { orm, notesService } = build();
    const campaignId = seedCampaign(orm);
    const row = seedNote(orm, campaignId, 'ORIGINAL WHISPER');
    quarantineAfterPreRead(notesService, orm, row.id);

    await expect(notesService.remove(row.id, abuser, 'player')).rejects.toBeInstanceOf(NotFoundException);

    const after = orm.select().from(notes).where(eq(notes.id, row.id)).all()[0];
    expect(after.deletedAt).toBeNull();
  });

  it('notes.restore refuses when the quarantine lands after the pre-transaction read', async () => {
    const { orm, notesService } = build();
    const campaignId = seedCampaign(orm);
    const row = seedNote(orm, campaignId, 'ORIGINAL WHISPER', true);
    quarantineAfterPreRead(notesService, orm, row.id);

    await expect(notesService.restore(row.id, abuser, 'player')).rejects.toBeInstanceOf(NotFoundException);

    const after = orm.select().from(notes).where(eq(notes.id, row.id)).all()[0];
    expect(after.deletedAt).toBe(ts);
  });

  /**
   * The revision-restore path had the identical shape: `assertTargetNotQuarantined`
   * ran before the write transaction opened, so a quarantine landing in between would
   * not have stopped the restore from writing the withheld prose back into the live
   * row — through a route that never touches CommentsService at all.
   *
   * `restore` has no public pre-read to intercept — its only await before the write
   * transaction IS the quarantine pre-flight — so that is where the queue action is
   * landed: the pre-flight runs once against a clean row, the DM quarantines in the
   * await window, and every later call consults the real database untouched. Only an
   * implementation that re-checks INSIDE the transaction leaves the live row alone.
   */
  it('revisions.restore refuses when the quarantine lands after the pre-flight check', async () => {
    const { orm, revisions } = build();
    const campaignId = seedCampaign(orm);
    const row = seedComment(orm, campaignId, 'CURRENT PROSE');
    orm
      .insert(entityRevisions)
      .values({
        campaignId,
        entityType: 'comment',
        entityId: row.id,
        snapshot: JSON.stringify({ body: 'WITHHELD PROSE' }),
        authorUserId: abuser.id,
        authorName: abuser.name,
        authorSource: 'human',
        authorSourceDetail: '',
        createdAt: ts,
        replacedByUserId: abuser.id,
        replacedByName: abuser.name,
        replacedBySource: 'human',
        replacedBySourceDetail: '',
        replacedAt: ts,
        authorshipKnown: true,
      })
      .run();
    const revisionId = orm.select().from(entityRevisions).all()[0].id;

    const gate = revisions as unknown as { assertTargetNotQuarantined: () => void };
    jest.spyOn(gate, 'assertTargetNotQuarantined').mockImplementationOnce(() => {
      quarantineComment(orm, row.id); // the DM's queue action, in the await window.
    });

    await expect(
      revisions.restore('comment', row.id, revisionId, abuser, 'dm'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // The load-bearing assertion: the withheld prose was NOT written back into the
    // live row. (Pre-fix, the restore committed and only the trailing history read
    // noticed the quarantine — a 403 handed back after the damage was already done.)
    const after = orm.select().from(comments).where(eq(comments.id, row.id)).all()[0];
    expect(after.body).toBe('CURRENT PROSE');
    expect(orm.select().from(entityRevisions).all()).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Finding 2: a mutation that never commits must leave no evidence behind.
  // -------------------------------------------------------------------------

  /**
   * `pre_edit` evidence is the record of what an edit overwrote. An edit rejected for
   * an `expectedUpdatedAt` mismatch overwrites nothing, so filing a snapshot for it
   * puts a mutation into the incident record that never happened — in a feature whose
   * entire value is that the trail is accurate.
   */
  it('a stale-write comment edit files no evidence for the edit it rejected', async () => {
    const { orm, commentsService } = build();
    const campaignId = seedCampaign(orm);
    const row = seedComment(orm, campaignId, 'REPORTED BODY');
    seedReport(orm, campaignId, 'comment', row.id);

    const before = evidenceCount(orm);
    expect(before).toBe(1); // the snapshot taken when the report was filed.

    await expect(
      commentsService.update(row.id, { body: 'rewrite' }, abuser, 'player', {
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(evidenceCount(orm)).toBe(before);
    expect(orm.select().from(comments).where(eq(comments.id, row.id)).all()[0].body).toBe('REPORTED BODY');
  });

  /**
   * The other half of the same guarantee: an edit that DOES commit must still be
   * captured. A fix that simply stopped snapshotting would pass the test above and
   * gut the feature.
   */
  it('a committing comment edit on a watched comment still files evidence', async () => {
    const { orm, commentsService } = build();
    const campaignId = seedCampaign(orm);
    const row = seedComment(orm, campaignId, 'REPORTED BODY');
    seedReport(orm, campaignId, 'comment', row.id);

    await commentsService.update(row.id, { body: 'rewrite' }, abuser, 'player', {
      expectedUpdatedAt: row.updatedAt,
    });

    const captured = orm
      .select()
      .from(moderationEvidence)
      .where(eq(moderationEvidence.reason, 'pre_edit'))
      .all();
    expect(captured).toHaveLength(1);
    expect(captured[0].content).toBe('REPORTED BODY');
  });
});
