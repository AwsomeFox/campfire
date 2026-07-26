import request from 'supertest';
import type { NotificationCampaignPreferences, NotificationPreferences } from '@campfire/schema';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { SessionRemindersService } from '../src/modules/sessions/session-reminders.service';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #789 — notification preferences: per-campaign category delivery modes
 * (immediate/digest/muted), quiet hours (with the always-on critical override),
 * digest deferral + flush, deduplicated session reminders, and unanswered-RSVP
 * nudges. Real cookie sessions — notifications hang off real users.id.
 */
type Notification = { id: number; type: string; title: string; campaignId: number };

describe('notification preferences (issue #789, e2e)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>;
  let player: ReturnType<typeof request.agent>;
  let playerId: number;
  let campaignA: number;
  let campaignB: number;

  async function listFor(agent: ReturnType<typeof request.agent>): Promise<Notification[]> {
    const res = await agent.get('/api/v1/notifications');
    expect(res.status).toBe(200);
    return Array.isArray(res.body) ? res.body : (res.body.items ?? res.body);
  }
  const ofType = (rows: Notification[], type: string) => rows.filter((n) => n.type === type);

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'np-admin', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'np-dm', password: 'password-dm-1', displayName: 'Dana DM' });
    const createPlayer = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'np-player', password: 'password-pl-1', displayName: 'Pat Player' });
    playerId = createPlayer.body.id;

    dm = request.agent(server);
    await dm.post('/api/v1/auth/login').send({ username: 'np-dm', password: 'password-dm-1' });
    player = request.agent(server);
    await player.post('/api/v1/auth/login').send({ username: 'np-player', password: 'password-pl-1' });

    campaignA = (await dm.post('/api/v1/campaigns').send({ name: 'Keep Alpha' })).body.id;
    campaignB = (await dm.post('/api/v1/campaigns').send({ name: 'Keep Beta' })).body.id;
    await dm.post(`/api/v1/campaigns/${campaignA}/members`).send({ userId: playerId, role: 'player' });
    await dm.post(`/api/v1/campaigns/${campaignB}/members`).send({ userId: playerId, role: 'player' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('preference CRUD', () => {
    it('lists one entry per membership with sensible defaults (all immediate, critical always-on)', async () => {
      const res = await player.get('/api/v1/notifications/preferences');
      expect(res.status).toBe(200);
      const body = res.body as NotificationPreferences;
      const ids = body.campaigns.map((c) => c.campaignId).sort((a, b) => a - b);
      expect(ids).toEqual([campaignA, campaignB].sort((a, b) => a - b));
      const a = body.campaigns.find((c) => c.campaignId === campaignA)!;
      expect(a.campaignName).toBe('Keep Alpha');
      expect(a.categories.recaps).toBe('immediate');
      expect(a.categories.access).toBe('immediate');
      expect(a.categories.security).toBe('immediate');
      expect(a.quietHours).toEqual({ enabled: false, startMinute: 1320, endMinute: 420, timezone: 'UTC' });
    });

    it('updates one campaign without touching the other (multi-campaign isolation)', async () => {
      const put = await player
        .put(`/api/v1/notifications/preferences/${campaignA}`)
        .send({ categories: { recaps: 'muted', quests: 'digest' }, quietHours: { enabled: true, timezone: 'Asia/Tokyo' } });
      expect(put.status).toBe(200);
      const a = put.body as NotificationCampaignPreferences;
      expect(a.categories.recaps).toBe('muted');
      expect(a.categories.quests).toBe('digest');
      expect(a.quietHours.enabled).toBe(true);
      expect(a.quietHours.timezone).toBe('Asia/Tokyo');

      const all = (await player.get('/api/v1/notifications/preferences')).body as NotificationPreferences;
      const b = all.campaigns.find((c) => c.campaignId === campaignB)!;
      expect(b.categories.recaps).toBe('immediate'); // untouched
      expect(b.quietHours.enabled).toBe(false);
    });

    it('ignores attempts to change a critical (access/security) category', async () => {
      const put = await player
        .put(`/api/v1/notifications/preferences/${campaignA}`)
        .send({ categories: { access: 'muted', security: 'muted' } });
      expect(put.status).toBe(200);
      const a = put.body as NotificationCampaignPreferences;
      expect(a.categories.access).toBe('immediate');
      expect(a.categories.security).toBe('immediate');
    });

    it('404s when updating a campaign the caller is not a member of', async () => {
      const other = (await dm.post('/api/v1/campaigns').send({ name: 'Not Yours' })).body.id;
      const put = await player.put(`/api/v1/notifications/preferences/${other}`).send({ categories: { recaps: 'muted' } });
      expect(put.status).toBe(404);
    });

    it('rejects an unrecognized body key (strict DTO) and a bad mode', async () => {
      expect((await player.put(`/api/v1/notifications/preferences/${campaignA}`).send({ nope: 1 })).status).toBe(400);
      expect(
        (await player.put(`/api/v1/notifications/preferences/${campaignA}`).send({ categories: { recaps: 'sometimes' } })).status,
      ).toBe(400);
    });

    it('requires auth', async () => {
      const anon = request(ctx.app.getHttpServer());
      expect((await anon.get('/api/v1/notifications/preferences')).status).toBe(401);
      expect((await anon.put(`/api/v1/notifications/preferences/${campaignA}`).send({})).status).toBe(401);
    });
  });

  describe('fan-out gating (immediate / muted / digest)', () => {
    it('muted category is never delivered; an immediate campaign still delivers', async () => {
      // recaps is muted in A (set above) but immediate in B.
      await dm
        .post(`/api/v1/campaigns/${campaignA}/sessions`)
        .send({ number: 1, title: 'A recap', recap: 'Alpha session happened.' });
      await dm
        .post(`/api/v1/campaigns/${campaignB}/sessions`)
        .send({ number: 1, title: 'B recap', recap: 'Beta session happened.' });

      const recaps = ofType(await listFor(player), 'recap_posted');
      expect(recaps.some((n) => n.campaignId === campaignB)).toBe(true);
      expect(recaps.some((n) => n.campaignId === campaignA)).toBe(false);
    });

    it('digest category is deferred until flushed, then delivered', async () => {
      // quests is digest in A. Completing a visible quest would normally ping immediately.
      const quest = await dm.post(`/api/v1/campaigns/${campaignA}/quests`).send({ title: 'Digest quest', hidden: false });
      await dm.post(`/api/v1/quests/${quest.body.id}/status`).send({ status: 'completed' });

      // Not delivered yet.
      expect(ofType(await listFor(player), 'quest_updated').some((n) => n.campaignId === campaignA)).toBe(false);

      // Flush at an instant outside campaign A's quiet-hours window (set to
      // 22:00-07:00 Asia/Tokyo by the CRUD test) — 03:00 UTC == 12:00 JST.
      const notifications = ctx.app.get(NotificationsService);
      const flushed = await notifications.flushDigests(Date.UTC(2021, 5, 15, 3, 0, 0, 0));
      expect(flushed.delivered).toBeGreaterThanOrEqual(1);

      expect(ofType(await listFor(player), 'quest_updated').some((n) => n.campaignId === campaignA)).toBe(true);
    });
  });

  describe('quiet hours + always-on critical notices', () => {
    let campaignQ: number;

    // A quiet-hours window in UTC that is guaranteed to contain "now".
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const startMinute = nowMin;
    const endMinute = (nowMin + 60) % 1440;
    // An instant OUTSIDE that window (used to flush held items).
    const outsideMin = (endMinute + 120) % 1440;
    const outsideMs = Date.UTC(2021, 5, 15, Math.floor(outsideMin / 60), outsideMin % 60);

    beforeAll(async () => {
      campaignQ = (await dm.post('/api/v1/campaigns').send({ name: 'Quiet Keep' })).body.id;
      await dm.post(`/api/v1/campaigns/${campaignQ}/members`).send({ userId: playerId, role: 'player' });
      await player
        .put(`/api/v1/notifications/preferences/${campaignQ}`)
        .send({ quietHours: { enabled: true, startMinute, endMinute, timezone: 'UTC' } });
    });

    it('defers a non-critical immediate notification during quiet hours, then flushes it after', async () => {
      const notifications = ctx.app.get(NotificationsService);
      await notifications.notifyUser(playerId, campaignQ, null, { type: 'note_shared', title: 'Held during quiet hours' });

      // Held: not in the list while inside the window.
      expect((await listFor(player)).some((n) => n.title === 'Held during quiet hours')).toBe(false);

      // Flushing at an instant OUTSIDE the window releases it.
      const flushed = await notifications.flushDigests(outsideMs);
      expect(flushed.delivered).toBeGreaterThanOrEqual(1);
      expect((await listFor(player)).some((n) => n.title === 'Held during quiet hours')).toBe(true);
    });

    it('ALWAYS delivers critical (security/access) notices immediately, ignoring quiet hours', async () => {
      const notifications = ctx.app.get(NotificationsService);
      await notifications.notifyUser(playerId, campaignQ, null, { type: 'ai_dm_alert', title: 'Critical security notice' });
      // Delivered right now despite the active quiet-hours window.
      expect((await listFor(player)).some((n) => n.title === 'Critical security notice')).toBe(true);
    });
  });
});

