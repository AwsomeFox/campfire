import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #601 — moderation: preserve abuse evidence and add a protected incident workflow.
 *
 * Real cookie sessions (not DEV_AUTH) throughout, because half of what #601 asks for is
 * about WHO someone is: the conflicted-DM rule needs a real campaign_members row to
 * decide that the reported member holds the dm role, and the former-member cases need
 * memberships that can actually be revoked. DEV_AUTH's synthetic `dev:<name>` identities
 * have neither.
 *
 * Cast:
 *   admin    — server admin (first user via /auth/setup); the break-glass principal.
 *   dmUser   — DM of the campaign; runs the moderation queue.
 *   victim   — files the reports.
 *   abuser   — writes the reported content.
 *   bystander— an ordinary player, used to prove evidence is not reachable by members.
 */
describe('Issue #601: moderation evidence + incident workflow (e2e)', () => {
  let ctx: TestAppContext;
  let server: import('http').Server;
  let admin: ReturnType<typeof request.agent>;
  let dmUser: ReturnType<typeof request.agent>;
  let victim: ReturnType<typeof request.agent>;
  let abuser: ReturnType<typeof request.agent>;
  let bystander: ReturnType<typeof request.agent>;
  let victimId: number;
  let abuserId: number;
  let bystanderId: number;
  let dmUserId: number;
  let campaignId: number;
  let sessionId: number;

  /** Direct DB handle — only for simulating time passing / out-of-band tampering. */
  function openDb(): InstanceType<typeof Database> {
    return new Database(path.join(ctx.dataDir, 'campfire.db'));
  }

  async function newUser(username: string, password: string) {
    const created = await admin.post('/api/v1/users').send({ username, password, serverRole: 'user' });
    expect(created.status).toBe(201);
    const agent = request.agent(server);
    const login = await agent.post('/api/v1/auth/login').send({ username, password });
    expect(login.status).toBe(201);
    return { agent, id: created.body.id as number };
  }

  /** Post a comment on the shared session thread as `agent`. */
  async function postComment(agent: ReturnType<typeof request.agent>, body: string): Promise<number> {
    const res = await agent
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .send({ entityType: 'session', entityId: sessionId, body });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  async function fileReport(
    agent: ReturnType<typeof request.agent>,
    body: Record<string, unknown>,
    campaign = campaignId,
  ) {
    return agent.post(`/api/v1/campaigns/${campaign}/moderation/reports`).send(body);
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    server = ctx.app.getHttpServer();

    admin = request.agent(server);
    const setup = await admin.post('/api/v1/auth/setup').send({ username: 'mod-admin', password: 'admin-password-1' });
    expect(setup.status).toBe(201);

    const dmRes = await newUser('mod-dm', 'dm-password-1');
    dmUser = dmRes.agent;
    dmUserId = dmRes.id;
    const victimRes = await newUser('mod-victim', 'victim-password-1');
    victim = victimRes.agent;
    victimId = victimRes.id;
    const abuserRes = await newUser('mod-abuser', 'abuser-password-1');
    abuser = abuserRes.agent;
    abuserId = abuserRes.id;
    const bystanderRes = await newUser('mod-bystander', 'bystander-password-1');
    bystander = bystanderRes.agent;
    bystanderId = bystanderRes.id;

    const camp = await dmUser.post('/api/v1/campaigns').send({ name: 'Moderation Table' });
    expect(camp.status).toBe(201);
    campaignId = camp.body.id;

    for (const id of [victimId, abuserId, bystanderId]) {
      const add = await dmUser.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: id, role: 'player' });
      expect(add.status).toBe(201);
    }

    const sess = await dmUser.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ title: 'Session One' });
    expect(sess.status).toBe(201);
    sessionId = sess.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // -------------------------------------------------------------------------
  // Bullet 2: integrity-protected snapshots, and the edit/delete race
  // -------------------------------------------------------------------------

  describe('evidence snapshots (#601 bullet 2)', () => {
    it('captures the reported comment verbatim, with a verifiable integrity hash', async () => {
      const commentId = await postComment(abuser, 'You are worthless and should leave this table.');

      const report = await fileReport(victim, {
        targetType: 'comment',
        targetId: commentId,
        reason: 'harassment',
        details: 'Targeted at me in the session thread.',
      });
      expect(report.status).toBe(201);
      expect(report.body.status).toBe('open');
      expect(report.body.subjectUserId).toBe(String(abuserId));
      expect(report.body.reporterUserId).toBe(String(victimId));
      // The report itself never carries the content — that is the whole access split.
      expect(JSON.stringify(report.body)).not.toContain('worthless');

      const evidence = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/evidence`,
      );
      expect(evidence.status).toBe(200);
      expect(evidence.body.content).toBe('You are worthless and should leave this table.');
      expect(evidence.body.integrity).toBe('intact');
      expect(evidence.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence.body.authorUserId).toBe(String(abuserId));
      expect(evidence.body.source).toBe('server_capture');
      expect(evidence.body.reason).toBe('report');
      // Revision + context: enough to situate the snapshot months later.
      expect(evidence.body.revisionAt).toBeTruthy();
      expect(evidence.body.anchorEntityType).toBe('session');
      expect(evidence.body.anchorEntityId).toBe(sessionId);
    });

    /**
     * THE EDIT RACE. The snapshot is taken inside the mutation's own transaction, so
     * an edit that lands after a report is filed cannot overwrite what was reported —
     * and the overwritten body is itself captured as a `pre_edit` snapshot.
     */
    it('an edit after a report captures the OVERWRITTEN body as pre_edit evidence', async () => {
      const commentId = await postComment(abuser, 'ORIGINAL abusive text alpha');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      expect(report.status).toBe(201);

      const edit = await abuser.patch(`/api/v1/comments/${commentId}`).send({ body: 'oops sorry, innocuous now' });
      expect(edit.status).toBe(200);
      expect(edit.body.body).toBe('oops sorry, innocuous now');

      const bundle = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/export`);
      expect(bundle.status).toBe(200);
      // The report-time snapshot still holds the original.
      expect(bundle.body.evidence.content).toBe('ORIGINAL abusive text alpha');
      expect(bundle.body.evidence.integrity).toBe('intact');
      // And the edit left its own pre_edit snapshot of exactly what it destroyed.
      const preEdit = bundle.body.additionalEvidence.filter((e: { reason: string }) => e.reason === 'pre_edit');
      expect(preEdit).toHaveLength(1);
      expect(preEdit[0].content).toBe('ORIGINAL abusive text alpha');
      expect(preEdit[0].integrity).toBe('intact');
    });

    /**
     * THE DELETE RACE, ordering A: the report lands first. The subsequent delete is
     * captured as pre_delete evidence, and the report-time snapshot is untouched.
     */
    it('a delete after a report captures pre_delete evidence and leaves the report snapshot intact', async () => {
      const commentId = await postComment(abuser, 'ORIGINAL abusive text bravo');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'threat_or_violence' });
      expect(report.status).toBe(201);

      const del = await abuser.delete(`/api/v1/comments/${commentId}`);
      expect(del.status).toBe(200);
      expect(del.body.body).toBe('[deleted]');

      const bundle = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/export`);
      expect(bundle.status).toBe(200);
      expect(bundle.body.evidence.content).toBe('ORIGINAL abusive text bravo');
      const preDelete = bundle.body.additionalEvidence.filter((e: { reason: string }) => e.reason === 'pre_delete');
      expect(preDelete).toHaveLength(1);
      expect(preDelete[0].content).toBe('ORIGINAL abusive text bravo');
      expect(preDelete[0].context.deletedAt).toBeNull();
    });

    /**
     * THE DELETE RACE, ordering B: the abuser deletes FIRST, the victim reports a
     * moment later. This is the interleaving the issue is really about, and it is
     * survivable because comments tombstone rather than hard-delete — the report path
     * reads the row (deleted or not) inside its own transaction and snapshots the real
     * body, even though every ordinary reader now sees "[deleted]".
     *
     * Note on what this test can and cannot prove: better-sqlite3 is synchronous and
     * single-threaded, so a genuinely concurrent interleaving is not expressible in a
     * single-process test. What is asserted is the property that makes the race safe —
     * evidence survives in BOTH orderings — plus the structural guarantee (capture and
     * mutation share one transaction) that removes the window between them.
     */
    it('a report filed AFTER the abuser deletes still captures the original body', async () => {
      const commentId = await postComment(abuser, 'ORIGINAL abusive text charlie');
      const del = await abuser.delete(`/api/v1/comments/${commentId}`);
      expect(del.status).toBe(200);

      // Every ordinary read now shows the tombstone placeholder.
      const asRead = await victim.get(`/api/v1/comments/${commentId}`);
      expect(asRead.status).toBe(200);
      expect(asRead.body.body).toBe('[deleted]');

      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      expect(report.status).toBe(201);

      const evidence = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/evidence`,
      );
      expect(evidence.status).toBe(200);
      expect(evidence.body.content).toBe('ORIGINAL abusive text charlie');
      expect(evidence.body.context.deletedAt).toBeTruthy();
    });

    it('reports a whisper the reporter received, and captures it with its recipient', async () => {
      const whisper = await abuser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'private nastiness delta', visibility: 'whisper', recipientUserId: String(victimId) });
      expect(whisper.status).toBe(201);

      const report = await fileReport(victim, { targetType: 'whisper', targetId: whisper.body.id, reason: 'harassment' });
      expect(report.status).toBe(201);

      const evidence = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/evidence`,
      );
      expect(evidence.status).toBe(200);
      expect(evidence.body.content).toBe('private nastiness delta');
      expect(evidence.body.recipientUserId).toBe(String(victimId));
      expect(evidence.body.context.visibility).toBe('whisper');
    });

    it('out-of-band tampering with a stored snapshot reads back as `tampered`', async () => {
      const commentId = await postComment(abuser, 'ORIGINAL abusive text echo');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'hate' });
      expect(report.status).toBe(201);

      const db = openDb();
      try {
        db.prepare('UPDATE moderation_evidence SET content = ? WHERE id = ?').run(
          'something much more flattering',
          report.body.evidenceId,
        );
      } finally {
        db.close();
      }

      const evidence = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/evidence`,
      );
      expect(evidence.status).toBe(200);
      expect(evidence.body.content).toBe('something much more flattering');
      // The digest no longer matches and nothing recorded a redaction — fail loud.
      expect(evidence.body.integrity).toBe('tampered');

      // …and the queue row surfaces the same verdict without exposing content.
      const queue = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports`);
      const row = queue.body.items.find((r: { id: number }) => r.id === report.body.id);
      expect(row.evidenceIntegrity).toBe('tampered');
    });
  });

  // -------------------------------------------------------------------------
  // Bullet 1: all six reportable surfaces
  // -------------------------------------------------------------------------

  describe('reportable surfaces (#601 bullet 1)', () => {
    it('accepts reporter-supplied content for AI narration and conduct', async () => {
      const narration = await fileReport(victim, {
        targetType: 'ai_narration',
        reason: 'sexual_content',
        content: 'The AI narrated something wildly inappropriate.',
      });
      expect(narration.status).toBe(201);
      const narrationEvidence = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${narration.body.id}/evidence`,
      );
      expect(narrationEvidence.body.source).toBe('reporter_supplied');
      expect(narrationEvidence.body.content).toContain('wildly inappropriate');

      const conduct = await fileReport(victim, {
        targetType: 'conduct',
        reason: 'harassment',
        content: 'Shouted slurs on voice chat during the session.',
        subjectUserId: String(abuserId),
      });
      expect(conduct.status).toBe(201);
      expect(conduct.body.subjectUserId).toBe(String(abuserId));
    });

    it('reports a notification the reporter received', async () => {
      // A party_shared note fans a notification out to every other member.
      const note = await abuser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'abusive party-wide note foxtrot', visibility: 'party_shared' });
      expect(note.status).toBe(201);

      const bell = await victim.get('/api/v1/notifications?limit=20');
      expect(bell.status).toBe(200);
      const items = bell.body.items ?? bell.body;
      const mine = items[0];
      expect(mine).toBeTruthy();

      const report = await fileReport(victim, { targetType: 'notification', targetId: mine.id, reason: 'harassment' });
      expect(report.status).toBe(201);

      // Someone else's notification is not reportable — the endpoint must not become
      // a read of other people's bells.
      const foreign = await fileReport(bystander, { targetType: 'notification', targetId: mine.id, reason: 'spam' });
      expect(foreign.status).toBe(404);
    });

    it('keeps reports of ordinary DM notifications in the campaign moderation queue', async () => {
      const note = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'DM-authored notification routing regression', visibility: 'party_shared' });
      expect(note.status).toBe(201);

      const bell = await victim.get('/api/v1/notifications?limit=20');
      expect(bell.status).toBe(200);
      const items = bell.body.items ?? bell.body;
      const mine = items.find(
        (item: { id: number; actorName: string; type: string }) => item.type === 'note_shared' && item.actorName === 'mod-dm',
      );
      expect(mine).toBeTruthy();

      const report = await fileReport(victim, { targetType: 'notification', targetId: mine.id, reason: 'harassment' });
      expect(report.status).toBe(201);
      expect(report.body.status).toBe('open');
      expect(report.body.subjectUserId).toBe('');
      const queue = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports`);
      expect(queue.status).toBe(200);
      expect(queue.body.items.some((item: { id: number }) => item.id === report.body.id)).toBe(true);
    });

    it('keeps an attributed safety-hold notification non-resolvable for moderation actions', async () => {
      const sqlite = openDb();
      let safetyNotificationId: number;
      try {
        const inserted = sqlite
          .prepare(
            `INSERT INTO notifications (user_id, campaign_id, type, title, body, entity_type, entity_id, comment_id, data, actor_name, actor_user_id, read_at, created_at)
             VALUES (?, ?, 'safety_hold', ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?)`,
          )
          .run(
            victimId,
            campaignId,
            'The table is paused',
            'A participant used the safety hold.',
            'mod-abuser',
            String(abuserId),
            new Date().toISOString(),
          );
        safetyNotificationId = Number(inserted.lastInsertRowid);
      } finally {
        sqlite.close();
      }

      const report = await fileReport(victim, {
        targetType: 'notification',
        targetId: safetyNotificationId!,
        reason: 'harassment',
      });
      expect(report.status).toBe(201);
      expect(report.body.subjectUserId).toBe('');
      const mute = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'mute' });
      expect(mute.status).toBe(400);
    });

    it('rejects reporter-supplied content for a server-captured target, and vice versa', async () => {
      const commentId = await postComment(abuser, 'a perfectly ordinary comment golf');
      const withContent = await fileReport(victim, {
        targetType: 'comment',
        targetId: commentId,
        reason: 'spam',
        content: 'I will substitute my own evidence, thanks',
      });
      expect(withContent.status).toBe(400);

      const missingContent = await fileReport(victim, { targetType: 'conduct', reason: 'other' });
      expect(missingContent.status).toBe(400);
    });

    it('cannot be used to probe for content the reporter cannot see', async () => {
      // A whisper between two OTHER members is invisible to the bystander, so a
      // report on it must 404 exactly as a GET would — never 403 (which would
      // confirm the whisper exists).
      const whisper = await abuser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'not for you hotel', visibility: 'whisper', recipientUserId: String(victimId) });
      expect(whisper.status).toBe(201);

      const probe = await fileReport(bystander, { targetType: 'whisper', targetId: whisper.body.id, reason: 'other' });
      expect(probe.status).toBe(404);

      // And a nonexistent id 404s identically.
      const missing = await fileReport(bystander, { targetType: 'whisper', targetId: 999_999, reason: 'other' });
      expect(missing.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Bullet 3: access separation
  // -------------------------------------------------------------------------

  describe('access separation (#601 bullet 3)', () => {
    let reportId: number;
    let commentId: number;

    beforeAll(async () => {
      commentId = await postComment(abuser, 'SENSITIVE EVIDENCE STRING india');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      expect(report.status).toBe(201);
      reportId = report.body.id;
    });

    it('an ordinary member cannot read evidence, even the reporter who filed it', async () => {
      for (const agent of [victim, bystander, abuser]) {
        const res = await agent.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/evidence`);
        expect(res.status).toBe(403);
      }
    });

    it('a member sees only their OWN reports in the queue listing', async () => {
      const asVictim = await victim.get(`/api/v1/campaigns/${campaignId}/moderation/reports`);
      expect(asVictim.status).toBe(200);
      expect(asVictim.body.items.length).toBeGreaterThan(0);
      expect(asVictim.body.items.every((r: { reporterUserId: string }) => r.reporterUserId === String(victimId))).toBe(true);

      const asBystander = await bystander.get(`/api/v1/campaigns/${campaignId}/moderation/reports`);
      expect(asBystander.status).toBe(200);
      expect(asBystander.body.items.some((r: { id: number }) => r.id === reportId)).toBe(false);
    });

    it('evidence content never travels on an ordinary campaign content endpoint', async () => {
      // The comment itself, the campaign audit log, and campaign search are the three
      // ordinary reads a DM has. None of them may carry the snapshot.
      const audit = await dmUser.get(`/api/v1/campaigns/${campaignId}/audit?limit=500`);
      expect(audit.status).toBe(200);
      expect(JSON.stringify(audit.body)).not.toContain('SENSITIVE EVIDENCE STRING india');
      // The audit trail DOES record that the snapshot was captured — just not its contents.
      expect(JSON.stringify(audit.body)).toContain('moderation.evidence.capture');

      const reportList = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports?limit=100`);
      expect(JSON.stringify(reportList.body)).not.toContain('SENSITIVE EVIDENCE STRING india');
    });

    it('every evidence read is audited with who read what, when', async () => {
      const before = await dmUser.get(`/api/v1/campaigns/${campaignId}/audit?limit=500&action=moderation.evidence.access`);
      const beforeCount = before.body.length;

      const read = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/evidence`);
      expect(read.status).toBe(200);

      const after = await dmUser.get(`/api/v1/campaigns/${campaignId}/audit?limit=500&action=moderation.evidence.access`);
      expect(after.body.length).toBe(beforeCount + 1);
      expect(after.body[0].actor).toBe(String(dmUserId));
      expect(after.body[0].entityId).toBe(read.body.id);
      expect(after.body[0].createdAt).toBeTruthy();
    });

    it('exporting an incident is audited distinctly from reading it', async () => {
      const res = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/export`);
      expect(res.status).toBe(200);
      const audit = await dmUser.get(`/api/v1/campaigns/${campaignId}/audit?limit=500&action=moderation.incident.export`);
      expect(audit.body.length).toBeGreaterThan(0);
      expect(audit.body[0].entityId).toBe(reportId);
    });
  });

  // -------------------------------------------------------------------------
  // Bullet 4: the DM queue, including quarantine that actually withholds
  // -------------------------------------------------------------------------

  describe('DM queue actions (#601 bullet 4)', () => {
    it('quarantine genuinely withholds a comment from every normal read', async () => {
      const commentId = await postComment(abuser, 'QUARANTINE ME juliet');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'hate' });
      const reportId = report.body.id;

      const act = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/actions`)
        .send({ action: 'quarantine', note: 'pending review' });
      expect(act.status).toBe(201);
      expect(act.body.quarantined).toBe(true);
      expect(act.body.status).toBe('acknowledged');

      // Withheld from the author, from other members, AND from the DM who did it.
      for (const agent of [abuser, victim, bystander, dmUser]) {
        const res = await agent.get(`/api/v1/comments/${commentId}`);
        expect(res.status).toBe(200);
        expect(res.body.body).toBe('[withheld pending moderation review]');
        expect(res.body.quarantinedAt).toBeTruthy();
      }

      // …and from the thread listing.
      const thread = await victim
        .get(`/api/v1/campaigns/${campaignId}/comments`)
        .query({ entityType: 'session', entityId: sessionId, limit: 100 });
      expect(thread.status).toBe(200);
      expect(JSON.stringify(thread.body)).not.toContain('QUARANTINE ME juliet');

      // …and from campaign search.
      const search = await dmUser.get(`/api/v1/campaigns/${campaignId}/search`).query({ q: 'juliet' });
      expect(search.status).toBe(200);
      expect(JSON.stringify(search.body)).not.toContain('QUARANTINE ME juliet');

      // The evidence path still has it — that is the only place it survives.
      const evidence = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/evidence`,
      );
      expect(evidence.body.content).toBe('QUARANTINE ME juliet');
    });

    /**
     * A quarantine the subject can edit or delete their way out of is not a
     * quarantine. In particular an edit would commit the withheld body into
     * entity_revisions (#157), where the author can read it straight back.
     */
    it('a quarantined comment is frozen: the author cannot edit, delete, or restore it', async () => {
      const commentId = await postComment(abuser, 'FROZEN CONTENT zulu');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'hate' });
      await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'quarantine' });

      const edited = await abuser.patch(`/api/v1/comments/${commentId}`).send({ body: 'sneaky rewrite' });
      expect(edited.status).toBe(403);
      const deleted = await abuser.delete(`/api/v1/comments/${commentId}`);
      expect(deleted.status).toBe(403);

      // …and the revision history side door is shut outright, not merely empty: the
      // history of a quarantined comment is refused rather than served-and-hoped-empty,
      // because a comment edited before it was quarantined DOES have its prior prose in
      // entity_revisions.
      const revisions = await abuser.get(`/api/v1/comments/${commentId}/revisions`);
      expect(revisions.status).toBe(403);
      expect(JSON.stringify(revisions.body)).not.toContain('FROZEN CONTENT zulu');

      // Lifting the quarantine hands control back to the author.
      await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'unquarantine' });
      const afterLift = await abuser.patch(`/api/v1/comments/${commentId}`).send({ body: 'now I can edit' });
      expect(afterLift.status).toBe(200);
    });

    it('quarantine withholds a whisper from its own recipient (the gap #601 names)', async () => {
      const whisper = await abuser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'WHISPER TO QUARANTINE kilo', visibility: 'whisper', recipientUserId: String(victimId) });
      expect(whisper.status).toBe(201);
      const noteId = whisper.body.id;

      const visibleBefore = await victim.get(`/api/v1/notes/${noteId}`);
      expect(visibleBefore.status).toBe(200);

      const report = await fileReport(victim, { targetType: 'whisper', targetId: noteId, reason: 'harassment' });
      const act = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'quarantine' });
      expect(act.status).toBe(201);

      // Gone for the recipient, the author, and the DM alike.
      for (const agent of [victim, abuser, dmUser]) {
        const res = await agent.get(`/api/v1/notes/${noteId}`);
        expect(res.status).toBe(404);
      }
      const list = await victim.get(`/api/v1/campaigns/${campaignId}/notes?limit=100`);
      expect(JSON.stringify(list.body)).not.toContain('WHISPER TO QUARANTINE kilo');

      // The author cannot restore it back into view by any ordinary path.
      const restore = await abuser.post(`/api/v1/notes/${noteId}/restore`);
      expect(restore.status).toBe(404);
    });

    it('mute stops the muted member posting comments AND whispers, and unmute lifts it', async () => {
      const commentId = await postComment(abuser, 'MUTE ME lima');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      const reportId = report.body.id;

      const muted = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/actions`)
        .send({ action: 'mute', note: 'cool off', muteHours: 24 });
      expect(muted.status).toBe(201);

      const blockedComment = await abuser
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .send({ entityType: 'session', entityId: sessionId, body: 'still talking' });
      expect(blockedComment.status).toBe(403);

      const blockedWhisper = await abuser
        .post(`/api/v1/campaigns/${campaignId}/notes`)
        .send({ body: 'still whispering', visibility: 'whisper', recipientUserId: String(victimId) });
      expect(blockedWhisper.status).toBe(403);

      const mutes = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/mutes`);
      expect(mutes.status).toBe(200);
      expect(mutes.body.some((m: { userId: string }) => m.userId === String(abuserId))).toBe(true);

      const unmuted = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/actions`)
        .send({ action: 'unmute' });
      expect(unmuted.status).toBe(201);

      const allowed = await abuser
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .send({ entityType: 'session', entityId: sessionId, body: 'talking again' });
      expect(allowed.status).toBe(201);
    });

    it('remove tombstones the content at source and snapshots it first', async () => {
      const commentId = await postComment(abuser, 'REMOVE ME mike');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'threat_or_violence' });

      const act = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'remove' });
      expect(act.status).toBe(201);

      const read = await victim.get(`/api/v1/comments/${commentId}`);
      expect(read.body.body).toBe('[withheld pending moderation review]');

      const bundle = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/export`);
      const preRemove = bundle.body.additionalEvidence.filter((e: { reason: string }) => e.reason === 'pre_remove');
      expect(preRemove).toHaveLength(1);
      expect(preRemove[0].content).toBe('REMOVE ME mike');
    });

    /**
     * A takedown the reported member can undo is not a takedown. `remove` soft-deletes,
     * and soft-delete is reversible by the author, so removal also sets the quarantine —
     * which is what makes both restore paths refuse.
     */
    it('the reported member cannot restore content the queue removed', async () => {
      const commentId = await postComment(abuser, 'RESTORE ME BACK mike');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });

      await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'remove' });

      const restore = await abuser.post(`/api/v1/comments/${commentId}/restore`);
      expect(restore.status).toBe(403);

      const read = await victim.get(`/api/v1/comments/${commentId}`);
      expect(read.body.body).toBe('[withheld pending moderation review]');
      expect(read.body.body).not.toContain('RESTORE ME BACK');
    });

    it('every queue action lands in the existing campaign audit log', async () => {
      const audit = await dmUser.get(`/api/v1/campaigns/${campaignId}/audit?limit=500`);
      const actions = new Set(audit.body.map((r: { action: string }) => r.action));
      for (const a of ['moderation.quarantine', 'moderation.mute', 'moderation.unmute', 'moderation.remove']) {
        expect(actions.has(a)).toBe(true);
      }
    });

    /** FALSE REPORT: rejecting must undo the suppression the report caused. */
    it('resolving a false report as `rejected` lifts the quarantine it caused', async () => {
      const commentId = await postComment(abuser, 'PERFECTLY FINE november');
      const report = await fileReport(bystander, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      const reportId = report.body.id;

      await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/actions`)
        .send({ action: 'quarantine' });
      const withheld = await victim.get(`/api/v1/comments/${commentId}`);
      expect(withheld.body.body).toBe('[withheld pending moderation review]');

      const resolved = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/actions`)
        .send({ action: 'resolve', resolution: 'rejected', note: 'no rule broken' });
      expect(resolved.status).toBe(201);
      expect(resolved.body.status).toBe('resolved');
      expect(resolved.body.resolution).toBe('rejected');
      expect(resolved.body.quarantined).toBe(false);

      const restored = await victim.get(`/api/v1/comments/${commentId}`);
      expect(restored.body.body).toBe('PERFECTLY FINE november');
      expect(restored.body.quarantinedAt).toBeNull();

      // Once resolved, the incident stops driving pre-mutation capture: an ordinary
      // later edit is not abuse evidence and must not be hoarded as such.
      const bundleBefore = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/export`);
      const countBefore = bundleBefore.body.additionalEvidence.length;
      const edit = await abuser.patch(`/api/v1/comments/${commentId}`).send({ body: 'edited after resolution' });
      expect(edit.status).toBe(200);
      const bundleAfter = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/export`);
      expect(bundleAfter.body.additionalEvidence.length).toBe(countBefore);
    });

    it('resolve requires an explicit resolution', async () => {
      const commentId = await postComment(abuser, 'needs a resolution oscar');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'spam' });
      const res = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'resolve' });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Quarantine has to hold on EVERY read path, not just the ones it was written
  // for. Each test below corresponds to a route that reached the withheld prose
  // around the toDomain / notes-filter chokepoints.
  // -------------------------------------------------------------------------

  describe('quarantine holds on every read path (#601 bullet 4)', () => {
    /** Quarantine a fresh comment and return its id + report id. */
    async function quarantinedComment(body: string): Promise<{ commentId: number; reportId: number }> {
      const commentId = await postComment(abuser, body);
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      const act = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'quarantine' });
      expect(act.status).toBe(201);
      return { commentId, reportId: report.body.id };
    }

    /**
     * Revision history is a separate table behind a separate controller, so the
     * placeholder in CommentsService.toDomain does nothing for it. An edited comment
     * has its prior body in entity_revisions; without a guard, the generic
     * /revisions route hands it back to any DM and lets them restore it.
     */
    it('does not expose a quarantined comment\'s prose through revision history', async () => {
      const commentId = await postComment(abuser, 'REVISION LEAK papa original');
      // Edit first, so there is a prior revision holding the original words.
      const edit = await abuser.patch(`/api/v1/comments/${commentId}`).send({ body: 'REVISION LEAK papa second' });
      expect(edit.status).toBe(200);

      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'quarantine' });

      // Neither the comment-scoped route nor the generic revisions route may serve it.
      const viaComment = await dmUser.get(`/api/v1/comments/${commentId}/revisions`);
      expect(viaComment.status).toBe(403);
      expect(JSON.stringify(viaComment.body)).not.toContain('REVISION LEAK papa');

      const viaGeneric = await dmUser.get(`/api/v1/revisions/comment/${commentId}`);
      expect(viaGeneric.status).toBe(403);
      expect(JSON.stringify(viaGeneric.body)).not.toContain('REVISION LEAK papa');
    });

    /**
     * The sharper half: restoring a pre-quarantine revision would write the withheld
     * prose straight back into the live row, lifting the quarantine through a route
     * that never touches CommentsService.
     */
    it('cannot restore a quarantined comment to a pre-quarantine revision', async () => {
      const commentId = await postComment(abuser, 'RESTORE LEAK quebec original');
      await abuser.patch(`/api/v1/comments/${commentId}`).send({ body: 'RESTORE LEAK quebec second' });
      const revs = await dmUser.get(`/api/v1/comments/${commentId}/revisions`);
      expect(revs.status).toBe(200);
      const revisionId = revs.body[0].id as number;

      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'quarantine' });

      const restore = await dmUser.post(`/api/v1/revisions/comment/${commentId}/${revisionId}/restore`);
      expect(restore.status).toBe(403);

      const read = await victim.get(`/api/v1/comments/${commentId}`);
      expect(read.body.body).toBe('[withheld pending moderation review]');
      expect(read.body.body).not.toContain('RESTORE LEAK quebec');
    });

    /**
     * A restore REWRITES the live prose without passing through CommentsService, so it
     * is the one edit path that could escape the pre-mutation evidence hook. Once an
     * incident is open, no further mutation of its subject may go unrecorded.
     */
    it('captures evidence when a watched comment is mutated by a revision restore', async () => {
      const commentId = await postComment(abuser, 'RESTORE HOOK xray original');
      const edit = await abuser.patch(`/api/v1/comments/${commentId}`).send({ body: 'RESTORE HOOK xray second' });
      expect(edit.status).toBe(200);
      const revs = await dmUser.get(`/api/v1/comments/${commentId}/revisions`);
      expect(revs.status).toBe(200);
      const revisionId = revs.body[0].id as number;

      // Report it, but do NOT quarantine — a restore on a reported-but-not-withheld
      // comment is exactly the mutation the hook exists to record.
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      const reportId = report.body.id;

      const before = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/export`);
      const countBefore = before.body.additionalEvidence.length;

      // The author's own route (the generic /revisions one is dm-gated for comments).
      const restore = await abuser.post(`/api/v1/comments/${commentId}/revisions/${revisionId}/restore`);
      expect(restore.status).toBe(201);

      const after = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/export`);
      expect(after.body.additionalEvidence.length).toBe(countBefore + 1);
      const captured = after.body.additionalEvidence[after.body.additionalEvidence.length - 1];
      // The snapshot records what the restore was about to overwrite.
      expect(captured.content).toBe('RESTORE HOOK xray second');
      expect(captured.reason).toBe('pre_edit');
      expect(captured.integrity).toBe('intact');
    });

    /**
     * Search bypasses toDomain on both the FTS predicate and the hydration select, so
     * it needs the filter repeated in both places — for notes as well as comments.
     */
    it('keeps quarantined content out of campaign search results', async () => {
      const { commentId } = await quarantinedComment('SEARCHABLE ABUSE romeo');
      expect(commentId).toBeGreaterThan(0);

      for (const agent of [victim, bystander, dmUser]) {
        const res = await agent.get(`/api/v1/campaigns/${campaignId}/search?q=romeo`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain('SEARCHABLE ABUSE');
      }
    });

    /**
     * A clone copies prose into a new campaign that has none of the reports justifying
     * the quarantine, and the copy loop does not carry the quarantine columns — so an
     * unfiltered clone is a one-click way to launder withheld content back into view.
     */
    it('does not carry quarantined content into a campaign clone', async () => {
      const { commentId } = await quarantinedComment('CLONE ME sierra abusive');
      expect(commentId).toBeGreaterThan(0);

      const clone = await dmUser.post(`/api/v1/campaigns/${campaignId}/clone`).send({ name: 'Cloned Table' });
      expect([200, 201]).toContain(clone.status);
      const cloneId = clone.body.id as number;

      // Export is the widest read of the clone available in one call — comments,
      // notes and revisions together — so it is the strongest single assertion that
      // nothing withheld came across.
      const cloned = await dmUser.get(`/api/v1/campaigns/${cloneId}/export`);
      expect(cloned.status).toBe(200);
      expect(JSON.stringify(cloned.body)).not.toContain('CLONE ME sierra');
    });

    /**
     * A notification body is an excerpt of the comment copied at post time. It is the
     * one surviving copy that reaches the REPORTER — the person the quarantine exists
     * to shield — so it has to go too.
     */
    it('withdraws notification excerpts of a quarantined comment', async () => {
      // A reply to the victim's comment notifies the victim, carrying an excerpt.
      const victimComment = await postComment(victim, 'a perfectly ordinary post victor');
      const reply = await abuser
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .send({ entityType: 'session', entityId: sessionId, parentId: victimComment, body: 'NOTIFY LEAK whiskey abusive' });
      expect(reply.status).toBe(201);
      const replyId = reply.body.id as number;

      const before = await victim.get('/api/v1/notifications');
      expect(before.status).toBe(200);
      expect(JSON.stringify(before.body)).toContain('NOTIFY LEAK whiskey');

      const report = await fileReport(victim, { targetType: 'comment', targetId: replyId, reason: 'harassment' });
      await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'quarantine' });

      const after = await victim.get('/api/v1/notifications');
      expect(after.status).toBe(200);
      expect(JSON.stringify(after.body)).not.toContain('NOTIFY LEAK whiskey');

      // The badge must not advertise an item the list will never show.
      const unread = await victim.get('/api/v1/notifications/unread-count');
      expect(unread.status).toBe(200);
      expect(unread.body.count).toBe(after.body.items.filter((n: { readAt: string | null }) => n.readAt === null).length);
    });

    /**
     * The campaign export ships every revision row INCLUDING live tips, and a live
     * tip's snapshot holds the entity's current prose — so an unfiltered export
     * carries the exact body the quarantine withholds.
     */
    it('does not ship quarantined prose in the campaign export', async () => {
      const commentId = await postComment(abuser, 'EXPORT LEAK tango original');
      await abuser.patch(`/api/v1/comments/${commentId}`).send({ body: 'EXPORT LEAK tango second' });
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'quarantine' });

      const exported = await dmUser.get(`/api/v1/campaigns/${campaignId}/export`);
      expect(exported.status).toBe(200);
      expect(JSON.stringify(exported.body)).not.toContain('EXPORT LEAK tango');
    });
  });

  // -------------------------------------------------------------------------
  // Bullet 7: former members
  // -------------------------------------------------------------------------

  describe('former members (#601 bullet 7)', () => {
    it('a report survives the SUBJECT leaving the campaign, and stays actionable', async () => {
      const leaver = await newUser('mod-leaver', 'leaver-password-1');
      const add = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: leaver.id, role: 'player' });
      expect(add.status).toBe(201);
      const memberId = add.body.id;

      const commentId = await postComment(leaver.agent, 'LEAVER ABUSE papa');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      expect(report.status).toBe(201);

      const removed = await dmUser.delete(`/api/v1/campaigns/${campaignId}/members/${memberId}`);
      expect([200, 204]).toContain(removed.status);

      // Evidence still readable, subject attribution preserved from the snapshot.
      const evidence = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/evidence`,
      );
      expect(evidence.status).toBe(200);
      expect(evidence.body.content).toBe('LEAVER ABUSE papa');
      expect(evidence.body.authorUserId).toBe(String(leaver.id));

      // The queue action still applies — and a mute on a former member BINDS if they
      // come back, which is the point of keying mutes on the user rather than the row.
      const muted = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'mute' });
      expect(muted.status).toBe(201);

      const readd = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: leaver.id, role: 'player' });
      expect(readd.status).toBe(201);
      const stillMuted = await leaver.agent
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .send({ entityType: 'session', entityId: sessionId, body: 'im back' });
      expect(stillMuted.status).toBe(403);
    });

    it("a report survives the REPORTER leaving, and the reporter's own view stops (403), not the incident", async () => {
      const quitter = await newUser('mod-quitter', 'quitter-password-1');
      const add = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/members`)
        .send({ userId: quitter.id, role: 'player' });
      const memberId = add.body.id;

      const commentId = await postComment(abuser, 'REPORTED BY QUITTER quebec');
      const report = await fileReport(quitter.agent, {
        targetType: 'comment',
        targetId: commentId,
        reason: 'harassment',
      });
      expect(report.status).toBe(201);

      const removed = await dmUser.delete(`/api/v1/campaigns/${campaignId}/members/${memberId}`);
      expect([200, 204]).toContain(removed.status);

      // The former member can no longer reach the campaign at all…
      const gone = await quitter.agent.get(`/api/v1/campaigns/${campaignId}/moderation/reports`);
      expect(gone.status).toBe(403);
      const cannotFile = await fileReport(quitter.agent, {
        targetType: 'comment',
        targetId: commentId,
        reason: 'harassment',
      });
      expect(cannotFile.status).toBe(403);

      // …but the incident they filed is untouched, with their name preserved.
      const stillThere = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}`,
      );
      expect(stillThere.status).toBe(200);
      expect(stillThere.body.reporterUserId).toBe(String(quitter.id));
      const evidence = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/evidence`,
      );
      expect(evidence.body.content).toBe('REPORTED BY QUITTER quebec');
    });
  });

  // -------------------------------------------------------------------------
  // Bullets 5 + 7: conflicted DM and break-glass
  // -------------------------------------------------------------------------

  describe('conflicted DM + break-glass (#601 bullets 5, 7)', () => {
    let conflictedReportId: number;

    it('a report about the DM is auto-escalated and never enters that DM’s queue', async () => {
      const dmComment = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .send({ entityType: 'session', entityId: sessionId, body: 'DM SAID SOMETHING AWFUL romeo' });
      expect(dmComment.status).toBe(201);

      const report = await fileReport(victim, {
        targetType: 'comment',
        targetId: dmComment.body.id,
        reason: 'harassment',
        details: 'The DM is the one doing this.',
      });
      expect(report.status).toBe(201);
      conflictedReportId = report.body.id;
      // Born escalated: it never spends a moment visible to the accused.
      expect(report.body.status).toBe('escalated');
      expect(report.body.escalatedAt).toBeTruthy();
      expect(report.body.escalationReason).toContain('dm role');

      const queue = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports?limit=100`);
      expect(queue.body.items.some((r: { id: number }) => r.id === conflictedReportId)).toBe(false);
    });

    it('the accused DM can neither read the incident nor act on it', async () => {
      const get = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${conflictedReportId}`);
      expect(get.status).toBe(404); // 404, not 403 — the accused learns nothing.

      const evidence = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${conflictedReportId}/evidence`,
      );
      expect(evidence.status).toBe(404);

      const act = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${conflictedReportId}/actions`)
        .send({ action: 'resolve', resolution: 'rejected' });
      expect(act.status).toBe(404);
    });

    it('the reporter can still see their own escalated report, but not its evidence', async () => {
      const mine = await victim.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${conflictedReportId}`);
      expect(mine.status).toBe(200);
      expect(mine.body.status).toBe('escalated');

      const evidence = await victim.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${conflictedReportId}/evidence`,
      );
      expect(evidence.status).toBe(403);
    });

    it('a reporter may escalate their own report when the DM sides against them', async () => {
      const commentId = await postComment(abuser, 'ESCALATE ME sierra');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      const escalated = await victim
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/actions`)
        .send({ action: 'escalate', note: 'the DM will not act' });
      expect(escalated.status).toBe(201);
      expect(escalated.body.status).toBe('escalated');

      // A non-reporter member cannot escalate someone else's report.
      const other = await postComment(abuser, 'not yours tango');
      const otherReport = await fileReport(victim, { targetType: 'comment', targetId: other, reason: 'spam' });
      const notYours = await bystander
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${otherReport.body.id}/actions`)
        .send({ action: 'escalate' });
      expect(notYours.status).toBe(404);
    });

    /**
     * The actions endpoint must not become an existence oracle. If a non-DM got 404
     * for "no such report" but 403 for "exists, but not for you", any member — the
     * SUBJECT above all — could enumerate ids and learn that a report about them
     * exists, which is exactly what the conflicted-DM 404 exists to deny.
     */
    it('does not leak whether a report exists to a member who did not file it', async () => {
      const commentId = await postComment(abuser, 'ORACLE PROBE uniform');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'harassment' });
      const realId = report.body.id as number;
      const missingId = realId + 100_000;

      // The subject of the report, and an uninvolved member, must not be able to tell
      // a real report id from a nonexistent one — on ANY verb.
      for (const agent of [abuser, bystander]) {
        for (const action of ['acknowledge', 'quarantine', 'remove', 'escalate', 'resolve']) {
          const real = await agent
            .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${realId}/actions`)
            .send({ action, resolution: 'upheld' });
          const missing = await agent
            .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${missingId}/actions`)
            .send({ action, resolution: 'upheld' });
          expect(real.status).toBe(404);
          expect(missing.status).toBe(404);
        }
      }

      // The report is untouched by all that probing.
      const still = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${realId}`);
      expect(still.status).toBe(200);
      expect(still.body.status).toBe('open');
    });

    it('break-glass refuses without a written justification, and is audited at BOTH scopes when used', async () => {
      const noReason = await admin
        .post(`/api/v1/admin/moderation/reports/${conflictedReportId}/break-glass`)
        .send({ justification: 'short' });
      expect(noReason.status).toBe(400);

      const bundle = await admin
        .post(`/api/v1/admin/moderation/reports/${conflictedReportId}/break-glass`)
        .send({ justification: 'Safeguarding review: DM accused of harassing a player.' });
      expect(bundle.status).toBe(201);
      expect(bundle.body.evidence.content).toBe('DM SAID SOMETHING AWFUL romeo');
      expect(bundle.body.evidence.integrity).toBe('intact');
      expect(bundle.body.report.id).toBe(conflictedReportId);

      // Server-scoped trail (campaign_id null) — the admin console's own view.
      const serverAudit = await admin.get('/api/v1/admin/audit?limit=100');
      const serverRow = serverAudit.body.find(
        (r: { action: string; entityId: number }) =>
          r.action === 'moderation.breakglass' && r.entityId === conflictedReportId,
      );
      expect(serverRow).toBeTruthy();
      expect(serverRow.detail).toContain('Safeguarding review');

      // Campaign-scoped trail — the campaign sees that an outsider read its incident.
      const campaignAudit = await admin.get(
        `/api/v1/campaigns/${campaignId}/audit?limit=500&action=moderation.breakglass`,
      );
      // The admin is not a member, so read it as the DM instead (the row is campaign
      // history, which is DM-readable; only the CONTENT is walled off).
      const asDm = await dmUser.get(`/api/v1/campaigns/${campaignId}/audit?limit=500&action=moderation.breakglass`);
      expect(asDm.status).toBe(200);
      expect(asDm.body.length).toBeGreaterThan(0);
      expect(asDm.body[0].detail).toContain('Safeguarding review');
      // And the campaign audit still carries no evidence content.
      expect(JSON.stringify(asDm.body)).not.toContain('DM SAID SOMETHING AWFUL romeo');
      expect([200, 403]).toContain(campaignAudit.status);
    });

    it('a non-admin cannot reach any break-glass route', async () => {
      for (const agent of [dmUser, victim, bystander]) {
        const list = await agent.get('/api/v1/admin/moderation/reports');
        expect(list.status).toBe(403);
        const glass = await agent
          .post(`/api/v1/admin/moderation/reports/${conflictedReportId}/break-glass`)
          .send({ justification: 'let me in please, I am curious' });
        expect(glass.status).toBe(403);
      }
    });

    it('the admin escalation list is metadata-only and is itself audited', async () => {
      const list = await admin.get('/api/v1/admin/moderation/reports?limit=100');
      expect(list.status).toBe(200);
      expect(list.body.items.some((r: { id: number }) => r.id === conflictedReportId)).toBe(true);
      expect(JSON.stringify(list.body)).not.toContain('DM SAID SOMETHING AWFUL romeo');

      const audit = await admin.get('/api/v1/admin/audit?limit=100');
      expect(audit.body.some((r: { action: string }) => r.action === 'moderation.admin.list')).toBe(true);
    });

    it('the admin resolves the escalated incident (the far end of the escalation path)', async () => {
      const resolved = await admin
        .post(`/api/v1/admin/moderation/reports/${conflictedReportId}/resolve`)
        .send({ action: 'resolve', resolution: 'upheld', note: 'DM warned; handoff arranged.' });
      expect(resolved.status).toBe(201);
      expect(resolved.body.status).toBe('resolved');
      expect(resolved.body.resolution).toBe('upheld');
    });
  });

  // -------------------------------------------------------------------------
  // Bullet 6: retention, redaction, expiry
  // -------------------------------------------------------------------------

  describe('retention / redaction / expiry (#601 bullet 6)', () => {
    it('inherits the audit retention policy and stamps an expiry on every snapshot', async () => {
      const policy = await admin.get('/api/v1/admin/moderation/retention');
      expect(policy.status).toBe(200);
      expect(policy.body.source).toBe('audit');
      expect(policy.body.days).toBeGreaterThan(0);

      const commentId = await postComment(abuser, 'RETENTION SUBJECT uniform');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'spam' });
      const evidence = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/evidence`,
      );
      expect(evidence.body.expiresAt).toBeTruthy();
      expect(Date.parse(evidence.body.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('an expired snapshot is redacted on read, keeping the incident record intact', async () => {
      const commentId = await postComment(abuser, 'EXPIRING CONTENT victor');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'sexual_content' });
      const reportId = report.body.id;
      const evidenceId = report.body.evidenceId;

      // Simulate the retention horizon passing. There is no way to express "one day
      // later" through the API, and the alternative — waiting — is not a test.
      const db = openDb();
      try {
        db.prepare('UPDATE moderation_evidence SET expires_at = ? WHERE id = ?').run(
          new Date(Date.now() - 60_000).toISOString(),
          evidenceId,
        );
      } finally {
        db.close();
      }

      const evidence = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}/evidence`);
      expect(evidence.status).toBe(200);
      expect(evidence.body.content).toBe('[redacted]');
      // Redaction is EXPECTED, not suspicious — it must not read as tampering.
      expect(evidence.body.integrity).toBe('redacted');
      expect(evidence.body.redactedAt).toBeTruthy();
      expect(evidence.body.redactionReason).toContain('retention expiry');
      // The original digest is preserved so a pre-redaction export can still be checked.
      expect(evidence.body.contentHash).toMatch(/^[0-9a-f]{64}$/);

      // The report itself survives: the record that an incident happened is never destroyed.
      const stillThere = await dmUser.get(`/api/v1/campaigns/${campaignId}/moderation/reports/${reportId}`);
      expect(stillThere.status).toBe(200);
      expect(stillThere.body.reason).toBe('sexual_content');
    });

    it('a DM can redact evidence early, with a recorded reason', async () => {
      const commentId = await postComment(abuser, 'REDACT ME EARLY whiskey');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'privacy' });

      const noReason = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/redact`)
        .send({});
      expect(noReason.status).toBe(400);

      const redacted = await dmUser
        .post(`/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/redact`)
        .send({ reason: 'depicts a minor; must not be retained' });
      expect(redacted.status).toBe(201);
      expect(redacted.body.content).toBe('[redacted]');
      expect(redacted.body.integrity).toBe('redacted');

      const audit = await dmUser.get(`/api/v1/campaigns/${campaignId}/audit?limit=500&action=moderation.evidence.redact`);
      expect(audit.body.length).toBeGreaterThan(0);
      expect(audit.body[0].detail).toContain('depicts a minor');
      expect(JSON.stringify(audit.body)).not.toContain('REDACT ME EARLY whiskey');
    });

    it('the admin sweep redacts every expired snapshot eagerly and is idempotent', async () => {
      const commentId = await postComment(abuser, 'SWEEP ME xray');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'spam' });

      const db = openDb();
      try {
        db.prepare('UPDATE moderation_evidence SET expires_at = ? WHERE id = ?').run(
          new Date(Date.now() - 60_000).toISOString(),
          report.body.evidenceId,
        );
      } finally {
        db.close();
      }

      const first = await admin.post('/api/v1/admin/moderation/retention/sweep').send({});
      expect(first.status).toBe(201);
      expect(first.body.redacted).toBeGreaterThan(0);

      const second = await admin.post('/api/v1/admin/moderation/retention/sweep').send({});
      expect(second.status).toBe(201);
      expect(second.body.redacted).toBe(0);

      const evidence = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/evidence`,
      );
      expect(evidence.body.content).toBe('[redacted]');
    });

    it('an explicit moderation retention override takes precedence over the audit policy', async () => {
      const updated = await admin.patch('/api/v1/admin/moderation/retention').send({ days: 30 });
      expect(updated.status).toBe(200);
      expect(updated.body.days).toBe(30);
      expect(updated.body.source).toBe('settings');

      const commentId = await postComment(abuser, 'THIRTY DAY RETENTION yankee');
      const report = await fileReport(victim, { targetType: 'comment', targetId: commentId, reason: 'spam' });
      const evidence = await dmUser.get(
        `/api/v1/campaigns/${campaignId}/moderation/reports/${report.body.id}/evidence`,
      );
      const horizon = Date.parse(evidence.body.expiresAt) - Date.parse(evidence.body.capturedAt);
      expect(Math.round(horizon / (24 * 60 * 60 * 1000))).toBe(30);

      const audit = await admin.get('/api/v1/admin/audit?limit=50');
      expect(audit.body.some((r: { action: string }) => r.action === 'moderation.retention.update')).toBe(true);
    });
  });
});
