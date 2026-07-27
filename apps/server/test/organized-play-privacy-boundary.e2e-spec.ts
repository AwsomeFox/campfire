import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #588 — independent adversarial probes of the organized-play privacy
 * boundary, and of the "one definition of effective status" claim.
 *
 * Like organized-play-privacy.e2e-spec.ts these need REAL cookie sessions: a
 * dev-auth user short-circuits RoleResolver into `accessibleCampaignIds === 'all'`,
 * so every redaction assertion would pass vacuously under `x-dev-role`.
 *
 * The rule under test is the one scheduleOrganizedPlaySql() exists to enforce:
 * a campaign that holds NO SHARED RESOURCE must be ABSENT from every
 * cross-campaign read — not redacted, not reduced to an opaque busy block, but
 * genuinely not there. "Something is here at 19:00" is itself the disclosure.
 */
describe('organized play privacy boundary (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let admin: ReturnType<typeof request.agent>;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  let aliceId: number;
  let bobId: number;

  let venueId: number;
  let roomId: number;
  /** Alice's genuinely-shared booking: holds a room, so it belongs in the pool. */
  let sharedRoomCampaignId: number;
  /** Alice's PRIVATE recurring home game: a series, but no room/venue/event key. */
  let privateSeriesCampaignId: number;
  let privateSeriesId: number;
  let privateOccurrenceId: number;

  const window = { from: '2099-08-01T00:00:00Z', to: '2099-09-01T00:00:00Z' };

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    admin = request.agent(server);
    await admin.post('/api/v1/auth/setup').send({ username: 'pb-admin', password: 'admin-password-1' });

    aliceId = (await admin.post('/api/v1/users').send({ username: 'pb-alice', password: 'password-alice-1', serverRole: 'user' })).body.id;
    bobId = (await admin.post('/api/v1/users').send({ username: 'pb-bob', password: 'password-bob-1', serverRole: 'user' })).body.id;
    expect(typeof aliceId).toBe('number');
    expect(typeof bobId).toBe('number');

    alice = request.agent(server);
    await alice.post('/api/v1/auth/login').send({ username: 'pb-alice', password: 'password-alice-1' });
    bob = request.agent(server);
    await bob.post('/api/v1/auth/login').send({ username: 'pb-bob', password: 'password-bob-1' });

    venueId = (await admin.post('/api/v1/organized-play/venues').send({ name: 'Boundary Hall', timezone: 'UTC' })).body.id;
    roomId = (await admin.post(`/api/v1/organized-play/venues/${venueId}/rooms`).send({ name: 'Table 1', capacity: 6 })).body.id;

    sharedRoomCampaignId = (await alice.post('/api/v1/campaigns').send({ name: 'Public Table' })).body.id;
    privateSeriesCampaignId = (await alice.post('/api/v1/campaigns').send({ name: 'Basement Campaign' })).body.id;

    // A genuinely shared booking — holds a room, so it is legitimately in the pool.
    const shared = await alice.post(`/api/v1/campaigns/${sharedRoomCampaignId}/series`).send({
      title: 'Public Table Night',
      timezone: 'UTC',
      startDate: '2099-08-04',
      startTime: '18:00',
      durationMinutes: 240,
      freq: 'weekly',
      count: 1,
      roomId,
      assignedDmUserId: String(aliceId),
      capacity: 6,
    });
    expect(shared.status).toBe(201);

    // The case under test: recurrence used for an ordinary PRIVATE home game.
    // No room, no venue, no event key, no season — nothing shared with anyone.
    // Recurrence is a general convenience feature, not a declaration of intent
    // to publish, so this campaign has opted into NOTHING.
    const priv = await alice.post(`/api/v1/campaigns/${privateSeriesCampaignId}/series`).send({
      title: 'Basement Campaign — Thursday',
      timezone: 'UTC',
      startDate: '2099-08-06',
      startTime: '19:00',
      durationMinutes: 240,
      freq: 'weekly',
      count: 2,
    });
    expect(priv.status).toBe(201);
    expect(priv.body.roomId).toBeNull();
    expect(priv.body.venueId).toBeNull();
    expect(priv.body.eventId).toBe('');
    privateSeriesId = priv.body.id;
    privateOccurrenceId = priv.body.occurrences[0].id;

    // Alice RSVPs yes to her own private night, so a member probe has something
    // to find if the boundary leaks.
    await alice.put(`/api/v1/schedule/${privateOccurrenceId}/rsvp`).send({ status: 'yes' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  /**
   * The headline: a recurring PRIVATE game holds no room, no venue and no event
   * key. `seriesId IS NOT NULL` must not by itself enrol it in the shared pool —
   * a series is a per-campaign recurrence rule, not a resource anybody else is
   * competing for.
   */
  it('a private recurring campaign holding no shared resource is ABSENT from the coordinator calendar', async () => {
    const bobView = await bob.get('/api/v1/organized-play/calendar').query(window);
    expect(bobView.status).toBe(200);

    // Only the room booking is a shared resource, so only it may appear.
    expect(bobView.body.entries).toHaveLength(1);
    expect(bobView.body.entries[0].roomId).toBe(roomId);

    // Nothing anywhere in the payload may hint at the basement game — not its
    // title, and not a title-less busy block sitting on its window either.
    const serialized = JSON.stringify(bobView.body);
    expect(serialized).not.toContain('Basement');
    expect(serialized).not.toContain('2099-08-06T19:00');
    expect(bobView.body.entries.some((e: { startsAt: string }) => e.startsAt === '2099-08-06T19:00:00.000Z')).toBe(false);
  });

  it('the same private night is not reachable through a conflict probe either', async () => {
    // A stranger probing the exact window, the exact DM and the exact member.
    const probe = await bob.post('/api/v1/organized-play/conflicts').send({
      scheduledAt: '2099-08-06T19:00:00.000Z',
      durationMinutes: 240,
      assignedDmUserId: String(aliceId),
      memberUserIds: [String(aliceId)],
    });
    expect(probe.status).toBe(201);
    // The room booking is on a different night, so a correctly-scoped probe of
    // this window finds nothing at all.
    expect(probe.body.conflicts).toEqual([]);
  });

  /**
   * The opaque busy block, asserted on the SERIALIZED response rather than on the
   * projection function — a second serialization path is exactly how these leak.
   *
   * Every field that survives redaction is enumerated here on purpose: this test
   * fails whenever a new column is added to the projection without a deliberate
   * decision about whether a stranger may read it.
   */
  it('an invisible entry carries the documented busy-block fields and nothing more', async () => {
    const bobView = await bob.get('/api/v1/organized-play/calendar').query(window);
    const hidden = bobView.body.entries.find((e: { visible: boolean }) => !e.visible);
    expect(hidden).toBeDefined();

    // Identity is gone.
    expect(hidden.campaignId).toBeNull();
    expect(hidden.campaignName).toBeNull();
    expect(hidden.title).toBeNull();
    expect(hidden.scheduleId).toBeNull();
    expect(hidden.seriesId).toBeNull();

    // The resource picture a coordinator legitimately plans from survives.
    expect(hidden.startsAt).toBe('2099-08-04T18:00:00.000Z');
    expect(hidden.endsAt).toBe('2099-08-04T22:00:00.000Z');
    expect(hidden.roomId).toBe(roomId);
    expect(hidden.roomName).toBe('Table 1');
    expect(hidden.capacity).toBe(6);
    expect(typeof hidden.seatsTaken).toBe('number');

    // No PERSON is named by a busy block. The window/room/capacity triple says
    // "this table is taken"; naming the running DM would additionally hand every
    // authenticated user a year-long, per-person movement log for campaigns they
    // cannot read, in one request.
    expect(hidden.assignedDmUserId).toBe('');

    // Asserted on the SERIALIZED entry, not on the projection function: a second
    // serialization path is how these leak. Every key the wire format carries is
    // listed, so adding a column to the projection fails here until somebody
    // decides on purpose whether a stranger may read it.
    expect(Object.keys(hidden).sort()).toEqual(
      [
        'assignedDmUserId', 'campaignId', 'campaignName', 'capacity', 'endsAt', 'eventId',
        'localStart', 'roomId', 'roomName', 'scheduleId', 'seasonId', 'seatsTaken', 'seriesId',
        'startsAt', 'status', 'timezone', 'title', 'venueId', 'venueName', 'visible',
      ].sort(),
    );
    // …and of those, exactly these carry no information about the campaign.
    for (const identifying of ['campaignId', 'campaignName', 'title', 'scheduleId', 'seriesId']) {
      expect({ key: identifying, value: hidden[identifying] }).toEqual({ key: identifying, value: null });
    }
    expect(hidden.assignedDmUserId).toBe('');
  });

  /**
   * scheduleEffectiveStatusSql() is claimed to be DERIVED from scheduleLiveSql()
   * so the coordinator calendar cannot disagree with the per-campaign Schedule
   * tab. Checked concretely on the row shape where raw and effective status
   * actually differ: `completed` whose recap has been trashed.
   */
  it('the calendar, the Schedule tab and the live projection agree on a cancelled night', async () => {
    const cancel = await alice.delete(`/api/v1/campaigns/${sharedRoomCampaignId}/series/${(await alice.get(`/api/v1/campaigns/${sharedRoomCampaignId}/series`)).body[0].id}`).send({ reason: 'venue flooded' });
    expect(cancel.status).toBe(200);

    const occId = cancel.body.occurrences[0].id;

    // Surface 1: the per-campaign Schedule tab point read.
    const point = await alice.get(`/api/v1/schedule/${occId}`);
    expect(point.status).toBe(200);
    expect(point.body.status).toBe('cancelled');

    // Surface 2: the live/upcoming projection must no longer carry it.
    const upcoming = await alice.get(`/api/v1/campaigns/${sharedRoomCampaignId}/schedule/upcoming`);
    expect(upcoming.body.some((s: { id: number }) => s.id === occId)).toBe(false);

    // Surface 3: the cross-campaign calendar, for the owner and for a stranger.
    const aliceView = await alice.get('/api/v1/organized-play/calendar').query(window);
    const aliceEntry = aliceView.body.entries.find((e: { scheduleId: number | null }) => e.scheduleId === occId);
    expect(aliceEntry.status).toBe('cancelled');

    const bobView = await bob.get('/api/v1/organized-play/calendar').query(window);
    const bobEntry = bobView.body.entries.find((e: { startsAt: string }) => e.startsAt === '2099-08-04T18:00:00.000Z');
    expect(bobEntry.status).toBe('cancelled');
  });

  it('the private series stays invisible even after its owner cancels it', async () => {
    const cancel = await alice.delete(`/api/v1/campaigns/${privateSeriesCampaignId}/series/${privateSeriesId}`).send({ reason: 'done' });
    expect(cancel.status).toBe(200);

    const bobView = await bob.get('/api/v1/organized-play/calendar').query(window);
    expect(JSON.stringify(bobView.body)).not.toContain('Basement');
    expect(bobView.body.entries.some((e: { startsAt: string }) => e.startsAt === '2099-08-06T19:00:00.000Z')).toBe(false);
  });
});
