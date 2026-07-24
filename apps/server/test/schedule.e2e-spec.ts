import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ICAL from 'ical.js';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { campaigns } from '../src/db/schema';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'player-1' };

/**
 * Issue #13 — session scheduling + ICS feed.
 * Scheduled (future) sessions with per-member RSVPs, the "next session"
 * endpoint, and the per-campaign public ICS calendar feed (unguessable
 * cf_ics_* capability token, DM-managed, rate-limited).
 */
describe('session scheduling (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name: 'Schedule Campaign' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('DM schedules a session; scheduledAt is normalized to ISO UTC and duration defaults to 240', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-06-01T19:30:00+02:00', title: 'Into the Underdark', location: "Sam's place" });
    expect(res.status).toBe(201);
    expect(res.body.scheduledAt).toBe('2099-06-01T17:30:00.000Z');
    expect(res.body.durationMinutes).toBe(240);
    expect(res.body.rsvps).toEqual([]);
  });

  it('players cannot schedule (403); invalid date-time is rejected (400)', async () => {
    const server = ctx.app.getHttpServer();

    const forbidden = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(player)
      .send({ scheduledAt: '2099-07-01T18:00:00Z' });
    expect(forbidden.status).toBe(403);

    const badDate = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: 'next tuesday-ish' });
    expect(badDate.status).toBe(400);
  });

  it('GET /schedule/next returns the earliest upcoming schedule, ignoring past ones', async () => {
    const server = ctx.app.getHttpServer();

    const past = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2001-01-01T18:00:00Z', title: 'Long ago' });
    expect(past.status).toBe(201);

    const later = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-12-01T18:00:00Z', title: 'Much later' });
    expect(later.status).toBe(201);

    const next = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/next`).set(player);
    expect(next.status).toBe(200);
    // Earliest *future* one is the June 2099 session from the first test, not the past or December one.
    expect(next.body.title).toBe('Into the Underdark');
  });

  it('members RSVP (upsert): set, change, and multiple members side by side', async () => {
    const server = ctx.app.getHttpServer();
    const next = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/next`).set(player);
    const scheduleId = next.body.id;

    const yes = await request(server).put(`/api/v1/schedule/${scheduleId}/rsvp`).set(player).send({ status: 'yes', note: 'bringing snacks' });
    expect(yes.status).toBe(200);
    expect(yes.body.rsvps).toHaveLength(1);
    expect(yes.body.rsvps[0]).toMatchObject({ userId: 'dev:player-1', status: 'yes', note: 'bringing snacks' });

    // Upsert, not duplicate: same member changing their answer updates the one row.
    const maybe = await request(server).put(`/api/v1/schedule/${scheduleId}/rsvp`).set(player).send({ status: 'maybe' });
    expect(maybe.status).toBe(200);
    expect(maybe.body.rsvps).toHaveLength(1);
    expect(maybe.body.rsvps[0].status).toBe('maybe');
    expect(maybe.body.rsvps[0].note).toBe('bringing snacks'); // note preserved when omitted

    const dmYes = await request(server).put(`/api/v1/schedule/${scheduleId}/rsvp`).set(dm).send({ status: 'yes' });
    expect(dmYes.status).toBe(200);
    expect(dmYes.body.rsvps).toHaveLength(2);

    const badStatus = await request(server).put(`/api/v1/schedule/${scheduleId}/rsvp`).set(player).send({ status: 'perhaps' });
    expect(badStatus.status).toBe(400);
  });

  it('members can update just their RSVP note without rewriting status', async () => {
    const server = ctx.app.getHttpServer();
    const next = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/next`).set(player);
    const scheduleId = next.body.id;

    const initial = await request(server)
      .put(`/api/v1/schedule/${scheduleId}/rsvp`)
      .set(player)
      .send({ status: 'yes', note: 'bringing snacks' });
    expect(initial.status).toBe(200);

    const noteOnly = await request(server)
      .put(`/api/v1/schedule/${scheduleId}/rsvp`)
      .set(player)
      .send({ note: 'running late' });
    expect(noteOnly.status).toBe(200);
    expect(noteOnly.body.rsvps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'dev:player-1', status: 'yes', note: 'running late' }),
      ]),
    );
  });

  it('DM can update and cancel a scheduled session; players cannot', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-08-01T18:00:00Z', title: 'Tentative' });
    const id = created.body.id;

    const playerPatch = await request(server).patch(`/api/v1/schedule/${id}`).set(player).send({ title: 'Hijacked' });
    expect(playerPatch.status).toBe(403);

    const patch = await request(server).patch(`/api/v1/schedule/${id}`).set(dm).send({ title: 'Confirmed', durationMinutes: 180 });
    expect(patch.status).toBe(200);
    expect(patch.body.title).toBe('Confirmed');
    expect(patch.body.durationMinutes).toBe(180);

    const playerDelete = await request(server).delete(`/api/v1/schedule/${id}`).set(player);
    expect(playerDelete.status).toBe(403);

    const del = await request(server).delete(`/api/v1/schedule/${id}`).set(dm);
    expect(del.status).toBe(200);

    const list = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule`).set(dm);
    expect(list.body.some((s: { id: number }) => s.id === id)).toBe(false);
  });

  describe('in-progress schedule window (issue #818)', () => {
    let liveCampaignId: number;

    beforeAll(async () => {
      const res = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name: 'Live Schedule Campaign' });
      liveCampaignId = res.body.id;
    });

    it('rejects zero and above-max durationMinutes (schema bounds)', async () => {
      const server = ctx.app.getHttpServer();
      const zero = await request(server)
        .post(`/api/v1/campaigns/${liveCampaignId}/schedule`)
        .set(dm)
        .send({ scheduledAt: '2099-01-01T18:00:00Z', durationMinutes: 0 });
      expect(zero.status).toBe(400);

      const tooLong = await request(server)
        .post(`/api/v1/campaigns/${liveCampaignId}/schedule`)
        .set(dm)
        .send({ scheduledAt: '2099-01-01T18:00:00Z', durationMinutes: 1441 });
      expect(tooLong.status).toBe(400);

      const maxOk = await request(server)
        .post(`/api/v1/campaigns/${liveCampaignId}/schedule`)
        .set(dm)
        .send({ scheduledAt: '2099-01-02T18:00:00Z', durationMinutes: 1440, title: 'Max length' });
      expect(maxOk.status).toBe(201);
      expect(maxOk.body.durationMinutes).toBe(1440);
      await request(server).delete(`/api/v1/schedule/${maxOk.body.id}`).set(dm);
    });

    it('GET /schedule/next and summary keep an in-progress game; Next stays available separately', async () => {
      const server = ctx.app.getHttpServer();
      const now = Date.now();
      const inProgressStart = new Date(now - 60 * 60_000).toISOString(); // started 1h ago
      const upcomingStart = new Date(now + 3 * 60 * 60_000).toISOString(); // 3h from now

      const live = await request(server)
        .post(`/api/v1/campaigns/${liveCampaignId}/schedule`)
        .set(dm)
        .send({
          scheduledAt: inProgressStart,
          durationMinutes: 240,
          title: 'Happening table',
          location: 'VTT link',
          notes: 'Stay muted until start',
        });
      expect(live.status).toBe(201);

      const later = await request(server)
        .post(`/api/v1/campaigns/${liveCampaignId}/schedule`)
        .set(dm)
        .send({ scheduledAt: upcomingStart, durationMinutes: 180, title: 'Next week table' });
      expect(later.status).toBe(201);

      const next = await request(server).get(`/api/v1/campaigns/${liveCampaignId}/schedule/next`).set(player);
      expect(next.status).toBe(200);
      expect(next.body.id).toBe(live.body.id);
      expect(next.body.title).toBe('Happening table');

      const summary = await request(server).get(`/api/v1/campaigns/${liveCampaignId}/summary`).set(player);
      expect(summary.status).toBe(200);
      expect(summary.body.inProgressSession).toMatchObject({
        id: live.body.id,
        title: 'Happening table',
        location: 'VTT link',
        notes: 'Stay muted until start',
      });
      expect(summary.body.nextSession).toMatchObject({
        id: later.body.id,
        title: 'Next week table',
      });

      // Overlapping second in-progress night: /schedule/next prefers the earliest start.
      const overlap = await request(server)
        .post(`/api/v1/campaigns/${liveCampaignId}/schedule`)
        .set(dm)
        .send({
          scheduledAt: new Date(now - 30 * 60_000).toISOString(),
          durationMinutes: 120,
          title: 'Overlap table',
        });
      expect(overlap.status).toBe(201);
      const nextOverlap = await request(server).get(`/api/v1/campaigns/${liveCampaignId}/schedule/next`).set(player);
      expect(nextOverlap.body.id).toBe(live.body.id);

      const summaryOverlap = await request(server).get(`/api/v1/campaigns/${liveCampaignId}/summary`).set(player);
      expect(summaryOverlap.body.inProgressSession.id).toBe(live.body.id);
      expect(summaryOverlap.body.nextSession.id).toBe(later.body.id);

      await request(server).delete(`/api/v1/schedule/${overlap.body.id}`).set(dm);
      await request(server).delete(`/api/v1/schedule/${later.body.id}`).set(dm);
      await request(server).delete(`/api/v1/schedule/${live.body.id}`).set(dm);
    });

    it('mid-session duration edit and end-now move the live projection (cache invalidation path)', async () => {
      const server = ctx.app.getHttpServer();
      const now = Date.now();
      const started = new Date(now - 90 * 60_000).toISOString();
      const created = await request(server)
        .post(`/api/v1/campaigns/${liveCampaignId}/schedule`)
        .set(dm)
        .send({ scheduledAt: started, durationMinutes: 240, title: 'Stretch night' });
      expect(created.status).toBe(201);
      const id = created.body.id as number;

      expect((await request(server).get(`/api/v1/campaigns/${liveCampaignId}/schedule/next`).set(player)).body.id).toBe(id);

      // Extend keeps it current.
      const extended = await request(server).patch(`/api/v1/schedule/${id}`).set(dm).send({ durationMinutes: 300 });
      expect(extended.status).toBe(200);
      const afterExtend = await request(server).get(`/api/v1/campaigns/${liveCampaignId}/summary`).set(player);
      expect(afterExtend.body.inProgressSession?.id).toBe(id);
      expect(afterExtend.body.inProgressSession?.durationMinutes).toBe(300);

      // End by shrinking duration so end <= now — drops out of next/in-progress.
      const ended = await request(server).patch(`/api/v1/schedule/${id}`).set(dm).send({ durationMinutes: 60 });
      expect(ended.status).toBe(200);
      const afterEnd = await request(server).get(`/api/v1/campaigns/${liveCampaignId}/summary`).set(player);
      expect(afterEnd.body.inProgressSession).toBeNull();
      expect(afterEnd.body.nextSession).toBeNull();
      const nextGone = await request(server).get(`/api/v1/campaigns/${liveCampaignId}/schedule/next`).set(player);
      expect(nextGone.status).toBe(200);
      // Nest serializes a null controller return as an empty body object.
      expect(nextGone.body?.id ?? null).toBeNull();

      await request(server).delete(`/api/v1/schedule/${id}`).set(dm);
    });

    it('same-day events: ended earlier slot is past; later slot is next', async () => {
      const server = ctx.app.getHttpServer();
      const now = Date.now();
      const morning = await request(server)
        .post(`/api/v1/campaigns/${liveCampaignId}/schedule`)
        .set(dm)
        .send({
          scheduledAt: new Date(now - 5 * 60 * 60_000).toISOString(),
          durationMinutes: 60,
          title: 'Morning one-shot',
        });
      const evening = await request(server)
        .post(`/api/v1/campaigns/${liveCampaignId}/schedule`)
        .set(dm)
        .send({
          scheduledAt: new Date(now + 2 * 60 * 60_000).toISOString(),
          durationMinutes: 180,
          title: 'Evening game',
        });
      expect(morning.status).toBe(201);
      expect(evening.status).toBe(201);

      const next = await request(server).get(`/api/v1/campaigns/${liveCampaignId}/schedule/next`).set(player);
      expect(next.body.id).toBe(evening.body.id);
      const summary = await request(server).get(`/api/v1/campaigns/${liveCampaignId}/summary`).set(player);
      expect(summary.body.inProgressSession).toBeNull();
      expect(summary.body.nextSession.id).toBe(evening.body.id);

      await request(server).delete(`/api/v1/schedule/${morning.body.id}`).set(dm);
      await request(server).delete(`/api/v1/schedule/${evening.body.id}`).set(dm);
    });
  });

  describe('ICS calendar feed', () => {
    let token: string;

    it('feed starts disabled; only the DM can enable it', async () => {
      const server = ctx.app.getHttpServer();

      const initial = await request(server).get(`/api/v1/campaigns/${campaignId}/calendar-feed`).set(player);
      expect(initial.status).toBe(200);
      expect(initial.body).toEqual({ token: null, url: null, expiresAt: null });

      const playerEnable = await request(server).post(`/api/v1/campaigns/${campaignId}/calendar-feed`).set(player);
      expect(playerEnable.status).toBe(403);

      const enable = await request(server).post(`/api/v1/campaigns/${campaignId}/calendar-feed`).set(dm);
      expect(enable.status).toBe(201);
      expect(enable.body.token).toMatch(/^cf_ics_[0-9a-f]{48}$/);
      expect(enable.body.url).toBe(`/api/v1/calendar/${enable.body.token}.ics`);
      // Issue #554: every issued token carries an absolute expiry the feed enforces.
      expect(enable.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      const expiresInDays =
        (new Date(enable.body.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      // Default window is 90 days; allow generous slack so wall-clock drift never flakes this.
      expect(expiresInDays).toBeGreaterThan(80);
      expect(expiresInDays).toBeLessThan(100);
      token = enable.body.token;

      // Members can re-read the token/URL (calendar URLs must be re-displayable).
      const asPlayer = await request(server).get(`/api/v1/campaigns/${campaignId}/calendar-feed`).set(player);
      expect(asPlayer.body.token).toBe(token);
      expect(asPlayer.body.expiresAt).toBe(enable.body.expiresAt);
    });

    it('serves a valid ICS document to an unauthenticated client holding the token', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server).get(`/api/v1/calendar/${token}.ics`); // no auth headers at all
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/calendar');

      const body = res.text;
      expect(body).toContain('BEGIN:VCALENDAR');
      expect(body).toContain('END:VCALENDAR');
      expect(body).toContain('BEGIN:VEVENT');
      expect(body).toContain('SUMMARY:Into the Underdark');
      expect(body).toContain('DTSTART:20990601T173000Z');
      expect(body).toContain('DTEND:20990601T213000Z'); // start + default 240 minutes
      expect(body).toContain(`UID:campfire-c${campaignId}-s`);
      expect(body).toContain("LOCATION:Sam's place");
    });

    it('escapes ICS special characters in event text', async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/schedule`)
        .set(dm)
        .send({ scheduledAt: '2099-09-01T18:00:00Z', title: 'Fire, brimstone; doom' });
      expect(created.status).toBe(201);

      const res = await request(server).get(`/api/v1/calendar/${token}.ics`);
      expect(res.text).toContain('SUMMARY:Fire\\, brimstone\\; doom');

      await request(server).delete(`/api/v1/schedule/${created.body.id}`).set(dm);
    });

    it('serves parser-valid Unicode content folded to at most 75 UTF-8 octets', async () => {
      const server = ctx.app.getHttpServer();
      const title = 'ليلة النجوم 星の夜 👩‍🚀🇺🇳 ' + 'é'.repeat(70);
      const location = 'https://example.test/مكان/星?' + 'crew=👨‍👩‍👧‍👦'.repeat(8);
      const notes = `RTL العربية، CJK 漢字; combining ${'e\u0301'.repeat(45)}\n${'🚀'.repeat(60)}`;
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/schedule`)
        .set(dm)
        .send({ scheduledAt: '2099-09-02T18:00:00Z', title, location, notes });
      expect(created.status).toBe(201);

      const res = await request(server).get(`/api/v1/calendar/${token}.ics`);
      expect(res.status).toBe(200);
      expect(res.text.endsWith('\r\n')).toBe(true);
      expect(res.text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
      for (const line of res.text.split('\r\n').slice(0, -1)) {
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
      }

      const calendar = new ICAL.Component(ICAL.parse(res.text));
      const event = calendar
        .getAllSubcomponents('vevent')
        .find((candidate) => candidate.getFirstPropertyValue('summary') === title);
      expect(event).toBeDefined();
      expect(event!.getFirstPropertyValue('location')).toBe(location);
      expect(event!.getFirstPropertyValue('description')).toBe(notes);

      await request(server).delete(`/api/v1/schedule/${created.body.id}`).set(dm);
    });

    it('unknown or malformed tokens 404', async () => {
      const server = ctx.app.getHttpServer();
      const wrong = await request(server).get(`/api/v1/calendar/cf_ics_${'0'.repeat(48)}.ics`);
      expect(wrong.status).toBe(404);

      const malformed = await request(server).get('/api/v1/calendar/not-a-token.ics');
      expect(malformed.status).toBe(404);
    });

    it('issue #554: an expired token is rejected with 404 (leaked URL self-destructs)', async () => {
      const server = ctx.app.getHttpServer();

      // Sanity: the current token still works before time-travel.
      const before = await request(server).get(`/api/v1/calendar/${token}.ics`);
      expect(before.status).toBe(200);

      // Time-travel the token's expiry into the past, exactly like the invite-expiry
      // e2e (invites.e2e-spec.ts) does — direct DB write via the app's Drizzle handle.
      const db = ctx.app.get<DrizzleDb>(DB);
      await db
        .update(campaigns)
        .set({ icsTokenExpiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(campaigns.id, campaignId));

      // The public feed stops serving the expired token — same 404 as
      // unknown/rotated/disabled, so a probing caller learns nothing extra.
      const expired = await request(server).get(`/api/v1/calendar/${token}.ics`);
      expect(expired.status).toBe(404);

      // Settings still report the token + the (now-past) expiry so the DM can see
      // WHY the feed died and rotate to bring it back.
      const settings = await request(server).get(`/api/v1/campaigns/${campaignId}/calendar-feed`).set(dm);
      expect(settings.status).toBe(200);
      expect(settings.body.token).toBe(token);
      expect(new Date(settings.body.expiresAt).getTime()).toBeLessThan(Date.now());
    });

    it('rotating invalidates the old token; the new one works and gets a fresh expiry', async () => {
      const server = ctx.app.getHttpServer();
      const rotate = await request(server).post(`/api/v1/campaigns/${campaignId}/calendar-feed`).set(dm);
      expect(rotate.status).toBe(201);
      const newToken = rotate.body.token;
      expect(newToken).not.toBe(token);
      expect(rotate.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // A rotation after the previous test backdated the expiry must mint a new
      // token whose expiry is back in the future (default ~90d window).
      expect(new Date(rotate.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const old = await request(server).get(`/api/v1/calendar/${token}.ics`);
      expect(old.status).toBe(404);

      const fresh = await request(server).get(`/api/v1/calendar/${newToken}.ics`);
      expect(fresh.status).toBe(200);
      token = newToken;
    });

    it('disabling kills the feed; only the DM can disable', async () => {
      const server = ctx.app.getHttpServer();

      const playerDisable = await request(server).delete(`/api/v1/campaigns/${campaignId}/calendar-feed`).set(player);
      expect(playerDisable.status).toBe(403);

      const disable = await request(server).delete(`/api/v1/campaigns/${campaignId}/calendar-feed`).set(dm);
      expect(disable.status).toBe(200);
      expect(disable.body).toEqual({ token: null, url: null, expiresAt: null });

      const feed = await request(server).get(`/api/v1/calendar/${token}.ics`);
      expect(feed.status).toBe(404);

      const settings = await request(server).get(`/api/v1/campaigns/${campaignId}/calendar-feed`).set(dm);
      expect(settings.body).toEqual({ token: null, url: null, expiresAt: null });
    });
  });
});

/**
 * Rate limiting on the public feed — mirrors throttle.e2e-spec.ts's pattern:
 * builds its own app with throttling left ON (every other suite opts out via
 * THROTTLE_DISABLED=1 in test-app.ts).
 */
describe('ICS feed rate limiting (e2e, real ThrottlerGuard)', () => {
  let app: INestApplication;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
    process.env.DATA_DIR = dataDir;
    delete process.env.DEV_AUTH;
    delete process.env.THROTTLE_DISABLED;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    // Restore the suite-wide default (see throttle.e2e-spec.ts's identical note).
    process.env.THROTTLE_DISABLED = '1';
  });

  it('without a session (and DEV_AUTH off), authed schedule routes are 401', async () => {
    // (The public feed route staying reachable without auth is covered by the main
    // suite above; hitting it here would eat into the ICS throttle budget that the
    // next test measures exactly.)
    const server = app.getHttpServer();
    const schedule = await request(server).get('/api/v1/campaigns/1/schedule');
    expect(schedule.status).toBe(401);

    const feedSettings = await request(server).get('/api/v1/campaigns/1/calendar-feed');
    expect(feedSettings.status).toBe(401);
  });

  it('GET /calendar/:token.ics: after ICS_THROTTLE_LIMIT rapid requests from one IP, the next one is 429', async () => {
    const server = app.getHttpServer();
    const ICS_THROTTLE_LIMIT = 30;
    const unknownToken = `cf_ics_${'a'.repeat(48)}`;

    const statuses: number[] = [];
    for (let i = 0; i < ICS_THROTTLE_LIMIT; i++) {
      const res = await request(server).get(`/api/v1/calendar/${unknownToken}.ics`);
      statuses.push(res.status);
    }
    // First LIMIT requests are ordinary 404s (unknown token), not 429 — the limit is generous
    // enough for real calendar clients, which poll a few times an hour at most.
    expect(statuses.every((s) => s === 404)).toBe(true);

    const overLimit = await request(server).get(`/api/v1/calendar/${unknownToken}.ics`);
    expect(overLimit.status).toBe(429);
  });
});