describe('session reminders + RSVP nudges (issue #789, e2e)', () => {
  let ctx: TestAppContext;
  let dm: ReturnType<typeof request.agent>;
  let player: ReturnType<typeof request.agent>;
  let playerId: number;
  let campaignId: number;

  type N = { id: number; type: string; title: string; entityId: number | null };
  async function listFor(agent: ReturnType<typeof request.agent>): Promise<N[]> {
    const res = await agent.get('/api/v1/notifications');
    expect(res.status).toBe(200);
    return Array.isArray(res.body) ? res.body : (res.body.items ?? res.body);
  }
  const ofType = (rows: N[], type: string) => rows.filter((n) => n.type === type);

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    const adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'rem-admin', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'rem-dm', password: 'password-dm-1', displayName: 'Dana DM' });
    playerId = (
      await adminAgent.post('/api/v1/users').send({ username: 'rem-player', password: 'password-pl-1', displayName: 'Pat Player' })
    ).body.id;

    dm = request.agent(server);
    await dm.post('/api/v1/auth/login').send({ username: 'rem-dm', password: 'password-dm-1' });
    player = request.agent(server);
    await player.post('/api/v1/auth/login').send({ username: 'rem-player', password: 'password-pl-1' });

    campaignId = (await dm.post('/api/v1/campaigns').send({ name: 'Reminder Keep' })).body.id;
    await dm.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('sends one reminder + one nudge for an upcoming night, and never double-sends on repeat/reschedule', async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // ~1h out
    const sched = await dm.post(`/api/v1/campaigns/${campaignId}/schedule`).send({ scheduledAt: soon, title: 'Game night' });
    expect(sched.status).toBe(201);
    const scheduleId = sched.body.id as number;

    const reminders = ctx.app.get(SessionRemindersService);
    const first = await reminders.runReminderSweep();
    expect(first.reminders).toBeGreaterThanOrEqual(1);
    expect(first.nudges).toBeGreaterThanOrEqual(1);

    const remindersForPlayer = ofType(await listFor(player), 'session_reminder').filter((n) => n.entityId === scheduleId);
    const nudgesForPlayer = ofType(await listFor(player), 'rsvp_nudge').filter((n) => n.entityId === scheduleId);
    expect(remindersForPlayer).toHaveLength(1);
    expect(nudgesForPlayer).toHaveLength(1);

    // A retried sweep must NOT double-send.
    const second = await reminders.runReminderSweep();
    expect(second.reminders).toBe(0);
    expect(second.nudges).toBe(0);
    expect(ofType(await listFor(player), 'session_reminder').filter((n) => n.entityId === scheduleId)).toHaveLength(1);

    // Rescheduling the night must NOT resend the reminder (dedup on schedule id).
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await dm.patch(`/api/v1/schedule/${scheduleId}`).send({ scheduledAt: later });
    const third = await reminders.runReminderSweep();
    expect(third.reminders).toBe(0);
    expect(ofType(await listFor(player), 'session_reminder').filter((n) => n.entityId === scheduleId)).toHaveLength(1);
  });

  it('does not nudge a member who has already RSVP\'d', async () => {
    const soon = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    const sched = await dm.post(`/api/v1/campaigns/${campaignId}/schedule`).send({ scheduledAt: soon, title: 'Answered night' });
    const scheduleId = sched.body.id as number;
    await player.put(`/api/v1/schedule/${scheduleId}/rsvp`).send({ status: 'yes' });

    const reminders = ctx.app.get(SessionRemindersService);
    await reminders.runReminderSweep();

    const rows = await listFor(player);
    expect(ofType(rows, 'session_reminder').filter((n) => n.entityId === scheduleId)).toHaveLength(1);
    expect(ofType(rows, 'rsvp_nudge').filter((n) => n.entityId === scheduleId)).toHaveLength(0);
  });

  it('does not remind for a night outside the lead window', async () => {
    const farOut = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days
    const sched = await dm.post(`/api/v1/campaigns/${campaignId}/schedule`).send({ scheduledAt: farOut, title: 'Distant night' });
    const scheduleId = sched.body.id as number;

    const reminders = ctx.app.get(SessionRemindersService);
    await reminders.runReminderSweep();
    expect(ofType(await listFor(player), 'session_reminder').filter((n) => n.entityId === scheduleId)).toHaveLength(0);
  });

  it('re-arms reminders when a night is cancelled and restored inside the lead window (#504)', async () => {
    // The sweep only purges the dedup ledger for nights that have already STARTED, so a
    // future night cancelled and restored inside the lead window kept its
    // (schedule, user, kind) rows: emitOnce()'s claim lost and the reminder was skipped
    // in silence. The night is back on the calendar and nobody is told. Before #504 the
    // sequence did not exist at all — cancel hard-deleted the row.
    const soon = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const sched = await dm
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .send({ scheduledAt: soon, title: 'Off again, on again' });
    expect(sched.status).toBe(201);
    const scheduleId = sched.body.id as number;

    const reminders = ctx.app.get(SessionRemindersService);
    await reminders.runReminderSweep();
    expect(ofType(await listFor(player), 'session_reminder').filter((n) => n.entityId === scheduleId)).toHaveLength(1);

    // Cancelled: the sweep must not remind for a game that is off.
    expect((await dm.delete(`/api/v1/schedule/${scheduleId}`).send({ reason: 'snowed in' })).status).toBe(200);
    const whileCancelled = await reminders.runReminderSweep();
    expect(whileCancelled).toBeDefined();
    expect(ofType(await listFor(player), 'session_reminder').filter((n) => n.entityId === scheduleId)).toHaveLength(1);

    // Restored: the night is on again, so the party has to be told again.
    expect((await dm.post(`/api/v1/schedule/${scheduleId}/restore`)).status).toBe(201);
    await reminders.runReminderSweep();
    expect(ofType(await listFor(player), 'session_reminder').filter((n) => n.entityId === scheduleId)).toHaveLength(2);

    // ...and the ledger is re-armed, not disabled: a repeat sweep still does not double-send.
    await reminders.runReminderSweep();
    expect(ofType(await listFor(player), 'session_reminder').filter((n) => n.entityId === scheduleId)).toHaveLength(2);
  });

  it('reminds for a future night whose linked recap is trashed (effective status, #504)', async () => {
    // This row stores `completed`, but its recap is in the Trash so every read — and
    // Upcoming/Next, and the RSVP and cancel guards — treat it as `scheduled` again.
    // The sweep filtered on the RAW status column, so the one part of the card that
    // works without a user present was the only part that silently did nothing.
    const soon = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
    const sched = await dm
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .send({ scheduledAt: soon, title: 'Recap in the bin' });
    expect(sched.status).toBe(201);
    const scheduleId = sched.body.id as number;

    const recap = await dm.post(`/api/v1/campaigns/${campaignId}/sessions`).send({
      title: 'Binned recap',
      playedAt: '2099-03-03',
      recap: 'Headed for the trash.',
      scheduledSessionId: scheduleId,
    });
    expect(recap.status).toBe(201);
    expect((await dm.delete(`/api/v1/sessions/${recap.body.id}`)).status).toBe(200);

    // What every other surface says about this row.
    const read = await dm.get(`/api/v1/schedule/${scheduleId}`);
    expect(read.body).toMatchObject({ status: 'scheduled', sessionId: null });

    const reminders = ctx.app.get(SessionRemindersService);
    await reminders.runReminderSweep();
    expect(ofType(await listFor(player), 'session_reminder').filter((n) => n.entityId === scheduleId)).toHaveLength(1);
  });
});
