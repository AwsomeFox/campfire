import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import {
  auditLog,
  aiDmTranscriptEvents,
  characters,
  checkRequests,
  comments,
  diceRolls,
  entityRevisions,
  moderationEvidence,
  moderationMutes,
  moderationReports,
  notificationDigestQueue,
  notifications,
  notes,
  participantSupportPreferences,
  proposals,
  sessionZeroAcknowledgments,
  sessionZeroBoundarySubmissions,
  sessionZeroCharterVersions,
  sessionZeroGuardianConsents,
  sessionRsvps,
} from '../src/db/schema';
import { moderationEvidenceHash, moderationEvidenceMetadataHash, verifyModerationEvidence } from '../src/modules/moderation/moderation-evidence';

const OLD_LABEL = 'Old Handle';
const RENAMED_LABEL = 'New Handle';
const ROSTER_LABEL = 'Roster Handle';
const DELETED_LABEL = 'Deleted user';
const NEUTRAL_NOTIFICATION_TITLE = 'Campaign activity';
const NEUTRAL_NOTIFICATION_BODY = 'This notification has updated attribution.';

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
  let characterId: number;

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
      acknowledgments: db.select().from(sessionZeroAcknowledgments).where(eq(sessionZeroAcknowledgments.userId, stableUserId)).all(),
      boundaries: db.select().from(sessionZeroBoundarySubmissions).where(eq(sessionZeroBoundarySubmissions.submitterUserId, stableUserId)).all(),
      guardianConsents: db.select().from(sessionZeroGuardianConsents).where(eq(sessionZeroGuardianConsents.userId, stableUserId)).all(),
      supportPreferences: db.select().from(participantSupportPreferences).where(eq(participantSupportPreferences.ownerUserId, stableUserId)).all(),
      rolls: db.select().from(diceRolls).where(eq(diceRolls.rollerUserId, stableUserId)).all(),
      moderationReporter: db.select().from(moderationReports).where(eq(moderationReports.reporterUserId, stableUserId)).all(),
      moderationSubject: db.select().from(moderationReports).where(eq(moderationReports.subjectUserId, stableUserId)).all(),
      moderationEvidence: db.select().from(moderationEvidence).where(eq(moderationEvidence.authorUserId, stableUserId)).all(),
      moderationMutes: db.select().from(moderationMutes).where(eq(moderationMutes.userId, stableUserId)).all(),
      checkRequests: db.select().from(checkRequests).where(eq(checkRequests.requestedByUserId, stableUserId)).all(),
      transcript: db.select().from(aiDmTranscriptEvents).where(eq(aiDmTranscriptEvents.actorUserId, stableUserId)).all(),
      proposals: db.select().from(proposals).where(eq(proposals.proposerUserId, stableUserId)).all(),
      immediate: db.select().from(notifications).where(eq(notifications.actorUserId, stableUserId)).all(),
      deferred: db
        .select()
        .from(notificationDigestQueue)
        .where(eq(notificationDigestQueue.actorUserId, stableUserId))
        .all(),
    };
  }

  function expectRetainedAttribution(db: DrizzleDb, label: string, options: { expectSupportPreferences: boolean } = { expectSupportPreferences: true }) {
    const rows = retainedRows(db);
    expect(rows.notes).not.toHaveLength(0);
    expect(rows.comments).not.toHaveLength(0);
    expect(rows.revisionAuthors).not.toHaveLength(0);
    expect(rows.revisionReplacers).not.toHaveLength(0);
    expect(rows.rsvps).not.toHaveLength(0);
    expect(rows.acknowledgments).not.toHaveLength(0);
    expect(rows.boundaries).not.toHaveLength(0);
    expect(rows.guardianConsents).not.toHaveLength(0);
    if (options.expectSupportPreferences) expect(rows.supportPreferences).not.toHaveLength(0);
    else expect(rows.supportPreferences).toHaveLength(0);
    expect(rows.rolls).not.toHaveLength(0);
    expect(rows.moderationReporter).not.toHaveLength(0);
    expect(rows.moderationSubject).not.toHaveLength(0);
    expect(rows.moderationEvidence).not.toHaveLength(0);
    expect(rows.moderationMutes).not.toHaveLength(0);
    expect(rows.checkRequests).not.toHaveLength(0);
    expect(rows.transcript).not.toHaveLength(0);
    expect(rows.proposals).not.toHaveLength(0);
    expect(rows.immediate).not.toHaveLength(0);
    expect(rows.deferred).not.toHaveLength(0);
    expect(rows.notes.every((row) => row.authorName === label)).toBe(true);
    expect(rows.comments.every((row) => row.authorName === label)).toBe(true);
    expect(rows.revisionAuthors.every((row) => row.authorName === label)).toBe(true);
    expect(rows.revisionReplacers.every((row) => row.replacedByName === label)).toBe(true);
    expect(rows.rsvps.every((row) => row.userName === label)).toBe(true);
    expect(rows.acknowledgments.every((row) => row.userName === label)).toBe(true);
    expect(rows.boundaries.every((row) => row.submitterName === label)).toBe(true);
    expect(rows.guardianConsents.every((row) => row.userName === label)).toBe(true);
    expect(rows.supportPreferences.every((row) => row.ownerName === label)).toBe(true);
    expect(rows.rolls.every((row) => row.rollerName === label)).toBe(true);
    expect(rows.moderationReporter.every((row) => row.reporterName === label)).toBe(true);
    expect(rows.moderationSubject.every((row) => row.subjectName === label)).toBe(true);
    expect(rows.moderationEvidence.every((row) => row.authorName === label)).toBe(true);
    expect(
      rows.moderationEvidence
        .filter((row) => row.targetType === 'notification')
        .every((row) => row.content === NEUTRAL_NOTIFICATION_BODY),
    ).toBe(true);
    expect(rows.moderationEvidence.every((row) => verifyModerationEvidence({ campaignId: row.campaignId, targetType: row.targetType, targetId: row.targetId, reason: row.reason, source: row.source, authorUserId: row.authorUserId, authorName: row.authorName, recipientUserId: row.recipientUserId, anchorEntityType: row.anchorEntityType, anchorEntityId: row.anchorEntityId, revisionAt: row.revisionAt, capturedAt: row.capturedAt, context: JSON.parse(row.contextJson) as Record<string, unknown>, content: row.content }, row.contentHash, row.redactedAt, row.metadataHash) === 'intact')).toBe(true);
    expect(rows.moderationMutes.every((row) => row.userName === label)).toBe(true);
    expect(rows.checkRequests.every((row) => row.requestedByName === label)).toBe(true);
    expect(rows.transcript.every((row) => row.actorName === label)).toBe(true);
    expect(rows.proposals.every((row) => row.proposer === label)).toBe(true);
    for (const row of [...rows.immediate, ...rows.deferred]) {
      expect(row.actorName).toBe(label);
      expect(row.title).toBe(NEUTRAL_NOTIFICATION_TITLE);
      expect(row.body).toBe(NEUTRAL_NOTIFICATION_BODY);
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

    const db = ctx.app.get<DrizzleDb>(DB);
    // A real attributed safety hold must retain its stable actor id without
    // excluding that actor from table-wide delivery. Report the delivered bell
    // item too, so its moderation snapshot is covered by later privacy rewrites.
    expect((await member.post(`/api/v1/campaigns/${campaignId}/safety/hold`).send({ anonymous: false })).status).toBe(200);
    const safetyNotification = db
      .select()
      .from(notifications)
      .where(eq(notifications.campaignId, campaignId))
      .all()
      .find((row) => row.type === 'safety_hold' && row.userId === adminId);
    expect(safetyNotification).toBeDefined();
    expect(safetyNotification!.actorUserId).toBe(String(memberId));
    expect(safetyNotification!.actorName).toBe(OLD_LABEL);
    expect(safetyNotification!.body).toContain(OLD_LABEL);
    expect(
      db
        .select()
        .from(notifications)
        .where(eq(notifications.campaignId, campaignId))
        .all()
        .some((row) => row.type === 'safety_hold' && row.userId === memberId && row.actorUserId === String(memberId)),
    ).toBe(true);
    expect(
      (await admin
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports`)
        .send({ targetType: 'notification', targetId: safetyNotification!.id, reason: 'harassment' })).status,
    ).toBe(201);
    expect(
      db
        .select()
        .from(moderationEvidence)
        .where(eq(moderationEvidence.authorUserId, String(memberId)))
        .all()
        .some((row) => row.targetType === 'notification' && row.content.includes(OLD_LABEL)),
    ).toBe(true);

    const ts = '2099-01-01T00:00:00.000Z';
    characterId = db.insert(characters).values({ campaignId, name: 'Attribution character', createdAt: ts, updatedAt: ts }).returning().get().id;
    const charterVersionId = db.insert(sessionZeroCharterVersions).values({ campaignId, version: 1, lines: '[]', veils: '[]', safetyTools: '[]', houseRules: '', toneAndExpectations: '', material: false, changeSummary: '', publishedBy: String(adminId), publishedAt: ts }).returning().get().id;
    db.insert(sessionZeroAcknowledgments).values({ campaignId, versionId: charterVersionId, userId: String(memberId), userName: OLD_LABEL, state: 'acknowledged', note: '', createdAt: ts, updatedAt: ts }).run();
    db.insert(sessionZeroBoundarySubmissions).values({ campaignId, kind: 'line', text: 'A visible boundary', anonymous: false, submitterUserId: String(memberId), submitterName: OLD_LABEL, createdAt: ts, updatedAt: ts }).run();
    db.insert(sessionZeroGuardianConsents).values({ campaignId, userId: String(memberId), userName: OLD_LABEL, versionId: charterVersionId, guardianName: 'Guardian', guardianEmail: 'guardian@example.test', guardianRelationship: 'parent', minorAttested: true, status: 'pending', decisionNote: '', createdAt: ts, updatedAt: ts }).run();
    db.insert(participantSupportPreferences).values({ campaignId, ownerUserId: String(memberId), ownerName: OLD_LABEL, supportText: 'Need a break', visibility: 'table', aiUseConsent: false, createdAt: ts, updatedAt: ts }).run();
    const evidencePayload = { campaignId, targetType: 'conduct' as const, targetId: null, reason: 'conduct' as const, source: 'server_capture' as const, authorUserId: String(memberId), authorName: OLD_LABEL, recipientUserId: null, anchorEntityType: null, anchorEntityId: null, revisionAt: ts, content: 'Evidence content', context: {}, capturedAt: ts };
    const evidenceId = db.insert(moderationEvidence).values({ ...evidencePayload, contextJson: '{}', contentHash: moderationEvidenceHash(evidencePayload), metadataHash: moderationEvidenceMetadataHash(evidencePayload), redactedAt: null, redactedBy: null, redactionReason: '', expiresAt: null }).returning().get().id;
    db.insert(moderationReports).values({ campaignId, targetType: 'conduct', targetId: null, reporterUserId: String(memberId), reporterName: OLD_LABEL, subjectUserId: String(memberId), subjectName: OLD_LABEL, reason: 'conduct', details: '', status: 'open', resolution: null, resolutionNote: '', evidenceId, quarantined: false, escalationReason: '', createdAt: ts, updatedAt: ts }).run();
    db.insert(moderationMutes).values({ campaignId, userId: String(memberId), userName: OLD_LABEL, reason: 'test', createdBy: String(adminId), createdAt: ts, liftedAt: null, liftedBy: null }).run();
    db.insert(checkRequests).values({ campaignId, characterId, encounterId: null, checkId: 'save:DEX', checkLabel: 'DEX save', mode: 'flat', dc: null, consequence: '', status: 'pending', requestedByUserId: String(memberId), requestedByName: OLD_LABEL, rollId: null, createdAt: ts, resolvedAt: null }).run();
    db.insert(aiDmTranscriptEvents).values({ campaignId, seq: 99, eventId: 'account-attribution-transcript', kind: 'player.action', actorUserId: String(memberId), actorName: OLD_LABEL, clientRef: null, turnId: null, payload: '{}', visibility: 'all', createdAt: ts }).run();
    db.insert(proposals).values({ campaignId, entityType: 'note', entityId: null, action: 'create', payload: '{}', proposer: OLD_LABEL, proposerUserId: String(memberId), proposerToken: null, status: 'pending', resolvedBy: '', note: '', createdAt: ts, updatedAt: ts }).run();
    db.insert(notifications).values({ userId: adminId, campaignId, type: 'note_created', title: `${OLD_LABEL} left Old Handlex intact`, body: `${OLD_LABEL} said ${OLD_LABEL}`, entityType: 'note', entityId: noteId, commentId: null, data: null, actorName: OLD_LABEL, actorUserId: String(memberId), readAt: null, createdAt: ts }).run();
    db.insert(notificationDigestQueue).values({ userId: adminId, campaignId, type: 'schedule_rsvp', title: `${OLD_LABEL} at Old Handlex`, body: `${OLD_LABEL} said ${OLD_LABEL}`, entityType: 'scheduled_session', entityId: schedule.body.id, commentId: null, data: null, actorName: OLD_LABEL, actorUserId: String(memberId), reason: 'digest', createdAt: ts }).run();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('renames every retained public label while retaining stable ids', async () => {
    const renamed = await member.patch('/api/v1/me/preferences').send({ displayName: RENAMED_LABEL });
    expect(renamed.status).toBe(200);
    expect(renamed.body.displayName).toBe(RENAMED_LABEL);

    expectRetainedAttribution(ctx.app.get<DrizzleDb>(DB), RENAMED_LABEL);
  });

  it('uses the same transaction policy for a bulk-roster display-name change', async () => {
    const preview = await admin.post('/api/v1/admin/roster-import').send({
      dryRun: true,
      format: 'json',
      content: JSON.stringify([{ username: 'attribution-member', displayName: ROSTER_LABEL }]),
    });
    expect(preview.status).toBe(201);
    const committed = await admin.post('/api/v1/admin/roster-import').send({
      dryRun: false,
      format: 'json',
      content: '[]',
      rows: preview.body.commitRows,
      batchId: preview.body.batchId,
    });
    expect(committed.status).toBe(201);
    expect(committed.body.updated).toBe(1);
    expectRetainedAttribution(ctx.app.get<DrizzleDb>(DB), ROSTER_LABEL);
  });

  it('pseudonymizes every retained public label on deletion without rewriting audit identity', async () => {
    const deleted = await admin.delete(`/api/v1/users/${memberId}`);
    expect(deleted.status).toBe(204);

    const db = ctx.app.get<DrizzleDb>(DB);
    expectRetainedAttribution(db, DELETED_LABEL, { expectSupportPreferences: false });
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
