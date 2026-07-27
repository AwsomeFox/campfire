import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #588 — the privacy half of organized play, across a REAL membership
 * boundary.
 *
 * This needs genuine cookie sessions rather than the `x-dev-role` headers the
 * sibling suite uses: a dev-auth user short-circuits RoleResolver and is
 * effectively every role in every campaign (`accessibleCampaignIds` returns
 * 'all'), so a redaction test written with dev headers would pass no matter what
 * the code did.
 *
 * The rule under test: a coordinator must be told that a room is TAKEN, and for
 * how long, without being told WHOSE game took it — and a campaign that never
 * opted into organized play must not appear at all.
 */
describe('organized play privacy (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let admin: ReturnType<typeof request.agent>;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  let aliceId: number;
  let bobId: number;

  let venueId: number;
  let roomId: number;
  let aliceCampaignId: number;
  let sharedCampaignId: number;
  let alicePrivateCampaignId: number;

  /** The window Alice books; Bob probes the same slot from outside. */
  const BOOKED_START = '2099-05-05T18:00:00.000Z';
  const BOOKED_END = '2099-05-05T22:00:00.000Z';

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    admin = request.agent(server);
    await admin.post('/api/v1/auth/setup').send({ username: 'op-admin', password: 'admin-password-1' });

    aliceId = (await admin.post('/api/v1/users').send({ username: 'op-alice', password: 'password-alice-1', serverRole: 'user' })).body.id;
    bobId = (await admin.post('/api/v1/users').send({ username: 'op-bob', password: 'password-bob-1', serverRole: 'user' })).body.id;

    alice = request.agent(server);
    await alice.post('/api/v1/auth/login').send({ username: 'op-alice', password: 'password-alice-1' });
    bob = request.agent(server);
    await bob.post('/api/v1/auth/login').send({ username: 'op-bob', password: 'password-bob-1' });

    // Venues and rooms are install infrastructure: only the server admin creates them.
    const venue = await admin.post('/api/v1/organized-play/venues').send({ name: 'Guild Hall', timezone: 'UTC' });
    expect(venue.status).toBe(201);
    venueId = venue.body.id;
    const room = await admin.post(`/api/v1/organized-play/venues/${venueId}/rooms`).send({ name: 'Main Hall', capacity: 6 });
    expect(room.status).toBe(201);
    roomId = room.body.id;

    aliceCampaignId = (await alice.post('/api/v1/campaigns').send({ name: "Alice's Secret Saga" })).body.id;
    sharedCampaignId = (await alice.post('/api/v1/campaigns').send({ name: 'Open Table' })).body.id;
    alicePrivateCampaignId = (await alice.post('/api/v1/campaigns').send({ name: 'Kitchen Table' })).body.id;
    // Bob is a member of the shared campaign only.
    await alice.post(`/api/v1/campaigns/${sharedCampaignId}/members`).send({ userId: bobId, role: 'player' });

    // Alice books the room for her SECRET campaign.
    const booked = await alice.post(`/api/v1/campaigns/${aliceCampaignId}/series`).send({
      title: 'The Crimson Conspiracy',
      timezone: 'UTC',
      startDate: '2099-05-05',
      startTime: '18:00',
      durationMinutes: 240,
      freq: 'weekly',
      count: 1,
      roomId,
      assignedDmUserId: String(aliceId),
      capacity: 6,
      eventId: 'GUILD-99',
    });
    expect(booked.status).toBe(201);

    // …and separately runs a purely private home game with no room at all.
    const home = await alice.post(`/api/v1/campaigns/${alicePrivateCampaignId}/schedule`).send({
      scheduledAt: BOOKED_START,
      title: 'Pizza and dice',
    });
    expect(home.status).toBe(201);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a non-admin cannot create venues, rooms or templates', async () => {
    expect((await alice.post('/api/v1/organized-play/venues').send({ name: 'Rogue Venue', timezone: 'UTC' })).status).toBe(403);
    expect((await alice.post(`/api/v1/organized-play/venues/${venueId}/rooms`).send({ name: 'Rogue Room' })).status).toBe(403);
    expect((await alice.delete(`/api/v1/organized-play/rooms/${roomId}`)).status).toBe(403);
    expect(
      (await alice.post('/api/v1/organized-play/templates').send({
        name: 'Rogue Template',
        timezone: 'UTC',
        slots: [{ weekday: 1, startTime: '19:00' }],
      })).status,
    ).toBe(403);
  });

  it('tells an outsider the room is TAKEN without revealing whose game it is', async () => {
    const probe = await bob.post('/api/v1/organized-play/conflicts').send({
      scheduledAt: '2099-05-05T20:00:00.000Z',
      durationMinutes: 60,
      roomId,
    });
    expect(probe.status).toBe(201);
    const room = probe.body.conflicts.filter((c: { kind: string }) => c.kind === 'room');
    expect(room).toHaveLength(1);

    // What Bob is allowed to learn: the resource is busy, and for how long.
    expect(room[0]).toMatchObject({
      kind: 'room',
      visible: false,
      startsAt: BOOKED_START,
      endsAt: BOOKED_END,
      roomId,
      roomName: 'Main Hall',
      venueName: 'Guild Hall',
    });
    // What he must NOT learn: which campaign, its name, its title, or an id he
    // could use to probe further.
    expect(room[0].campaignId).toBeNull();
    expect(room[0].campaignName).toBeNull();
    expect(room[0].scheduleId).toBeNull();
    expect(room[0].title).toBeNull();
    expect(JSON.stringify(room[0])).not.toContain('Crimson');
    expect(JSON.stringify(room[0])).not.toContain('Secret Saga');
  });

  it('gives the OWNER of the booking the full detail for the same probe', async () => {
    const probe = await alice.post('/api/v1/organized-play/conflicts').send({
      scheduledAt: '2099-05-05T20:00:00.000Z',
      durationMinutes: 60,
      roomId,
    });
    expect(probe.status).toBe(201);
    const room = probe.body.conflicts.find((c: { kind: string }) => c.kind === 'room');
    expect(room.visible).toBe(true);
    expect(room.campaignId).toBe(aliceCampaignId);
    expect(room.campaignName).toBe("Alice's Secret Saga");
    expect(room.title).toBe('The Crimson Conspiracy');
    expect(room.scheduleId).toEqual(expect.any(Number));
  });

  it('redacts the coordinator calendar per viewer, keeping the busy block intact', async () => {
    const window = { from: '2099-05-01T00:00:00Z', to: '2099-06-01T00:00:00Z' };

    const bobView = await bob.get('/api/v1/organized-play/calendar').query(window);
    expect(bobView.status).toBe(200);
    const bobEntry = bobView.body.entries.find((e: { roomId: number | null }) => e.roomId === roomId);
    expect(bobEntry).toBeDefined();
    // Enough to plan around: window, room, capacity, event key, running DM.
    expect(bobEntry).toMatchObject({
      visible: false,
      startsAt: BOOKED_START,
      endsAt: BOOKED_END,
      roomName: 'Main Hall',
      capacity: 6,
      eventId: 'GUILD-99',
      status: 'scheduled',
    });
    expect(bobEntry.campaignId).toBeNull();
    expect(bobEntry.campaignName).toBeNull();
    expect(bobEntry.title).toBeNull();
    expect(bobEntry.scheduleId).toBeNull();
    expect(bobEntry.seriesId).toBeNull();
    expect(JSON.stringify(bobView.body)).not.toContain('Crimson');

    const aliceView = await alice.get('/api/v1/organized-play/calendar').query(window);
    const aliceEntry = aliceView.body.entries.find((e: { roomId: number | null }) => e.roomId === roomId);
    expect(aliceEntry.visible).toBe(true);
    expect(aliceEntry.campaignId).toBe(aliceCampaignId);
    expect(aliceEntry.title).toBe('The Crimson Conspiracy');
  });

  it('never lists a campaign that stayed out of organized play, even redacted', async () => {
    const bobView = await bob.get('/api/v1/organized-play/calendar').query({ from: '2099-05-01T00:00:00Z', to: '2099-06-01T00:00:00Z' });
    // Alice's home game overlaps the booked window exactly, holds no room, and is
    // absent rather than redacted — shipping this feature must not make an
    // existing private campaign's mere existence at 18:00 observable.
    expect(bobView.body.entries).toHaveLength(1);
    expect(bobView.body.entries[0].roomId).toBe(roomId);
    expect(JSON.stringify(bobView.body)).not.toContain('Pizza and dice');

    // The same booking is likewise uncollidable, so it cannot leak that way.
    const probe = await bob.post('/api/v1/organized-play/conflicts').send({
      scheduledAt: BOOKED_START,
      durationMinutes: 60,
      memberUserIds: [String(aliceId)],
      assignedDmUserId: String(aliceId),
    });
    // Alice IS the assigned DM of the room booking, so a dm conflict is expected —
    // and it too must be redacted.
    for (const conflict of probe.body.conflicts) {
      expect(conflict.visible).toBe(false);
      expect(conflict.campaignId).toBeNull();
    }
    expect(JSON.stringify(probe.body)).not.toContain('Pizza and dice');
  });

  it('a member of the booking campaign sees it unredacted; a stranger to it does not', async () => {
    // Alice books the SHARED campaign (Bob is a player there) into the same room
    // on a different night, so the two visibility branches appear side by side.
    const shared = await alice.post(`/api/v1/campaigns/${sharedCampaignId}/series`).send({
      title: 'Open Table Night',
      timezone: 'UTC',
      startDate: '2099-05-12',
      startTime: '18:00',
      durationMinutes: 240,
      freq: 'weekly',
      count: 1,
      roomId,
    });
    expect(shared.status).toBe(201);

    const bobView = await bob.get('/api/v1/organized-play/calendar').query({ from: '2099-05-01T00:00:00Z', to: '2099-06-01T00:00:00Z' });
    const entries = bobView.body.entries;
    expect(entries).toHaveLength(2);
    const visible = entries.filter((e: { visible: boolean }) => e.visible);
    const hidden = entries.filter((e: { visible: boolean }) => !e.visible);
    expect(visible).toHaveLength(1);
    expect(visible[0].campaignId).toBe(sharedCampaignId);
    expect(visible[0].title).toBe('Open Table Night');
    expect(hidden).toHaveLength(1);
    expect(hidden[0].title).toBeNull();
  });

  it('refuses an outsider write to the booking campaign entirely', async () => {
    const series = await alice.get(`/api/v1/campaigns/${aliceCampaignId}/series`);
    const seriesId = series.body[0].id;
    expect((await bob.get(`/api/v1/campaigns/${aliceCampaignId}/series`)).status).toBe(403);
    expect((await bob.get(`/api/v1/campaigns/${aliceCampaignId}/series/${seriesId}`)).status).toBe(403);
    expect((await bob.delete(`/api/v1/campaigns/${aliceCampaignId}/series/${seriesId}`).send({})).status).toBe(403);

    const detail = await alice.get(`/api/v1/campaigns/${aliceCampaignId}/series/${seriesId}`);
    const occId = detail.body.occurrences[0].id;
    expect((await bob.post(`/api/v1/organized-play/occurrences/${occId}/reschedule`).send({ scheduledAt: '2099-05-06T18:00:00Z' })).status).toBe(403);
    expect((await bob.post(`/api/v1/organized-play/occurrences/${occId}/reassign`).send({ capacity: 1 })).status).toBe(403);
    expect((await bob.get(`/api/v1/organized-play/occurrences/${occId}/exceptions`)).status).toBe(403);
    expect((await bob.get(`/api/v1/organized-play/occurrences/${occId}/attendance`)).status).toBe(403);
  });

  /**
   * The redaction promises Bob no "id he could use to probe further". This runs
   * the attack that recovered it anyway.
   *
   * `excludeScheduleId` was applied inside the SQL, BEFORE redaction, so the
   * filter answered what the projection withheld: exclude the right id and the
   * opaque busy block vanishes. Enumerating ids therefore recovers the exact
   * `scheduleId` the response nulls out — the redaction intact and bypassed.
   */
  it('does not let an outsider recover the hidden scheduleId by enumerating excludeScheduleId', async () => {
    const probeWith = async (excludeScheduleId?: number) => {
      const body: Record<string, unknown> = { scheduledAt: '2099-05-05T20:00:00.000Z', durationMinutes: 60, roomId };
      if (excludeScheduleId != null) body.excludeScheduleId = excludeScheduleId;
      const res = await bob.post('/api/v1/organized-play/conflicts').send(body);
      expect(res.status).toBe(201);
      return res.body.conflicts.filter((c: { kind: string }) => c.kind === 'room');
    };

    // Baseline: Bob sees one opaque room conflict and is told no id for it.
    const baseline = await probeWith();
    expect(baseline).toHaveLength(1);
    expect(baseline[0].visible).toBe(false);
    expect(baseline[0].scheduleId).toBeNull();

    // The id actually being withheld, read as Alice (who may see it).
    const owner = await alice.post('/api/v1/organized-play/conflicts').send({
      scheduledAt: '2099-05-05T20:00:00.000Z',
      durationMinutes: 60,
      roomId,
    });
    const hiddenId = owner.body.conflicts.find((c: { kind: string }) => c.kind === 'room').scheduleId as number;
    expect(typeof hiddenId).toBe('number');

    // THE ATTACK: walk candidate ids and watch for the conflict disappearing.
    // Whichever id silences it is the id the response refused to give Bob.
    let recovered: number | null = null;
    for (let candidate = 1; candidate <= hiddenId + 3; candidate += 1) {
      if ((await probeWith(candidate)).length === 0) {
        recovered = candidate;
        break;
      }
    }
    expect(recovered).toBeNull();

    // Specifically, naming the true id must not behave differently from naming
    // an unrelated one, or from naming none at all: same conflicts, same length.
    expect(await probeWith(hiddenId)).toEqual(baseline);
    // …and an id that does not exist at all is indistinguishable from those two,
    // so "no such row" cannot be told apart from "row you may not see".
    expect(await probeWith(999_999)).toEqual(baseline);
  });

  it('still honours excludeScheduleId for a caller who can actually read that schedule', async () => {
    // The legitimate use — "I am editing this occurrence, do not report it
    // colliding with itself" — must survive the fix above. Alice can read her own
    // booking, so her exclusion is obeyed.
    const owner = await alice.post('/api/v1/organized-play/conflicts').send({
      scheduledAt: '2099-05-05T20:00:00.000Z',
      durationMinutes: 60,
      roomId,
    });
    const ownId = owner.body.conflicts.find((c: { kind: string }) => c.kind === 'room').scheduleId as number;

    const excluded = await alice.post('/api/v1/organized-play/conflicts').send({
      scheduledAt: '2099-05-05T20:00:00.000Z',
      durationMinutes: 60,
      roomId,
      excludeScheduleId: ownId,
    });
    expect(excluded.status).toBe(201);
    expect(excluded.body.conflicts.filter((c: { kind: string }) => c.kind === 'room')).toHaveLength(0);
  });

  /**
   * The room half of this endpoint is deliberately public to every authenticated
   * caller: a shared facility's occupancy is what the coordinator pool is FOR.
   * The person half is not. `POST /organized-play/conflicts` writes nothing and
   * costs nothing, so an unrestricted person probe is a free, repeatable oracle:
   * sweep day-sized windows against an account id and the exact windows come back
   * — redaction removes the campaign, the title and the schedule id, but never
   * the window, because the window IS the conflict. That reconstructs when and
   * where someone runs games, which is the same existence the coordinator
   * calendar deliberately withholds by blanking `assignedDmUserId`.
   */
  it('does not answer a person-specific probe for a stranger the caller shares no table with', async () => {
    const carol = request.agent(ctx.app.getHttpServer());
    const carolId = (
      await admin.post('/api/v1/users').send({ username: 'op-carol', password: 'password-carol-1', serverRole: 'user' })
    ).body.id;
    expect(typeof carolId).toBe('number');
    await carol.post('/api/v1/auth/login').send({ username: 'op-carol', password: 'password-carol-1' });

    const probe = async (agent: ReturnType<typeof request.agent>) => {
      const res = await agent.post('/api/v1/organized-play/conflicts').send({
        scheduledAt: '2099-05-05T20:00:00.000Z',
        durationMinutes: 60,
        assignedDmUserId: String(aliceId),
      });
      expect(res.status).toBe(201);
      return res.body.conflicts.filter((c: { kind: string }) => c.kind === 'dm');
    };

    // Carol shares no campaign with Alice, so Alice's schedule is not a question
    // she gets to ask. DROPPED, not rejected: the response is exactly what she
    // would have got by sending no id, so a 403 cannot tell her the account
    // exists either.
    expect(await probe(carol)).toHaveLength(0);
    const silent = await carol.post('/api/v1/organized-play/conflicts').send({
      scheduledAt: '2099-05-05T20:00:00.000Z',
      durationMinutes: 60,
    });
    expect(silent.body.conflicts.filter((c: { kind: string }) => c.kind === 'dm')).toHaveLength(0);

    // The legitimate use is untouched. Bob plays at Alice's Open Table, so
    // scheduling around her is exactly what this probe is for — he still gets the
    // busy window, still redacted down to no campaign and no title.
    const bobSees = await probe(bob);
    expect(bobSees).toHaveLength(1);
    expect(bobSees[0]).toMatchObject({ visible: false, campaignId: null, title: null });
    expect(bobSees[0].startsAt).toBe(BOOKED_START);

    // And a caller may always ask about themselves, with no campaign in common
    // with anybody — Carol checking her own availability is not a probe of a
    // third party.
    const self = await carol.post('/api/v1/organized-play/conflicts').send({
      scheduledAt: '2099-05-05T20:00:00.000Z',
      durationMinutes: 60,
      assignedDmUserId: String(carolId),
    });
    expect(self.status).toBe(201);
  });

  it('a player cannot create or cancel a series in a campaign they only play in', async () => {
    const create = await bob.post(`/api/v1/campaigns/${sharedCampaignId}/series`).send({
      title: 'Player Coup',
      timezone: 'UTC',
      startDate: '2099-07-01',
      startTime: '19:00',
      freq: 'weekly',
      count: 1,
    });
    expect(create.status).toBe(403);
  });
});
