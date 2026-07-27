import ICAL from 'ical.js';
import request from 'supertest';
import type { Database } from 'better-sqlite3';
import { DB_HOLDER, type DbHolder } from '../src/db/db.module';
import { OrganizedPlayService } from '../src/modules/sessions/organized-play.service';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'op-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'op-player' };

/**
 * Issue #588 — organized-play scheduling: venue/room resources, recurring series
 * with an explicit timezone, assigned DMs, capacity, event/season keys, stable
 * ICS UIDs, per-occurrence exceptions, cross-campaign conflict detection and the
 * coordinator calendar.
 *
 * Privacy across a real membership boundary needs genuine cookie sessions (a
 * dev-auth user is every role in every campaign), so that half lives in
 * organized-play-privacy.e2e-spec.ts.
 */
describe('organized play (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let otherCampaignId: number;
  let venueId: number;
  let blueRoomId: number;
  let redRoomId: number;

  const api = (): ReturnType<typeof request> => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    campaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Adventurers League' })).body.id;
    otherCampaignId = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Rival Table' })).body.id;

    const venue = await request(server)
      .post('/api/v1/organized-play/venues')
      .set(dm)
      .send({ name: 'The Rusty D20', timezone: 'America/New_York', address: '1 Main St' });
    expect(venue.status).toBe(201);
    venueId = venue.body.id;

    blueRoomId = (
      await request(server).post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Blue Room', capacity: 6 })
    ).body.id;
    redRoomId = (
      await request(server).post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Red Room', capacity: 5 })
    ).body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // ----- venues + rooms -----

  it('lists venues with their rooms, and rejects a made-up timezone', async () => {
    const list = await api().get('/api/v1/organized-play/venues').set(dm);
    expect(list.status).toBe(200);
    const venue = list.body.find((v: { id: number }) => v.id === venueId);
    expect(venue.timezone).toBe('America/New_York');
    expect(venue.rooms.map((r: { name: string }) => r.name).sort()).toEqual(['Blue Room', 'Red Room']);

    const bad = await api().post('/api/v1/organized-play/venues').set(dm).send({ name: 'Nowhere', timezone: 'Mars/Base' });
    expect(bad.status).toBe(400);
  });

  it('refuses a duplicate room name within a venue', async () => {
    const dupe = await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Blue Room' });
    expect(dupe.status).toBe(400);
  });

  it('updates and deletes venues, rooms and templates, and 404s on unknown ids', async () => {
    const venue = await api().post('/api/v1/organized-play/venues').set(dm).send({ name: 'Temp Venue', timezone: 'UTC' });
    const room = await api().post(`/api/v1/organized-play/venues/${venue.body.id}/rooms`).set(dm).send({ name: 'Nook', capacity: 4 });

    const renamedVenue = await api()
      .patch(`/api/v1/organized-play/venues/${venue.body.id}`)
      .set(dm)
      .send({ name: 'Renamed Venue', timezone: 'Europe/Berlin', address: '2 Side St', notes: 'upstairs' });
    expect(renamedVenue.status).toBe(200);
    expect(renamedVenue.body).toMatchObject({ name: 'Renamed Venue', timezone: 'Europe/Berlin', address: '2 Side St' });
    expect((await api().patch(`/api/v1/organized-play/venues/${venue.body.id}`).set(dm).send({ timezone: 'Mars/Base' })).status).toBe(400);

    const renamedRoom = await api()
      .patch(`/api/v1/organized-play/rooms/${room.body.id}`)
      .set(dm)
      .send({ name: 'Renamed Nook', capacity: 8, notes: 'by the window' });
    expect(renamedRoom.status).toBe(200);
    expect(renamedRoom.body).toMatchObject({ name: 'Renamed Nook', capacity: 8 });

    const template = await api()
      .post('/api/v1/organized-play/templates')
      .set(dm)
      .send({ name: 'Throwaway', timezone: 'UTC', slots: [{ weekday: 3, startTime: '19:00' }] });
    expect(template.status).toBe(201);
    const templates = await api().get('/api/v1/organized-play/templates').set(dm);
    expect(templates.body.some((t: { id: number }) => t.id === template.body.id)).toBe(true);
    expect((await api().delete(`/api/v1/organized-play/templates/${template.body.id}`).set(dm)).status).toBe(200);
    expect((await api().delete(`/api/v1/organized-play/templates/${template.body.id}`).set(dm)).status).toBe(404);

    expect((await api().delete(`/api/v1/organized-play/venues/${venue.body.id}`).set(dm)).status).toBe(200);
    expect((await api().patch(`/api/v1/organized-play/venues/${venue.body.id}`).set(dm).send({ name: 'Ghost' })).status).toBe(404);
    expect((await api().patch(`/api/v1/organized-play/rooms/${room.body.id}`).set(dm).send({ name: 'Ghost' })).status).toBe(404);
  });

  it('rejects a room that belongs to a different venue than the one named', async () => {
    const otherVenue = await api().post('/api/v1/organized-play/venues').set(dm).send({ name: 'Elsewhere', timezone: 'UTC' });
    const res = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({
        timezone: 'UTC',
        startDate: '2099-12-01',
        startTime: '19:00',
        freq: 'weekly',
        count: 1,
        roomId: blueRoomId,
        venueId: otherVenue.body.id,
      });
    expect(res.status).toBe(400);
  });

  // ----- series creation + DST -----

  let dstSeriesId: number;

  it('materializes a weekly series at a fixed LOCAL time across a DST transition', async () => {
    const res = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({
        title: 'Tuesday Night AL',
        timezone: 'America/New_York',
        startDate: '2099-02-24',
        startTime: '19:00',
        durationMinutes: 240,
        freq: 'weekly',
        interval: 1,
        count: 4,
        roomId: blueRoomId,
        assignedDmUserId: 'dev:op-dm',
        capacity: 6,
        eventId: 'AL-2099',
        seasonId: 'S12',
      });
    expect(res.status).toBe(201);
    dstSeriesId = res.body.id;
    expect(res.body.occurrences).toHaveLength(4);
    expect(res.body.occurrences.map((o: { localStart: string }) => o.localStart)).toEqual([
      '2099-02-24T19:00',
      '2099-03-03T19:00',
      '2099-03-10T19:00',
      '2099-03-17T19:00',
    ]);
    // The stored instants shift by an hour at the transition — a fixed 7-day
    // stride would have frozen the instant and moved the wall clock instead.
    const instants = res.body.occurrences.map((o: { scheduledAt: string }) => o.scheduledAt);
    expect(instants[0]).toBe('2099-02-25T00:00:00.000Z');
    expect(instants[1]).toBe('2099-03-04T00:00:00.000Z');
    expect(instants[2]).toBe('2099-03-10T23:00:00.000Z');
    expect(instants[3]).toBe('2099-03-17T23:00:00.000Z');

    // Every occurrence carries the organized-play decoration.
    for (const occ of res.body.occurrences) {
      expect(occ.roomId).toBe(blueRoomId);
      expect(occ.venueId).toBe(venueId);
      expect(occ.assignedDmUserId).toBe('dev:op-dm');
      expect(occ.capacity).toBe(6);
      expect(occ.eventId).toBe('AL-2099');
      expect(occ.seasonId).toBe('S12');
      expect(occ.timezone).toBe('America/New_York');
      expect(occ.icsUid).toMatch(/^campfire-series-[0-9a-f]{24}-\d+@campfire$/);
      expect(occ.originalScheduledAt).toBe(occ.scheduledAt);
    }
  });

  it('occurrences ARE ordinary scheduled sessions — they show up in the existing schedule reads', async () => {
    const upcoming = await api().get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(dm);
    expect(upcoming.status).toBe(200);
    const seriesRows = upcoming.body.filter((s: { seriesId: number | null }) => s.seriesId === dstSeriesId);
    expect(seriesRows).toHaveLength(4);
    // RSVPs work on them with no special handling.
    const first = seriesRows[0];
    const rsvp = await api().put(`/api/v1/schedule/${first.id}/rsvp`).set(player).send({ status: 'yes' });
    expect(rsvp.status).toBe(200);
    expect(rsvp.body.rsvps).toHaveLength(1);
  });

  it('extends a series from the original wall clock, keeping the local time', async () => {
    const res = await api().post(`/api/v1/campaigns/${campaignId}/series/${dstSeriesId}/extend`).set(dm).send({ addCount: 2 });
    expect(res.status).toBe(201);
    expect(res.body.occurrences).toHaveLength(6);
    expect(res.body.occurrences[5].localStart).toBe('2099-03-31T19:00');
    expect(res.body.occurrences[5].scheduledAt).toBe('2099-03-31T23:00:00.000Z');
  });

  it('rejects an unknown timezone and an impossible recurrence with 400', async () => {
    const badTz = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ timezone: 'Mars/Base', startDate: '2099-05-01', startTime: '19:00', freq: 'weekly' });
    expect(badTz.status).toBe(400);

    const badDate = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ timezone: 'UTC', startDate: '2099-02-30', startTime: '19:00', freq: 'weekly' });
    expect(badDate.status).toBe(400);
  });

  // ----- conflict detection -----

  it('detects a room double-booking across campaigns and refuses the booking (409)', async () => {
    const clash = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({
        title: 'Rival Tuesday',
        timezone: 'America/New_York',
        startDate: '2099-02-24',
        startTime: '20:00', // overlaps the 19:00-23:00 booking above
        durationMinutes: 120,
        freq: 'weekly',
        count: 1,
        roomId: blueRoomId,
      });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SCHEDULE_CONFLICT');
    expect(clash.body.conflicts.length).toBeGreaterThan(0);
    expect(clash.body.conflicts[0].kind).toBe('room');

    // Nothing was written: the check and the inserts share one transaction.
    const seriesList = await api().get(`/api/v1/campaigns/${otherCampaignId}/series`).set(dm);
    expect(seriesList.body).toHaveLength(0);
    const schedule = await api().get(`/api/v1/campaigns/${otherCampaignId}/schedule`).set(dm);
    expect(schedule.body).toHaveLength(0);
  });

  it('allows a back-to-back booking (half-open windows do not overlap)', async () => {
    const ok = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({
        title: 'Late Table',
        timezone: 'America/New_York',
        startDate: '2099-02-24',
        startTime: '23:00', // starts exactly when the 19:00+240m booking ends
        durationMinutes: 120,
        freq: 'weekly',
        count: 1,
        roomId: blueRoomId,
      });
    expect(ok.status).toBe(201);
    await api().delete(`/api/v1/campaigns/${otherCampaignId}/series/${ok.body.id}`).set(dm).send({ reason: 'test cleanup' });
  });

  it('detects a DM assigned to two overlapping tables', async () => {
    const probe = await api()
      .post('/api/v1/organized-play/conflicts')
      .set(dm)
      .send({
        scheduledAt: '2099-02-25T01:00:00.000Z', // inside the 19:00 EST -> 00:00Z table
        durationMinutes: 60,
        roomId: redRoomId, // a DIFFERENT room, so only the DM can collide
        assignedDmUserId: 'dev:op-dm',
      });
    expect(probe.status).toBe(201);
    expect(probe.body.conflicts.map((c: { kind: string }) => c.kind)).toContain('dm');
    expect(probe.body.conflicts.every((c: { kind: string }) => c.kind !== 'room')).toBe(true);
  });

  it('detects a member seated at two overlapping tables', async () => {
    const probe = await api()
      .post('/api/v1/organized-play/conflicts')
      .set(dm)
      .send({
        scheduledAt: '2099-02-25T01:00:00.000Z',
        durationMinutes: 60,
        roomId: redRoomId,
        memberUserIds: ['dev:op-player'], // RSVP'd yes to the first occurrence above
      });
    expect(probe.status).toBe(201);
    const member = probe.body.conflicts.filter((c: { kind: string }) => c.kind === 'member');
    expect(member).toHaveLength(1);
    expect(member[0].subjectUserId).toBe('dev:op-player');
  });

  it('reports no conflict for a member who only said maybe', async () => {
    const probe = await api()
      .post('/api/v1/organized-play/conflicts')
      .set(dm)
      .send({ scheduledAt: '2099-02-25T01:00:00.000Z', durationMinutes: 60, memberUserIds: ['dev:nobody'] });
    expect(probe.body.conflicts).toEqual([]);
  });

  /**
   * "Concurrent booking" — read this before changing it.
   *
   * better-sqlite3 is synchronous and single-process, so a genuinely racing
   * interleaving between the conflict check and the insert CANNOT be expressed
   * in a test here: no other statement of this process can run between two
   * statements of the same synchronous transaction. Pretending otherwise (two
   * awaited promises "in parallel") would be theatre.
   *
   * So this asserts the two things that are actually assertable:
   *   1. STRUCTURAL — the conflict query runs while a transaction is open on the
   *      same connection, which is what makes check-then-insert atomic.
   *   2. BOTH SERIAL ORDERINGS — whichever booking lands first wins and the
   *      second is rejected, with nothing partially written either way.
   */
  it('books atomically: the conflict check runs inside the write transaction, and either ordering yields exactly one winner', async () => {
    const holder = ctx.app.get<DbHolder>(DB_HOLDER);
    const raw: Database = holder.raw;
    const service = ctx.app.get(OrganizedPlayService);

    const observedInTransaction: boolean[] = [];
    const original = (service as unknown as { findConflictRows: (...args: unknown[]) => unknown }).findConflictRows;
    const spy = jest
      .spyOn(service as unknown as { findConflictRows: (...args: unknown[]) => unknown }, 'findConflictRows')
      .mockImplementation(function patched(this: unknown, ...args: unknown[]) {
        observedInTransaction.push(raw.inTransaction);
        return original.apply(this, args);
      });

    const book = (campaign: number, title: string) =>
      api()
        .post(`/api/v1/campaigns/${campaign}/series`)
        .set(dm)
        .send({
          title,
          timezone: 'UTC',
          startDate: '2099-09-01',
          startTime: '18:00',
          durationMinutes: 180,
          freq: 'weekly',
          count: 1,
          roomId: redRoomId,
        });

    const first = await book(campaignId, 'Winner A');
    expect(first.status).toBe(201);
    const second = await book(otherCampaignId, 'Loser B');
    expect(second.status).toBe(409);
    expect(observedInTransaction.length).toBeGreaterThan(0);
    expect(observedInTransaction.every(Boolean)).toBe(true);
    spy.mockRestore();

    // Reverse ordering on a fresh slot: the other campaign wins this time.
    const bookLater = (campaign: number, title: string) =>
      api()
        .post(`/api/v1/campaigns/${campaign}/series`)
        .set(dm)
        .send({
          title,
          timezone: 'UTC',
          startDate: '2099-09-08',
          startTime: '18:00',
          durationMinutes: 180,
          freq: 'weekly',
          count: 1,
          roomId: redRoomId,
        });
    const firstReversed = await bookLater(otherCampaignId, 'Winner B');
    expect(firstReversed.status).toBe(201);
    const secondReversed = await bookLater(campaignId, 'Loser A');
    expect(secondReversed.status).toBe(409);

    // Exactly one series holds each slot — no half-written loser anywhere.
    const held = raw
      .prepare('SELECT COUNT(*) AS n FROM scheduled_sessions WHERE room_id = ? AND scheduled_at IN (?, ?)')
      .get(redRoomId, '2099-09-01T18:00:00.000Z', '2099-09-08T18:00:00.000Z') as { n: number };
    expect(held.n).toBe(2);
  });

  it('books a conflicting slot anyway when the coordinator forces it', async () => {
    const forced = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({
        title: 'Overbooked On Purpose',
        timezone: 'UTC',
        startDate: '2099-09-01',
        startTime: '18:00',
        durationMinutes: 180,
        freq: 'weekly',
        count: 1,
        roomId: redRoomId,
        force: true,
      });
    expect(forced.status).toBe(201);
    await api().delete(`/api/v1/campaigns/${otherCampaignId}/series/${forced.body.id}`).set(dm).send({});
  });

  // ----- per-occurrence exceptions + lineage -----

  it('reschedules ONE occurrence in place: same id and UID, bumped SEQUENCE, RSVPs kept, lineage recorded', async () => {
    const series = await api().get(`/api/v1/campaigns/${campaignId}/series/${dstSeriesId}`).set(dm);
    const target = series.body.occurrences[1];
    const before = await api().get(`/api/v1/schedule/${target.id}`).set(dm);
    const rsvpsBefore = before.body.rsvps.length;

    const moved = await api()
      .post(`/api/v1/organized-play/occurrences/${target.id}/reschedule`)
      .set(dm)
      .send({ localStart: '2099-03-05T19:00', reason: 'venue closed Tuesday', force: true });
    expect(moved.status).toBe(201);
    expect(moved.body.occurrence.id).toBe(target.id);
    expect(moved.body.occurrence.icsUid).toBe(target.icsUid); // survives the move
    expect(moved.body.occurrence.icsSequence).toBe(target.icsSequence + 1);
    expect(moved.body.occurrence.localStart).toBe('2099-03-05T19:00');
    expect(moved.body.occurrence.scheduledAt).toBe('2099-03-06T00:00:00.000Z');
    // Lineage: the FIRST materialized instant is retained, not overwritten.
    expect(moved.body.occurrence.originalScheduledAt).toBe(target.scheduledAt);

    const after = await api().get(`/api/v1/schedule/${target.id}`).set(dm);
    expect(after.body.rsvps).toHaveLength(rsvpsBefore);

    const ledger = await api().get(`/api/v1/organized-play/occurrences/${target.id}/exceptions`).set(dm);
    expect(ledger.status).toBe(200);
    const reschedule = ledger.body.find((e: { kind: string }) => e.kind === 'reschedule');
    expect(reschedule.fromScheduledAt).toBe(target.scheduledAt);
    expect(reschedule.toScheduledAt).toBe('2099-03-06T00:00:00.000Z');
    expect(reschedule.recurrenceLocalDate).toBe('2099-03-03'); // the RECURRENCE-ID analogue
    expect(reschedule.reason).toBe('venue closed Tuesday');
  });

  it('rejects malformed or impossible occurrence edits', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Edit Guards', timezone: 'UTC', startDate: '2099-12-08', startTime: '19:00', freq: 'weekly', count: 1 });
    const occId = series.body.occurrences[0].id;

    // Neither a wall clock nor an instant.
    expect((await api().post(`/api/v1/organized-play/occurrences/${occId}/reschedule`).set(dm).send({})).status).toBe(400);
    // An instant that is not a date-time is rejected by the DTO.
    expect(
      (await api().post(`/api/v1/organized-play/occurrences/${occId}/reschedule`).set(dm).send({ scheduledAt: 'tuesday-ish' })).status,
    ).toBe(400);
    // A room that does not exist.
    expect((await api().post(`/api/v1/organized-play/occurrences/${occId}/reassign`).set(dm).send({ roomId: 999_999 })).status).toBe(404);
    // Unknown occurrence.
    expect((await api().post('/api/v1/organized-play/occurrences/999999/reassign').set(dm).send({ capacity: 1 })).status).toBe(404);
    expect((await api().get(`/api/v1/campaigns/${campaignId}/series/999999`).set(dm)).status).toBe(404);

    // A cancelled night is not editable until it is restored.
    expect((await api().delete(`/api/v1/schedule/${occId}`).set(dm).send({ reason: 'nope' })).status).toBe(200);
    expect(
      (await api().post(`/api/v1/organized-play/occurrences/${occId}/reschedule`).set(dm).send({ scheduledAt: '2099-12-09T19:00:00Z' })).status,
    ).toBe(400);
    expect((await api().post(`/api/v1/organized-play/occurrences/${occId}/reassign`).set(dm).send({ capacity: 2 })).status).toBe(400);

    // …and a cancelled SERIES cannot be extended.
    await api().delete(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({});
    expect(
      (await api().post(`/api/v1/campaigns/${campaignId}/series/${series.body.id}/extend`).set(dm).send({ addCount: 1 })).status,
    ).toBe(400);
  });

  it('accepts an instant for a reschedule and re-derives the local wall clock from the zone', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({
        title: 'Instant Move',
        timezone: 'America/New_York',
        startDate: '2099-12-15',
        startTime: '19:00',
        freq: 'weekly',
        count: 1,
      });
    const occId = series.body.occurrences[0].id;
    const moved = await api()
      .post(`/api/v1/organized-play/occurrences/${occId}/reschedule`)
      .set(dm)
      .send({ scheduledAt: '2099-12-17T02:00:00Z', durationMinutes: 120 });
    expect(moved.status).toBe(201);
    expect(moved.body.occurrence.scheduledAt).toBe('2099-12-17T02:00:00.000Z');
    expect(moved.body.occurrence.localStart).toBe('2099-12-16T21:00'); // EST
    expect(moved.body.occurrence.durationMinutes).toBe(120);
    expect(moved.body.conflicts).toEqual([]);
  });

  it('accepts a wall clock + zone on the conflict probe, and rejects a wall clock without one', async () => {
    const ok = await api()
      .post('/api/v1/organized-play/conflicts')
      .set(dm)
      .send({ localStart: '2099-02-24T20:00', timezone: 'America/New_York', durationMinutes: 60, roomId: blueRoomId });
    expect(ok.status).toBe(201);
    expect(ok.body.scheduledAt).toBe('2099-02-25T01:00:00.000Z');
    expect(ok.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);

    const missingZone = await api()
      .post('/api/v1/organized-play/conflicts')
      .set(dm)
      .send({ localStart: '2099-02-24T20:00', durationMinutes: 60, roomId: blueRoomId });
    expect(missingZone.status).toBe(400);

    const neither = await api().post('/api/v1/organized-play/conflicts').set(dm).send({ durationMinutes: 60 });
    expect(neither.status).toBe(400);
  });

  it('re-seats one occurrence and records a reassign exception', async () => {
    const series = await api().get(`/api/v1/campaigns/${campaignId}/series/${dstSeriesId}`).set(dm);
    const target = series.body.occurrences[2];
    const res = await api()
      .post(`/api/v1/organized-play/occurrences/${target.id}/reassign`)
      .set(dm)
      .send({ roomId: redRoomId, assignedDmUserId: 'dev:guest-dm', capacity: 4, reason: 'guest DM night' });
    expect(res.status).toBe(201);
    expect(res.body.occurrence.roomId).toBe(redRoomId);
    expect(res.body.occurrence.assignedDmUserId).toBe('dev:guest-dm');
    expect(res.body.occurrence.capacity).toBe(4);

    const ledger = await api().get(`/api/v1/organized-play/occurrences/${target.id}/exceptions`).set(dm);
    expect(ledger.body.some((e: { kind: string }) => e.kind === 'reassign')).toBe(true);
  });

  it('a series metadata edit skips occurrences that carry their own exception', async () => {
    const before = await api().get(`/api/v1/campaigns/${campaignId}/series/${dstSeriesId}`).set(dm);
    const overridden = before.body.occurrences[2]; // re-seated above
    const untouched = before.body.occurrences[3];

    const res = await api()
      .patch(`/api/v1/campaigns/${campaignId}/series/${dstSeriesId}`)
      .set(dm)
      .send({ title: 'Tuesday Night AL (renamed)' });
    expect(res.status).toBe(200);

    const after = await api().get(`/api/v1/campaigns/${campaignId}/series/${dstSeriesId}`).set(dm);
    const byId = new Map(after.body.occurrences.map((o: { id: number }) => [o.id, o]));
    expect((byId.get(untouched.id) as { title: string }).title).toBe('Tuesday Night AL (renamed)');
    // The overridden one kept the coordinator's decision.
    expect((byId.get(overridden.id) as { title: string }).title).toBe(overridden.title);
  });

  // ----- cancellation -----

  it('cancels a series non-destructively: future occurrences cancelled, rows and RSVPs retained', async () => {
    const created = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({
        title: 'Doomed Thursdays',
        timezone: 'UTC',
        startDate: '2099-04-02',
        startTime: '18:00',
        durationMinutes: 120,
        freq: 'weekly',
        count: 3,
      });
    expect(created.status).toBe(201);
    const occ = created.body.occurrences[0];
    await api().put(`/api/v1/schedule/${occ.id}/rsvp`).set(player).send({ status: 'yes' });

    const cancelled = await api()
      .delete(`/api/v1/campaigns/${campaignId}/series/${created.body.id}`)
      .set(dm)
      .send({ reason: 'store closing' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.occurrences).toHaveLength(3);
    for (const o of cancelled.body.occurrences) {
      expect(o.status).toBe('cancelled');
      expect(o.cancellationReason).toBe('store closing');
      expect(o.icsSequence).toBeGreaterThan(0);
    }
    // The RSVP survives the cancellation (issue #504's guarantee still holds).
    const kept = await api().get(`/api/v1/schedule/${occ.id}`).set(dm);
    expect(kept.body.rsvps).toHaveLength(1);
    // Every cancellation is in the exception ledger.
    expect(cancelled.body.exceptions.filter((e: { kind: string }) => e.kind === 'cancel')).toHaveLength(3);

    // Restoring one night APPENDS to the ledger rather than erasing the cancel —
    // the lineage a coordinator audits from must stay complete.
    const restored = await api().post(`/api/v1/schedule/${occ.id}/restore`).set(dm);
    expect(restored.status).toBe(201);
    expect(restored.body.status).toBe('scheduled');
    const ledger = await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm);
    expect(ledger.body.map((e: { kind: string }) => e.kind)).toEqual(['cancel', 'restore']);
  });

  // ----- ICS -----

  it('publishes stable UIDs: a rescheduled night keeps its UID with a higher SEQUENCE, and a cancelled one emits STATUS:CANCELLED', async () => {
    const feed = await api().post(`/api/v1/campaigns/${campaignId}/calendar-feed`).set(dm);
    expect(feed.status).toBe(201);
    const ics = await api().get(`/api/v1${feed.body.url.replace('/api/v1', '')}`);
    expect(ics.status).toBe(200);

    const calendar = new ICAL.Component(ICAL.parse(ics.text));
    const events = calendar.getAllSubcomponents('vevent');
    const uids = events.map((e) => String(e.getFirstPropertyValue('uid')));
    // UIDs are unique — a reschedule must not have minted a second event.
    expect(new Set(uids).size).toBe(uids.length);

    const series = await api().get(`/api/v1/campaigns/${campaignId}/series/${dstSeriesId}`).set(dm);
    const moved = series.body.occurrences.find((o: { icsSequence: number }) => o.icsSequence > 0);
    const movedEvent = events.find((e) => String(e.getFirstPropertyValue('uid')) === moved.icsUid);
    expect(movedEvent).toBeDefined();
    expect(Number(movedEvent!.getFirstPropertyValue('sequence'))).toBe(moved.icsSequence);

    const cancelledEvents = events.filter((e) => String(e.getFirstPropertyValue('status') ?? '') === 'CANCELLED');
    expect(cancelledEvents.length).toBeGreaterThan(0);
    for (const e of cancelledEvents) {
      // A cancellation is PUBLISHED, not dropped, and carries a bumped SEQUENCE
      // so the subscriber replaces its live copy rather than keeping both.
      expect(Number(e.getFirstPropertyValue('sequence'))).toBeGreaterThan(0);
    }
  });

  it('a plain one-off night keeps the pre-#588 UID so existing subscribers see an update, not a new event', async () => {
    const created = await api()
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-08-01T18:00:00Z', title: 'One-off' });
    expect(created.status).toBe(201);
    expect(created.body.icsUid).toBe(`campfire-c${campaignId}-s${created.body.id}@campfire`);
    expect(created.body.seriesId).toBeNull();
    expect(created.body.roomId).toBeNull();
  });

  it('records an explicit timezone on a one-off night and derives its local wall clock', async () => {
    const created = await api()
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-07-04T23:00:00Z', title: 'Zoned', timezone: 'America/New_York' });
    expect(created.status).toBe(201);
    expect(created.body.timezone).toBe('America/New_York');
    expect(created.body.localStart).toBe('2099-07-04T19:00'); // EDT
  });

  // ----- templates + rotating DMs -----

  it('bulk-creates a block of tables from a template, rotating DMs across simultaneous slots', async () => {
    const template = await api()
      .post('/api/v1/organized-play/templates')
      .set(dm)
      .send({
        name: 'Saturday Block',
        venueId,
        timezone: 'America/New_York',
        freq: 'weekly',
        interval: 1,
        count: 3,
        eventId: 'AL-2099',
        slots: [
          { weekday: 6, startTime: '13:00', durationMinutes: 240, roomId: blueRoomId, capacity: 6, title: 'Table 1' },
          { weekday: 6, startTime: '13:00', durationMinutes: 240, roomId: redRoomId, capacity: 5, title: 'Table 2' },
        ],
      });
    expect(template.status).toBe(201);

    const applied = await api()
      .post(`/api/v1/organized-play/templates/${template.body.id}/apply`)
      .set(dm)
      .send({ campaignId, startDate: '2099-06-01', dmRotation: ['dev:dm-alice', 'dev:dm-bob'] });
    expect(applied.status).toBe(201);
    expect(applied.body.series).toHaveLength(2);
    expect(applied.body.occurrencesCreated).toBe(6);
    expect(applied.body.conflicts).toEqual([]);
    // Rotating is what makes two simultaneous tables legal.
    expect(applied.body.series.map((s: { assignedDmUserId: string }) => s.assignedDmUserId)).toEqual(['dev:dm-alice', 'dev:dm-bob']);
    // 2099-06-01 is a Monday; the first Saturday on/after it is 2099-06-06.
    const detail = await api().get(`/api/v1/campaigns/${campaignId}/series/${applied.body.series[0].id}`).set(dm);
    expect(detail.body.occurrences[0].localStart).toBe('2099-06-06T13:00');
  });

  it('rejects a template application where ONE DM would run two simultaneous tables', async () => {
    const template = await api()
      .post('/api/v1/organized-play/templates')
      .set(dm)
      .send({
        name: 'Impossible Block',
        venueId,
        timezone: 'UTC',
        count: 1,
        slots: [
          { weekday: 0, startTime: '10:00', durationMinutes: 120, roomId: blueRoomId },
          { weekday: 0, startTime: '10:00', durationMinutes: 120, roomId: redRoomId },
        ],
      });
    const applied = await api()
      .post(`/api/v1/organized-play/templates/${template.body.id}/apply`)
      .set(dm)
      .send({ campaignId, startDate: '2099-10-01', dmRotation: ['dev:solo-dm'] });
    expect(applied.status).toBe(409);
    expect(applied.body.code).toBe('SCHEDULE_CONFLICT');
    expect(applied.body.conflicts.some((c: { kind: string }) => c.kind === 'dm')).toBe(true);

    // With two DMs the same block is legal.
    const rotated = await api()
      .post(`/api/v1/organized-play/templates/${template.body.id}/apply`)
      .set(dm)
      .send({ campaignId, startDate: '2099-10-01', dmRotation: ['dev:solo-dm', 'dev:other-dm'] });
    expect(rotated.status).toBe(201);
    expect(rotated.body.series).toHaveLength(2);
  });

  // ----- coordinator calendar -----

  it('shows organized-play bookings on the cross-campaign calendar with seats taken', async () => {
    const res = await api()
      .get('/api/v1/organized-play/calendar')
      .query({ from: '2099-02-01T00:00:00Z', to: '2099-04-01T00:00:00Z', roomId: String(blueRoomId) })
      .set(dm);
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    for (const entry of res.body.entries) {
      expect(entry.roomId).toBe(blueRoomId);
      expect(entry.roomName).toBe('Blue Room');
      expect(entry.venueName).toBe('The Rusty D20');
      expect(entry.visible).toBe(true); // dev users can read every campaign
    }
    const seated = res.body.entries.find((e: { seatsTaken: number }) => e.seatsTaken > 0);
    expect(seated).toBeDefined();
    expect(seated.capacity).toBe(6);
  });

  it('rejects an inverted or oversized calendar window', async () => {
    const inverted = await api()
      .get('/api/v1/organized-play/calendar')
      .query({ from: '2099-04-01T00:00:00Z', to: '2099-02-01T00:00:00Z' })
      .set(dm);
    expect(inverted.status).toBe(400);

    const huge = await api()
      .get('/api/v1/organized-play/calendar')
      .query({ from: '2099-01-01T00:00:00Z', to: '2105-01-01T00:00:00Z' })
      .set(dm);
    expect(huge.status).toBe(400);
  });

  // ----- non-destructive linkage + zero change for opted-out campaigns -----

  it('links an occurrence to a played session and reads attendance without touching either', async () => {
    const created = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Played Series', timezone: 'UTC', startDate: '2020-01-06', startTime: '18:00', freq: 'weekly', count: 1, capacity: 4 });
    expect(created.status).toBe(201);
    const occ = created.body.occurrences[0];

    const character = await api().post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Vex' });
    const session = await api().post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ title: 'Session One' });
    expect(session.status).toBe(201);
    await api().put(`/api/v1/sessions/${session.body.id}/attendance`).set(dm).send({ characterIds: [character.body.id] });

    const linked = await api().post(`/api/v1/schedule/${occ.id}/link/${session.body.id}`).set(dm);
    expect(linked.status).toBe(201);

    const attendance = await api().get(`/api/v1/organized-play/occurrences/${occ.id}/attendance`).set(dm);
    expect(attendance.status).toBe(200);
    expect(attendance.body.sessionId).toBe(session.body.id);
    expect(attendance.body.sessionNumber).toBe(session.body.number);
    expect(attendance.body.attendees).toEqual([{ characterId: character.body.id, characterName: 'Vex' }]);
    expect(attendance.body.capacity).toBe(4);
    expect(attendance.body.seatsRemaining).toBe(4);

    // The recap's own attendance read is unchanged — nothing was mirrored.
    const recap = await api().get(`/api/v1/sessions/${session.body.id}`).set(dm);
    expect(recap.status).toBe(200);
    expect(recap.body.scheduledSessionId).toBe(occ.id);
  });

  it('a campaign that never opts in is unchanged AND invisible to the coordinator calendar', async () => {
    const server = ctx.app.getHttpServer();
    const privateCampaign = (await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Home Game' })).body.id;
    const night = await request(server)
      .post(`/api/v1/campaigns/${privateCampaign}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-02-25T01:00:00Z', title: 'Kitchen table' });
    expect(night.status).toBe(201);
    // Every organized-play field is the empty default — byte-for-byte pre-#588.
    expect(night.body).toMatchObject({
      seriesId: null,
      occurrenceIndex: 0,
      timezone: '',
      localStart: '',
      venueId: null,
      roomId: null,
      assignedDmUserId: '',
      capacity: 0,
      eventId: '',
      seasonId: '',
      icsSequence: 0,
    });

    const calendar = await request(server)
      .get('/api/v1/organized-play/calendar')
      .query({ from: '2099-02-01T00:00:00Z', to: '2099-04-01T00:00:00Z' })
      .set(dm);
    expect(calendar.body.entries.some((e: { campaignId: number | null }) => e.campaignId === privateCampaign)).toBe(false);

    // And it cannot be collided with, so it cannot leak through conflicts either.
    const probe = await request(server)
      .post('/api/v1/organized-play/conflicts')
      .set(dm)
      .send({ scheduledAt: '2099-02-25T01:30:00Z', durationMinutes: 60, memberUserIds: ['dev:op-dm'] });
    expect(probe.body.conflicts.every((c: { campaignId: number | null }) => c.campaignId !== privateCampaign)).toBe(true);
  });

  it('deleting a room keeps the bookings and just frees the resource', async () => {
    const venue = await api().post('/api/v1/organized-play/venues').set(dm).send({ name: 'Pop-up Shop', timezone: 'UTC' });
    const room = await api().post(`/api/v1/organized-play/venues/${venue.body.id}/rooms`).set(dm).send({ name: 'Corner' });
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Pop-up', timezone: 'UTC', startDate: '2099-11-07', startTime: '12:00', freq: 'weekly', count: 1, roomId: room.body.id });
    expect(series.status).toBe(201);
    const occId = series.body.occurrences[0].id;

    const deleted = await api().delete(`/api/v1/organized-play/rooms/${room.body.id}`).set(dm);
    expect(deleted.status).toBe(200);

    const night = await api().get(`/api/v1/schedule/${occId}`).set(dm);
    expect(night.status).toBe(200); // the game night survives its room
    expect(night.body.roomId).toBeNull();
    expect(night.body.status).toBe('scheduled');
  });

  it('deleting a room also clears it from template slots, so the template still applies', async () => {
    const venue = await api().post('/api/v1/organized-play/venues').set(dm).send({ name: 'Slot Repair Hall', timezone: 'UTC' });
    const doomed = await api().post(`/api/v1/organized-play/venues/${venue.body.id}/rooms`).set(dm).send({ name: 'Doomed' });
    const kept = await api().post(`/api/v1/organized-play/venues/${venue.body.id}/rooms`).set(dm).send({ name: 'Kept' });

    const template = await api()
      .post('/api/v1/organized-play/templates')
      .set(dm)
      .send({
        name: 'Two Table Block',
        timezone: 'UTC',
        venueId: venue.body.id,
        count: 1,
        slots: [
          { weekday: 1, startTime: '18:00', roomId: doomed.body.id, title: 'Table A' },
          { weekday: 1, startTime: '18:00', roomId: kept.body.id, title: 'Table B' },
        ],
      });
    expect(template.status).toBe(201);

    expect((await api().delete(`/api/v1/organized-play/rooms/${doomed.body.id}`).set(dm)).status).toBe(200);

    // The relational updates cannot reach a room id embedded in slots_json, so
    // the deletion has to reconcile the JSON too. Left stale, the reference below
    // would 404 on getRoomOrThrow on EVERY later apply, permanently — there is no
    // template-update endpoint to repair it.
    const listed = (await api().get('/api/v1/organized-play/templates').set(dm)).body.find(
      (t: { id: number }) => t.id === template.body.id,
    );
    expect(listed.slots[0].roomId).toBeNull();
    expect(listed.slots[1].roomId).toBe(kept.body.id); // untouched

    const applied = await api()
      .post(`/api/v1/organized-play/templates/${template.body.id}/apply`)
      .set(dm)
      .send({ campaignId, startDate: '2100-01-04' });
    expect(applied.status).toBe(201);
    expect(applied.body.series).toHaveLength(2);
    const tableA = applied.body.series.find((s: { title: string }) => s.title === 'Table A');
    expect(tableA.roomId).toBeNull(); // bookable with no room, exactly like the freed bookings above
  });

  it('rejects a non-numeric venueId/roomId calendar filter instead of coercing it to NaN', async () => {
    const window = 'from=2099-01-01T00:00:00Z&to=2099-02-01T00:00:00Z';
    // `Number('abc')` is NaN, which reached the service as a filter matching
    // nothing — an empty calendar the caller could not tell apart from a real one.
    expect((await api().get(`/api/v1/organized-play/calendar?${window}&venueId=abc`).set(dm)).status).toBe(400);
    expect((await api().get(`/api/v1/organized-play/calendar?${window}&roomId=12.5`).set(dm)).status).toBe(400);
    expect((await api().get(`/api/v1/organized-play/calendar?${window}&venueId=0`).set(dm)).status).toBe(400);
    // Absent and empty both mean "no filter" and stay 200.
    expect((await api().get(`/api/v1/organized-play/calendar?${window}&roomId=`).set(dm)).status).toBe(200);
    expect((await api().get(`/api/v1/organized-play/calendar?${window}&venueId=${venueId}`).set(dm)).status).toBe(200);
  });

  // ----- the legacy one-off endpoints must not bypass the organized-play guards -----

  it('the legacy schedule PATCH refuses to MOVE a series occurrence, but still edits its prose', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({
        title: 'Legacy Patch Guard',
        timezone: 'UTC',
        startDate: '2099-06-02',
        startTime: '18:00',
        durationMinutes: 180,
        freq: 'weekly',
        count: 1,
        roomId: blueRoomId,
        assignedDmUserId: 'dev:legacy-dm',
      });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[0];

    // PATCH /schedule/:id runs no findConflictRows probe and writes no ledger
    // entry, so letting it slide the window while the row still holds its room
    // and its assigned DM would defeat both halves of the guarantee at once.
    const moved = await api().patch(`/api/v1/schedule/${occ.id}`).set(dm).send({ scheduledAt: '2099-06-03T18:00:00Z' });
    expect(moved.status).toBe(400);
    expect(moved.body.message).toContain('reschedule');
    // Growing the window can collide with whatever holds the room next.
    expect((await api().patch(`/api/v1/schedule/${occ.id}`).set(dm).send({ durationMinutes: 600 })).status).toBe(400);

    // Nothing moved, and no ledger entry was invented for the rejected attempt.
    const after = await api().get(`/api/v1/schedule/${occ.id}`).set(dm);
    expect(after.body.scheduledAt).toBe(occ.scheduledAt);
    expect(after.body.durationMinutes).toBe(180);
    expect((await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body).toEqual([]);

    // Re-sending the instant the row already holds is not a move, so it passes —
    // the guard compares the STORED value, so the full-object edit form still works.
    expect((await api().patch(`/api/v1/schedule/${occ.id}`).set(dm).send({ scheduledAt: occ.scheduledAt })).status).toBe(200);
    // SHRINKING is always allowed: the window strictly contracts, so it can
    // introduce no overlap, and it is exactly how mid-session "End session"
    // (#818) works on a row that happens to belong to a series.
    const shrunk = await api().patch(`/api/v1/schedule/${occ.id}`).set(dm).send({ durationMinutes: 60 });
    expect(shrunk.status).toBe(200);
    expect(shrunk.body.durationMinutes).toBe(60);
    // Prose holds no shared resource and cannot collide, so it stays editable here.
    const renamed = await api().patch(`/api/v1/schedule/${occ.id}`).set(dm).send({ title: 'Renamed in place', notes: 'bring dice' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ title: 'Renamed in place', notes: 'bring dice' });

    // The dedicated endpoint is the way through, and it records the lineage.
    const viaReschedule = await api()
      .post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`)
      .set(dm)
      .send({ scheduledAt: '2099-06-03T18:00:00Z' });
    expect(viaReschedule.status).toBe(201);
    expect((await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body).toHaveLength(1);

    // A one-off night holds no series and is untouched by the guard.
    const oneOff = await api().post(`/api/v1/campaigns/${campaignId}/schedule`).set(dm).send({ scheduledAt: '2099-06-10T18:00:00Z' });
    expect((await api().patch(`/api/v1/schedule/${oneOff.body.id}`).set(dm).send({ scheduledAt: '2099-06-11T18:00:00Z' })).status).toBe(200);
  });

  it('rejects an invalid explicit timezone on a one-off night instead of silently ignoring it', async () => {
    // `organizedPlayScheduleFields.timezone` is a plain bounded string, so this
    // body reaches the service; three other paths reject the same value, and
    // "accepted but ignored" is a write the client has no way to detect.
    const bad = await api()
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-07-05T18:00:00Z', timezone: 'Mars/Base' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('Mars/Base');

    // '' still means "no explicit zone" — legacy rows depend on it.
    const noZone = await api()
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-07-06T18:00:00Z', timezone: '' });
    expect(noZone.status).toBe(201);
    expect(noZone.body).toMatchObject({ timezone: '', localStart: '' });

    // Omitting the field entirely behaves identically.
    const omitted = await api().post(`/api/v1/campaigns/${campaignId}/schedule`).set(dm).send({ scheduledAt: '2099-07-07T18:00:00Z' });
    expect(omitted.status).toBe(201);
    expect(omitted.body).toMatchObject({ timezone: '', localStart: '' });
  });

  it('a notes-only edit bumps SEQUENCE, because notes render as DESCRIPTION in the feed', async () => {
    const night = await api()
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-07-01T18:00:00Z', title: 'Seq Night', notes: 'first draft' });
    expect(night.status).toBe(201);
    const seq0 = (await api().get(`/api/v1/schedule/${night.body.id}`).set(dm)).body.icsSequence;

    // LAST-MODIFIED does still advance on this edit, so a lenient client picked
    // the new DESCRIPTION up regardless; a client that gates revisions on
    // SEQUENCE (RFC 5545 §3.8.7.4 permits it) kept the stale one forever.
    const edited = await api().patch(`/api/v1/schedule/${night.body.id}`).set(dm).send({ notes: 'actually, bring snacks' });
    expect(edited.status).toBe(200);
    expect(edited.body.icsSequence).toBe(seq0 + 1);

    // A no-op re-send must NOT push a fresh revision at every subscriber.
    const noop = await api().patch(`/api/v1/schedule/${night.body.id}`).set(dm).send({ notes: 'actually, bring snacks' });
    expect(noop.body.icsSequence).toBe(seq0 + 1);
  });

  // ----- exception ledger integrity -----

  it('cancelling ONE occurrence appends a cancel entry, so a later restore is not an orphan', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Skip One', timezone: 'UTC', startDate: '2099-08-04', startTime: '18:00', freq: 'weekly', count: 3 });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[1];

    // DELETE /schedule/:id is the ONLY exposed way to cancel a single occurrence,
    // so without an entry here a skipped night carried no recorded reason at all.
    const cancelled = await api().delete(`/api/v1/schedule/${occ.id}`).set(dm).send({ reason: 'DM has flu' });
    expect(cancelled.status).toBe(200);
    const ledger = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      kind: 'cancel',
      reason: 'DM has flu',
      fromScheduledAt: occ.scheduledAt,
      toScheduledAt: null,
      recurrenceLocalDate: '2099-08-11',
    });

    const restored = await api().post(`/api/v1/schedule/${occ.id}/restore`).set(dm).send({});
    expect(restored.status).toBe(201);
    const after = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body;
    // Append-only, and the restore now has the cancel it explains sitting in
    // front of it under the same recurrence id.
    expect(after.map((e: { kind: string }) => e.kind)).toEqual(['cancel', 'restore']);
    expect(after.every((e: { recurrenceLocalDate: string }) => e.recurrenceLocalDate === '2099-08-11')).toBe(true);

    // A one-off night has no series, so it writes no ledger entry at all.
    const oneOff = await api().post(`/api/v1/campaigns/${campaignId}/schedule`).set(dm).send({ scheduledAt: '2099-08-25T18:00:00Z' });
    expect((await api().delete(`/api/v1/schedule/${oneOff.body.id}`).set(dm).send({ reason: 'no' })).status).toBe(200);
    expect((await api().get(`/api/v1/organized-play/occurrences/${oneOff.body.id}/exceptions`).set(dm)).body).toEqual([]);
  });

  it('a twice-moved occurrence files every ledger entry under ONE recurrence id', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Moved Twice', timezone: 'America/New_York', startDate: '2099-08-18', startTime: '19:00', freq: 'weekly', count: 2 });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[0]; // materialized on 2099-08-18 local

    expect(
      (await api().post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`).set(dm).send({ localStart: '2099-08-20T19:00' })).status,
    ).toBe(201);
    expect(
      (await api().post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`).set(dm).send({ localStart: '2099-08-21T19:00' })).status,
    ).toBe(201);
    expect((await api().post(`/api/v1/organized-play/occurrences/${occ.id}/reassign`).set(dm).send({ capacity: 3 })).status).toBe(201);

    const ledger = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body;
    expect(ledger).toHaveLength(3);
    // Derived from `original_scheduled_at`, never from the (now moved) wall
    // clock: one logical occurrence keeps one recurrence id however often it
    // moves, which is the only way the ledger can line its entries up.
    expect(ledger.map((e: { recurrenceLocalDate: string }) => e.recurrenceLocalDate)).toEqual(['2099-08-18', '2099-08-18', '2099-08-18']);
  });

  // ----- conflict checks the bulk paths were missing -----

  it('a series metadata edit that re-books a room runs the conflict check and honours force', async () => {
    const bulkRoom = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Bulk Room' })).body;

    // The incumbent, in a different campaign, holding Bulk Room on the second week.
    const incumbent = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({ title: 'Incumbent', timezone: 'UTC', startDate: '2099-10-13', startTime: '18:00', freq: 'weekly', count: 1, roomId: bulkRoom.id });
    expect(incumbent.status).toBe(201);

    // A roomless series whose second occurrence lands on the same slot.
    const mine = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Fanned Out', timezone: 'UTC', startDate: '2099-10-06', startTime: '18:00', freq: 'weekly', count: 2 });
    expect(mine.status).toBe(201);

    // A plain metadata PATCH is a BULK reassignment when it carries roomId: it
    // books the room on every future unoverridden occurrence at once. Before this
    // it was the one endpoint that could do that with no probe, no 409 and no
    // way for the caller to learn it had double-booked anyone.
    const rejected = await api().patch(`/api/v1/campaigns/${campaignId}/series/${mine.body.id}`).set(dm).send({ roomId: bulkRoom.id });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('SCHEDULE_CONFLICT');
    expect(rejected.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);

    // Rolled back whole: not even the series-level metadata was written.
    const untouched = await api().get(`/api/v1/campaigns/${campaignId}/series/${mine.body.id}`).set(dm);
    expect(untouched.body.roomId).toBeNull();
    expect(untouched.body.occurrences.every((o: { roomId: number | null }) => o.roomId === null)).toBe(true);

    // Same override the per-occurrence siblings offer, spelled the same way.
    const forced = await api()
      .patch(`/api/v1/campaigns/${campaignId}/series/${mine.body.id}`)
      .set(dm)
      .send({ roomId: bulkRoom.id, force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.roomId).toBe(bulkRoom.id);
    expect(forced.body.occurrences.every((o: { roomId: number | null }) => o.roomId === bulkRoom.id)).toBe(true);

    // A metadata-only edit holds no booking, so it never probes and never 409s.
    const prose = await api().patch(`/api/v1/campaigns/${campaignId}/series/${mine.body.id}`).set(dm).send({ title: 'Fanned Out (v2)' });
    expect(prose.status).toBe(200);
  });

  it('a series notes edit bumps SEQUENCE on the occurrences it rewrites', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Notes Fanout', timezone: 'UTC', startDate: '2099-10-20', startTime: '18:00', freq: 'weekly', count: 2, notes: 'v1' });
    expect(series.status).toBe(201);
    const before = series.body.occurrences.map((o: { id: number; icsSequence: number }) => [o.id, o.icsSequence]);

    // `notes` is written to every affected occurrence and renders as DESCRIPTION,
    // so it belongs in the `renders` predicate exactly as title and location do.
    const edited = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ notes: 'v2 — new venue rules' });
    expect(edited.status).toBe(200);
    const after = new Map(edited.body.occurrences.map((o: { id: number; icsSequence: number; notes: string }) => [o.id, o]));
    for (const [id, seq] of before) {
      expect(after.get(id)).toMatchObject({ notes: 'v2 — new venue rules', icsSequence: seq + 1 });
    }

    // Unchanged notes are still a no-op.
    const noop = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ notes: 'v2 — new venue rules' });
    for (const [id, seq] of before) {
      expect(noop.body.occurrences.find((o: { id: number }) => o.id === id).icsSequence).toBe(seq + 1);
    }
  });

  it('an extension that would double-book ITSELF across a DST transition is rejected', async () => {
    const dstRoom = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'DST Room' })).body;

    // Daily 24-hour tables: back-to-back while the local day really is 24 hours,
    // so the series creates cleanly.
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({
        title: 'Marathon',
        timezone: 'America/New_York',
        startDate: '2099-03-05',
        startTime: '19:00',
        durationMinutes: 1440,
        freq: 'daily',
        count: 2,
        roomId: dstRoom.id,
      });
    expect(series.status).toBe(201);

    // Extending across the 2099-03-08 spring-forward makes that local day 23
    // hours, so the 07:00 and 08:00 tables overlap by an hour. NEITHER row is in
    // the database during the probe, so only an intra-batch check can see it —
    // create and applyTemplate already ran one, extend did not.
    const rejected = await api().post(`/api/v1/campaigns/${campaignId}/series/${series.body.id}/extend`).set(dm).send({ addCount: 4 });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('SCHEDULE_CONFLICT');
    expect(rejected.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);

    // Nothing was materialized: the rejection rolls the whole extension back.
    const stillTwo = await api().get(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm);
    expect(stillTwo.body.occurrences).toHaveLength(2);
    expect(stillTwo.body.count).toBe(2);

    // The coordinator can still overbook deliberately.
    const forced = await api().post(`/api/v1/campaigns/${campaignId}/series/${series.body.id}/extend`).set(dm).send({ addCount: 4, force: true });
    expect(forced.status).toBe(201);
    expect(forced.body.occurrences).toHaveLength(6);
  });
});
