import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import {
  auditLog,
  comments,
  diceRolls,
  entityRevisions,
  notificationDigestQueue,
  notifications,
  notes,
  sessionRsvps,
} from '../src/db/schema';

const OLD_LABEL = 'Old Handle';
const RENAMED_LABEL = 'New Handle';
const DELETED_LABEL = 'Deleted user';

/**
 * #842 — public display copies are synchronized by their durable user id.
 *
 * This uses real cookie sessions and the public write routes to seed each listed
 * history surface, then asserts the stored copies after a self-service rename and
 * an admin deletion. Direct DB reads are intentional: deferred notifications do
 * not yet have a public read endpoint, and the privacy promise applies before a
 * queued item can later be flushed into the recipient's bell.
 */
describe('account historical attribution privacy (e2e)', () => {
  let ctx: TestAppContext;
  let admin: ReturnType<typeof request.agent>;
  let member: ReturnType<typeof request.agent>;
  let adminId: number;
  let memberId: number;
  let campaignId: number;
  let noteId: number;

  function retainedRows(db: DrizzleDb) {
    const stableUserId = String(memberId);
    return {
      notes: db.select().from(notes).where(eq(notes.authorUserId, stableUserId)).all(),
      comments: db.select().from(comments).where(eq(comments.authorUserId, stableUserId)).all(),
      revisionAuthors: db
        .select()
        .from(entityRevisions)
        .where(eq(entityRevisions.authorUserId, stableUserId))
        .all(),
      revisionReplacers: db
        .select()
        .from(entityRevisions)
        .where(eq(entityRevisions.replacedByUserId, stableUserId))
        .all(),
      rsvps: db.select().from(sessionRsvps).where(eq(sessionRsvps.userId, stableUserId)).all(),
      rolls: db.select().from(diceRolls).where(eq(diceRolls.rollerUserId, stableUserId)).all(),
      immediate: db.select().from(notifications).where(eq(notifications.actorUserId, stableUserId)).all(),
      deferred: db
        .select()
        .from(notificationDigestQueue)
        .where(eq(notificationDigestQueue.actorUserId, stableUserId))
        .all(),
    };
  }

  function expectRetainedAttribution(db: DrizzleDb, label: string, oldLabel?: string) {
    const rows = retainedRows(db);
    expect(rows.notes).not.toHaveLength(0);
    expect(rows.comments).not.toHaveLength(0);
    expect(rows.revisionAuthors).not.toHaveLength(0);
    expect(rows.revisionReplacers).not.toHaveLength(0);
    expect(rows.rsvps).not.toHaveLength(0);
    expect(rows.rolls).not.toHaveLength(0);
    expect(rows.immediate).not.toHaveLength(0);
    expect(rows.deferred).not.toHaveLength(0);
    expect(rows.notes.every((row) => row.authorName === label)).toBe(true);
    expect(rows.comments.every((row) => row.authorName === label)).toBe(true);
    expect(rows.revisionAuthors.every((row) => row.authorName === label)).toBe(true);
    expect(rows.revisionReplacers.every((row) => row.replacedByName === label)).toBe(true);
    expect(rows.rsvps.every((row) => row.userName === label)).toBe(true);
    expect(rows.rolls.every((row) => row.rollerName === label)).toBe(true);
    for (const row of [...rows.immediate, ...rows.deferred]) {
      expect(row.actorName).toBe(label);
      if (oldLabel) {
        expect(row.title).not.toContain(oldLabel);
        expect(row.body).not.toContain(oldLabel);
      }
    }
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();
    admin = request.agent(server);
    member = request.agent(server);

    const setup = await admin
      .post('/api/v1/auth/setup')
      .send({ username: 'attribution-admin', password: 'admin-password-1', displayName: 'Administrator' });
    expect(setup.status).toBe(201);
    adminId = setup.body.user.id;

    const created = await admin
      .post('/api/v1/users')
      .send({ username: 'attribution-member', password: 'member-password-1', displayName: OLD_LABEL, serverRole: 'user' });
    expect(created.status).toBe(201);
    memberId = created.body.id;
    expect((await member.post('/api/v1/auth/login').send({ username: 'attribution-member', password: 'member-password-1' })).status).toBe(201);

    const campaign = await admin.post('/api/v1/campaigns').send({ name: 'Attribution Campaign' });
    expect(campaign.status).toBe(201);
    campaignId = campaign.body.id;
    expect((await admin.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: memberId, role: 'player' })).status).toBe(201);

    const session = await admin
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .send({ title: 'Attribution session', recap: 'A durable discussion anchor.' });
    expect(session.status).toBe(201);

    const sharedNote = await member
      .post(`/api/v1/campaigns/${campaignId}/notes`)
      .send({ body: 'Public historical note', visibility: 'party_shared' });
    expect(sharedNote.status).toBe(201);
    noteId = sharedNote.body.id;
    // Two content changes create both a revision author and a replacing actor row.
    expect((await member.patch(`/api/v1/notes/${noteId}`).send({ body: 'First revision' })).status).toBe(200);
    expect((await member.patch(`/api/v1/notes/${noteId}`).send({ body: 'Second revision' })).status).toBe(200);

    const comment = await member
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'session', entityId: session.body.id, body: 'Public historical comment' });
    expect(comment.status).toBe(201);

    const schedule = await admin
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .send({ scheduledAt: '2099-06-01T19:30:00Z', title: 'Attribution schedule' });
    expect(schedule.status).toBe(201);

    // The note created an immediate notification. Switch schedule delivery to
    // digest before the RSVP, so the deferred queue is also protected.
    expect(
      (await admin.put(`/api/v1/notifications/preferences/${campaignId}`).send({ categories: { schedule: 'digest' } })).status,
    ).toBe(200);
    expect((await member.put(`/api/v1/schedule/${schedule.body.id}/rsvp`).send({ status: 'yes', note: 'I am there' })).status).toBe(200);
    expect((await member.post(`/api/v1/campaigns/${campaignId}/roll`).send({ expr: '1d20', label: 'Attribution check' })).status).toBe(201);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('renames every retained public label while retaining stable ids', async () => {
    const renamed = await member.patch('/api/v1/me/preferences').send({ displayName: RENAMED_LABEL });
    expect(renamed.status).toBe(200);
    expect(renamed.body.displayName).toBe(RENAMED_LABEL);

    expectRetainedAttribution(ctx.app.get<DrizzleDb>(DB), RENAMED_LABEL, OLD_LABEL);
  });

  it('pseudonymizes every retained public label on deletion without rewriting audit identity', async () => {
    const deleted = await admin.delete(`/api/v1/users/${memberId}`);
    expect(deleted.status).toBe(204);

    const db = ctx.app.get<DrizzleDb>(DB);
    expectRetainedAttribution(db, DELETED_LABEL, RENAMED_LABEL);
    const rsvpAudit = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actor, String(memberId)))
      .all()
      .find((row) => row.action === 'schedule.rsvp');
    expect(rsvpAudit).toBeDefined();
    expect(rsvpAudit!.actor).toBe(String(memberId));
    expect(rsvpAudit!.detail).not.toContain(OLD_LABEL);
    expect(rsvpAudit!.detail).not.toContain(RENAMED_LABEL);

    const deleteAudit = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, memberId))
      .all()
      .find((row) => row.action === 'user.delete');
    expect(deleteAudit).toBeDefined();
    expect(deleteAudit!.actor).toBe(String(adminId));
    expect(deleteAudit!.detail).toBe(`user:${memberId}`);
    expect(deleteAudit!.detail).not.toContain(OLD_LABEL);
    expect(deleteAudit!.detail).not.toContain(RENAMED_LABEL);
  });
});
