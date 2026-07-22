import request from 'supertest';
import { sql } from 'drizzle-orm';
import { DB, type DrizzleDb } from '../../src/db/db.module';
import { closeTestApp, createTestAppNoDevAuth, type TestAppContext } from '../test-app';

type Agent = ReturnType<typeof request.agent>;

/**
 * Issue #831: terminal inbox writes run against a real SQLite file through a
 * real listening HTTP server. Two independently authenticated campaign DMs
 * compete for each item, rather than sharing the DEV_AUTH identity.
 */
describe('inbox terminal idempotency (real SQLite + real HTTP)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let dmA: Agent;
  let dmB: Agent;
  let submitter: Agent;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    await ctx.app.listen(0);
    baseUrl = await ctx.app.getUrl();

    const admin = request.agent(baseUrl);
    expect(
      (await admin.post('/api/v1/auth/setup').send({ username: 'inbox-admin', password: 'admin-password-1' })).status,
    ).toBe(201);
    const dmAUser = await admin
      .post('/api/v1/users')
      .send({ username: 'inbox-dm-a', password: 'dm-a-password-1', displayName: 'DM Alpha' });
    const dmBUser = await admin
      .post('/api/v1/users')
      .send({ username: 'inbox-dm-b', password: 'dm-b-password-1', displayName: 'DM Beta' });
    const submitterUser = await admin
      .post('/api/v1/users')
      .send({ username: 'inbox-player', password: 'player-password-1', displayName: 'Player One' });
    expect([dmAUser.status, dmBUser.status, submitterUser.status]).toEqual([201, 201, 201]);

    dmA = request.agent(baseUrl);
    dmB = request.agent(baseUrl);
    submitter = request.agent(baseUrl);
    expect((await dmA.post('/api/v1/auth/login').send({ username: 'inbox-dm-a', password: 'dm-a-password-1' })).status).toBe(201);
    expect((await dmB.post('/api/v1/auth/login').send({ username: 'inbox-dm-b', password: 'dm-b-password-1' })).status).toBe(201);
    expect(
      (await submitter.post('/api/v1/auth/login').send({ username: 'inbox-player', password: 'player-password-1' })).status,
    ).toBe(201);

    const campaign = await dmA.post('/api/v1/campaigns').send({ name: 'Contested Inbox' });
    expect(campaign.status).toBe(201);
    campaignId = campaign.body.id;
    expect(
      (await dmA.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: dmBUser.body.id, role: 'dm' })).status,
    ).toBe(201);
    expect(
      (await dmA.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: submitterUser.body.id, role: 'player' })).status,
    ).toBe(201);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function submit(body: string): Promise<number> {
    const res = await submitter.post(`/api/v1/campaigns/${campaignId}/inbox`).send({ body });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function resolveAudits(noteId: number): Promise<unknown[]> {
    const res = await dmA.get(`/api/v1/campaigns/${campaignId}/audit?limit=200`);
    expect(res.status).toBe(200);
    return res.body.filter(
      (row: { action: string; entityId: number }) => row.action === 'inbox.resolve' && row.entityId === noteId,
    );
  }

  async function replyNotifications(body: string): Promise<unknown[]> {
    const res = await submitter.get('/api/v1/notifications?limit=200');
    expect(res.status).toBe(200);
    return res.body.filter(
      (row: { campaignId: number; type: string; body: string }) =>
        row.campaignId === campaignId && row.type === 'note_reply' && row.body === body,
    );
  }

  it('serializes competing DM terminal payloads; identical racers converge and conflicting racers 409', async () => {
    const noteId = await submit('Which rumor should become canon?');
    const resolvedPayload = { resolvedNote: 'The lighthouse rumor is canon.' };
    const dismissedPayload = { resolvedNote: 'dismissed' };
    const attempts = [
      ...Array.from({ length: 6 }, () => ({ agent: dmA, payload: resolvedPayload })),
      ...Array.from({ length: 6 }, () => ({ agent: dmB, payload: dismissedPayload })),
    ];

    const results = await Promise.all(
      attempts.map(({ agent, payload }) => agent.post(`/api/v1/notes/${noteId}/resolve`).send(payload)),
    );
    expect(results.every((res) => res.status === 201 || res.status === 409)).toBe(true);

    const successes = results.filter((res) => res.status === 201);
    const conflicts = results.filter((res) => res.status === 409);
    expect(successes).toHaveLength(6);
    expect(conflicts).toHaveLength(6);
    expect([...new Set(successes.map((res) => res.body.resolvedNote))]).toHaveLength(1);
    expect([...new Set(successes.map((res) => res.body.updatedAt))]).toHaveLength(1);
    for (const conflict of conflicts) {
      expect(conflict.body).toMatchObject({
        statusCode: 409,
        message: `Inbox item ${noteId} already has a different terminal result`,
      });
    }

    const winningBody = successes[0].body.resolvedNote as string;
    expect(await resolveAudits(noteId)).toHaveLength(1);
    expect(await replyNotifications(winningBody)).toHaveLength(1);
  });

  it('returns the stored result after a lost response retry, without duplicating effects', async () => {
    const noteId = await submit('Response-loss retry fixture');
    const payload = { resolvedNote: 'Recorded once despite the retry.', entityType: 'campaign', entityId: campaignId };

    // Model a client that loses the first response after the server commits: the
    // response is intentionally discarded and the same request is issued again
    // by the other DM without relying on anything from that response.
    const firstStatus = await dmA.post(`/api/v1/notes/${noteId}/resolve`).send(payload).then((res) => res.status);
    expect(firstStatus).toBe(201);
    const retry = await dmB.post(`/api/v1/notes/${noteId}/resolve`).send(payload);
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ id: noteId, resolved: true, ...payload });

    const sameRetry = await dmA.post(`/api/v1/notes/${noteId}/resolve`).send(payload);
    expect(sameRetry.status).toBe(201);
    expect(sameRetry.body).toEqual(retry.body);

    const firstConflict = await dmB
      .post(`/api/v1/notes/${noteId}/resolve`)
      .send({ resolvedNote: 'A competing terminal result.' });
    const secondConflict = await dmA
      .post(`/api/v1/notes/${noteId}/resolve`)
      .send({ resolvedNote: 'A competing terminal result.' });
    expect(firstConflict.status).toBe(409);
    expect(secondConflict.status).toBe(409);
    expect(secondConflict.body).toEqual(firstConflict.body);

    expect(await resolveAudits(noteId)).toHaveLength(1);
    expect(await replyNotifications(payload.resolvedNote)).toHaveLength(1);
  });

  it('keeps the terminal transition and audit durable when best-effort notification delivery fails', async () => {
    const noteId = await submit('Notification failure must not block canon');
    const payload = { resolvedNote: 'Canon survives notification failure.' };
    const db = ctx.app.get<DrizzleDb>(DB);
    db.run(sql`
      CREATE TRIGGER fail_inbox_reply_notification
      BEFORE INSERT ON notifications
      WHEN NEW.type = 'note_reply'
      BEGIN
        SELECT RAISE(ABORT, 'simulated notification failure');
      END
    `);

    try {
      const resolved = await dmA.post(`/api/v1/notes/${noteId}/resolve`).send(payload);
      expect(resolved.status).toBe(201);
      expect(resolved.body).toMatchObject({ id: noteId, resolved: true, ...payload });
      expect(await resolveAudits(noteId)).toHaveLength(1);
      expect(await replyNotifications(payload.resolvedNote)).toHaveLength(0);

      const retry = await dmB.post(`/api/v1/notes/${noteId}/resolve`).send(payload);
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(resolved.body);
      expect(await resolveAudits(noteId)).toHaveLength(1);
    } finally {
      db.run(sql`DROP TRIGGER IF EXISTS fail_inbox_reply_notification`);
    }
  });
});
