import ICAL from 'ical.js';
import request from 'supertest';
import type { Database } from 'better-sqlite3';
import { DB_HOLDER, type DbHolder } from '../src/db/db.module';
import { OrganizedPlayService } from '../src/modules/sessions/organized-play.service';
import { SchedulingService } from '../src/modules/sessions/scheduling.service';
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

  it('resending an occurrence’s current state is a no-op, even when it sits in a forced overlap (#1603)', async () => {
    const first = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({
        title: 'Overlap A',
        timezone: 'America/New_York',
        startDate: '2099-05-01',
        startTime: '19:00',
        durationMinutes: 240,
        freq: 'weekly',
        count: 1,
        roomId: redRoomId,
      });
    expect(first.status).toBe(201);

    const second = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({
        title: 'Overlap B',
        timezone: 'America/New_York',
        startDate: '2099-05-01',
        startTime: '19:00',
        durationMinutes: 240,
        freq: 'weekly',
        count: 1,
        roomId: redRoomId,
        force: true,
      });
    expect(second.status).toBe(201);

    const occ = second.body.occurrences[0];
    const before = await api().get(`/api/v1/schedule/${occ.id}`).set(dm);
    const sequenceBefore = before.body.icsSequence;
    const ledgerBefore = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body;

    const retry = await api()
      .post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`)
      .set(dm)
      .send({
        localStart: occ.localStart,
        durationMinutes: occ.durationMinutes,
        roomId: occ.roomId,
      });
    expect(retry.status).toBe(201);
    expect(retry.body.occurrence.icsSequence).toBe(sequenceBefore);
    expect(retry.body.occurrence.scheduledAt).toBe(occ.scheduledAt);
    expect(retry.body.occurrence.roomId).toBe(occ.roomId);

    const ledgerAfter = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body;
    expect(ledgerAfter).toEqual(ledgerBefore);
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

  // Issue #1671: #1555 established that only cancellation releases a room/DM — a
  // genuinely completed occurrence still holds its resource. cancelSeries() used to
  // filter its "which future occurrences do I touch" query on scheduleLiveSql(),
  // which excludes a genuinely completed row, so a future-dated occurrence completed
  // early (or out of order — the DM linked a recap before the occurrence's own
  // scheduledAt arrived) fell straight through untouched: still `completed`, still
  // holding its room, forever, for a series that no longer exists.
  it('cancelling a series releases the room held by a future-dated occurrence already marked completed', async () => {
    const room = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Early Room' })).body;
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({
        title: 'Played Ahead Of Schedule',
        timezone: 'UTC',
        startDate: '2099-08-06',
        startTime: '18:00',
        durationMinutes: 180,
        freq: 'weekly',
        count: 1,
        roomId: room.id,
      });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[0];

    // The DM ran the session ahead of its scheduled slot and linked the recap
    // immediately — the occurrence is genuinely `completed` while its own
    // `scheduledAt` is still in the future.
    const recap = await api().post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ title: 'Played early' });
    const linked = await api().post(`/api/v1/schedule/${occ.id}/link/${recap.body.id}`).set(dm);
    expect(linked.status).toBe(201);
    expect(linked.body.status).toBe('completed');

    // While completed, the room is correctly still reported taken (#1555) — a
    // rival campaign cannot book straight over it.
    const stillHeld = await api()
      .post('/api/v1/organized-play/conflicts')
      .set(dm)
      .send({ scheduledAt: occ.scheduledAt, durationMinutes: 180, roomId: room.id });
    expect(stillHeld.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);

    // Cancel the whole series.
    const cancelled = await api().delete(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ reason: 'campaign folded' });
    expect(cancelled.status).toBe(200);

    // The completed-but-future occurrence must be swept into the cancellation like
    // every other future occurrence — it is not left behind as a permanently
    // resource-holding orphan of a series that no longer exists.
    const after = await api().get(`/api/v1/schedule/${occ.id}`).set(dm);
    expect(after.body.status).toBe('cancelled');
    expect(after.body.cancellationReason).toBe('campaign folded');

    // …so the room is free again: a rival campaign can now book the exact same
    // window without a conflict or `force`.
    const rival = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({ title: 'Took The Room After Cancel', timezone: 'UTC', startDate: '2099-08-06', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 1, roomId: room.id });
    expect(rival.status).toBe(201);
  });

  it('restoring a cancelled future occurrence with a live recap preserves completed status', async () => {
    const room = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Restore Completed Room' })).body;
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({
        title: 'Restore Played Early',
        timezone: 'UTC',
        startDate: '2099-08-13',
        startTime: '18:00',
        durationMinutes: 180,
        freq: 'weekly',
        count: 1,
        roomId: room.id,
      });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[0];

    const recap = await api().post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ title: 'Restored recap' });
    expect(recap.status).toBe(201);
    const linked = await api().post(`/api/v1/schedule/${occ.id}/link/${recap.body.id}`).set(dm);
    expect(linked.status).toBe(201);
    expect(linked.body.status).toBe('completed');

    const cancelled = await api().delete(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ reason: 'pause series' });
    expect(cancelled.status).toBe(200);
    expect((await api().get(`/api/v1/schedule/${occ.id}`).set(dm)).body).toMatchObject({ status: 'cancelled', sessionId: null });

    const restored = await api().post(`/api/v1/schedule/${occ.id}/restore`).set(dm).send({});
    expect(restored.status).toBe(201);
    expect(restored.body).toMatchObject({ status: 'completed', sessionId: recap.body.id });
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
    // …and that prose edit IS recorded, as a non-override `edit`. It previously
    // left no trace at all, so the lineage could not show a per-occurrence edit
    // had happened. See the dedicated test for why `edit` must not be treated as
    // a metadata override.
    expect(
      (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body.map((e: { kind: string }) => e.kind),
    ).toEqual(['edit']);

    // The dedicated endpoint is the way through, and it records the lineage.
    const viaReschedule = await api()
      .post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`)
      .set(dm)
      .send({ scheduledAt: '2099-06-03T18:00:00Z' });
    expect(viaReschedule.status).toBe(201);
    expect(
      (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body.map((e: { kind: string }) => e.kind),
    ).toEqual(['edit', 'reschedule']);

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

  it('bumps SEQUENCE when a notes REVISION is restored, which is a publish like any other edit', async () => {
    const night = await api()
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-07-08T18:00:00Z', title: 'Revision Night', notes: 'bring the map' });
    expect(night.status).toBe(201);
    const id = night.body.id as number;

    const edited = await api().patch(`/api/v1/schedule/${id}`).set(dm).send({ notes: 'map cancelled, bring snacks' });
    expect(edited.status).toBe(200);
    const seqAfterEdit = edited.body.icsSequence as number;

    // Restoring the older revision changes the DESCRIPTION subscribers see, so it
    // is a published revision and needs its own SEQUENCE. #588 is what coupled
    // notes to the feed; before this the restore wrote the column and left the
    // sequence alone, so a client that gates on SEQUENCE (RFC 5545 §3.8.7.4)
    // went on showing "map cancelled" indefinitely.
    const revisions = await api().get(`/api/v1/revisions/scheduled_session/${id}`).set(dm);
    expect(revisions.status).toBe(200);
    const original = revisions.body.find((r: { snapshot: Record<string, string> }) => r.snapshot.notes === 'bring the map');
    expect(original).toBeDefined();

    const restored = await api().post(`/api/v1/revisions/scheduled_session/${id}/${original.id}/restore`).set(dm).send({});
    expect(restored.status).toBe(201);
    const afterRestore = await api().get(`/api/v1/schedule/${id}`).set(dm);
    expect(afterRestore.body.notes).toBe('bring the map');
    expect(afterRestore.body.icsSequence).toBe(seqAfterEdit + 1);

    // …and restoring the revision that is ALREADY live changes nothing a
    // subscriber can see, so it must not push one at them — the same no-op rule
    // the PATCH path follows.
    const again = await api().post(`/api/v1/revisions/scheduled_session/${id}/${original.id}/restore`).set(dm).send({});
    expect(again.status).toBe(201);
    expect((await api().get(`/api/v1/schedule/${id}`).set(dm)).body.icsSequence).toBe(seqAfterEdit + 1);
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

  it('refuses to address a series through a campaign it does not belong to', async () => {
    const theirs = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({ title: 'Not Yours', timezone: 'UTC', startDate: '2099-07-14', startTime: '18:00', freq: 'weekly', count: 1 });
    expect(theirs.status).toBe(201);
    const id = theirs.body.id;

    // Being a DM of campaignId and the series existing are two separately-correct
    // facts that do NOT compose into authorization. Every campaign-scoped series
    // handler must reject the mismatch, so the guard's PLACEMENT is what is
    // asserted here rather than one handler's behaviour.
    expect((await api().get(`/api/v1/campaigns/${campaignId}/series/${id}`).set(dm)).status).toBe(404);
    expect((await api().patch(`/api/v1/campaigns/${campaignId}/series/${id}`).set(dm).send({ title: 'Hijacked' })).status).toBe(404);
    expect((await api().post(`/api/v1/campaigns/${campaignId}/series/${id}/extend`).set(dm).send({ addCount: 1 })).status).toBe(404);
    expect((await api().delete(`/api/v1/campaigns/${campaignId}/series/${id}`).set(dm).send({})).status).toBe(404);

    // 404 and not 403: the status code itself must not become a cross-campaign
    // existence probe.
    expect((await api().get(`/api/v1/campaigns/${campaignId}/series/99999999`).set(dm)).status).toBe(404);

    // Nothing was written through the mismatched route, and the owning campaign
    // still works normally.
    const owner = await api().get(`/api/v1/campaigns/${otherCampaignId}/series/${id}`).set(dm);
    expect(owner.status).toBe(200);
    expect(owner.body.title).toBe('Not Yours');
    expect(owner.body.occurrences).toHaveLength(1);
    expect(owner.body.status).toBe('active');
  });

  it('rejects renaming a room onto a sibling name with 400, not a constraint 500', async () => {
    const venue = await api().post('/api/v1/organized-play/venues').set(dm).send({ name: 'Rename Hall', timezone: 'UTC' });
    const a = await api().post(`/api/v1/organized-play/venues/${venue.body.id}/rooms`).set(dm).send({ name: 'Alpha' });
    const b = await api().post(`/api/v1/organized-play/venues/${venue.body.id}/rooms`).set(dm).send({ name: 'Beta' });

    // The create path validated this and the update path did not, so the raw
    // UNIQUE(venue_id, name) index surfaced as a 500 on identical bad input.
    const clash = await api().patch(`/api/v1/organized-play/rooms/${b.body.id}`).set(dm).send({ name: 'Alpha' });
    expect(clash.status).toBe(400);

    // Renaming to its own name is not a clash, and neither is a free name.
    expect((await api().patch(`/api/v1/organized-play/rooms/${b.body.id}`).set(dm).send({ name: 'Beta', capacity: 7 })).status).toBe(200);
    expect((await api().patch(`/api/v1/organized-play/rooms/${b.body.id}`).set(dm).send({ name: 'Gamma' })).status).toBe(200);
    // A same-named room in a DIFFERENT venue is fine — the constraint is per-venue.
    const other = await api().post('/api/v1/organized-play/venues').set(dm).send({ name: 'Other Hall', timezone: 'UTC' });
    const elsewhere = await api().post(`/api/v1/organized-play/venues/${other.body.id}/rooms`).set(dm).send({ name: 'Zeta' });
    expect((await api().patch(`/api/v1/organized-play/rooms/${elsewhere.body.id}`).set(dm).send({ name: 'Alpha' })).status).toBe(200);
    expect(a.body.name).toBe('Alpha');
  });

  it('a DM-only series edit does not re-flag the room it left alone', async () => {
    const quietRoom = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Quiet Room' })).body;
    // Occurrences that genuinely overlap (24h local tables across spring-forward),
    // already holding BOTH a room and a DM. Forced, so the overlap is on the record.
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({
        title: 'Already Overlapping',
        timezone: 'America/New_York',
        startDate: '2099-03-06',
        startTime: '19:00',
        durationMinutes: 1440,
        freq: 'daily',
        count: 4,
        roomId: quietRoom.id,
        assignedDmUserId: 'dev:quiet-dm',
        force: true,
      });
    expect(series.status).toBe(201);

    // Unassigning the DM changes only the DM. The room is untouched and must not be
    // re-probed: the intra-batch scan groups by room as well as by DM, so passing
    // the unchanged room would flag the series against ITSELF over an overlap this
    // edit did not introduce, pushing the coordinator into forcing a no-op.
    const dmOnly = await api()
      .patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`)
      .set(dm)
      .send({ assignedDmUserId: '' });
    expect(dmOnly.status).toBe(200);
    expect(dmOnly.body.conflicts).toEqual([]);
    expect(dmOnly.body.occurrences.every((o: { assignedDmUserId: string }) => o.assignedDmUserId === '')).toBe(true);
    // …and the room really was left alone rather than cleared.
    expect(dmOnly.body.occurrences.every((o: { roomId: number | null }) => o.roomId === quietRoom.id)).toBe(true);

    // Positive control: the fix NARROWED the check, it did not disable it. Putting
    // one DM back onto these overlapping tables is a real clash and still 409s.
    const realClash = await api()
      .patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`)
      .set(dm)
      .send({ assignedDmUserId: 'dev:quiet-dm' });
    expect(realClash.status).toBe(409);
    expect(realClash.body.conflicts.some((c: { kind: string }) => c.kind === 'dm')).toBe(true);
  });

  it('reports what a forced series booking overbooked, on create and on extend', async () => {
    const contested = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Contested Room' })).body;
    const incumbent = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({ title: 'Incumbent', timezone: 'UTC', startDate: '2099-12-01', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 2, roomId: contested.id });
    expect(incumbent.status).toBe(201);

    // `force` is only defensible if the caller can SEE what they overrode, so a
    // forced create must report it rather than returning a bare 201.
    const forcedCreate = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Forced Over', timezone: 'UTC', startDate: '2099-12-01', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 1, roomId: contested.id, force: true });
    expect(forcedCreate.status).toBe(201);
    expect(forcedCreate.body.conflicts.length).toBeGreaterThan(0);
    expect(forcedCreate.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);

    // …and so must a forced extend, onto the incumbent's second week.
    const forcedExtend = await api()
      .post(`/api/v1/campaigns/${campaignId}/series/${forcedCreate.body.id}/extend`)
      .set(dm)
      .send({ addCount: 1, force: true });
    expect(forcedExtend.status).toBe(201);
    expect(forcedExtend.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);

    // A read never forces anything, so it reports nothing.
    const read = await api().get(`/api/v1/campaigns/${campaignId}/series/${forcedCreate.body.id}`).set(dm);
    expect(read.body.conflicts).toEqual([]);
    // An unforced, uncontested create likewise.
    const clean = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Uncontested', timezone: 'UTC', startDate: '2099-12-22', startTime: '09:00', freq: 'weekly', count: 1 });
    expect(clean.body.conflicts).toEqual([]);
  });

  it('keeps a cancelled occurrence current without pushing it a fresh SEQUENCE', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Seq Policy', timezone: 'UTC', startDate: '2099-11-02', startTime: '18:00', freq: 'weekly', count: 2 });
    expect(series.status).toBe(201);
    const cancelled = series.body.occurrences[0];
    const live = series.body.occurrences[1];

    expect((await api().delete(`/api/v1/schedule/${cancelled.id}`).set(dm).send({ reason: 'skip' })).status).toBe(200);
    const seqAfterCancel = (await api().get(`/api/v1/schedule/${cancelled.id}`).set(dm)).body.icsSequence;

    const edited = await api()
      .patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`)
      .set(dm)
      .send({ title: 'Seq Policy (renamed)' });
    expect(edited.status).toBe(200);

    const byId = new Map(edited.body.occurrences.map((o: { id: number }) => [o.id, o]));
    // Metadata IS applied, so a later restore brings the night back current
    // rather than carrying whatever the series said on the day it was cancelled.
    expect(byId.get(cancelled.id)).toMatchObject({ title: 'Seq Policy (renamed)' });
    // …but SEQUENCE does not move: the feed publishes this row as
    // STATUS:CANCELLED, so a revision would describe an event that is not
    // happening and whose visible content did not change.
    expect((byId.get(cancelled.id) as { icsSequence: number }).icsSequence).toBe(seqAfterCancel);
    // The live sibling gets both.
    expect(byId.get(live.id)).toMatchObject({ title: 'Seq Policy (renamed)', icsSequence: live.icsSequence + 1 });
  });

  it('detects a batch overlap that is NOT between sorted-adjacent occurrences', async () => {
    const sweepRoom = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Sweep Room' })).body;
    // Three slots in one template, sorted by start: a LONG one that swallows the
    // gap between two short ones.
    //   A = 10:00-14:00, B = 11:00-12:00, C = 12:30-13:00
    // A-B overlaps; B-C does not (B ends 12:00, C starts 12:30). An
    // adjacent-pairs scan stops there and reports clean, but A-C genuinely
    // double-books the room. Only a sweep carrying the maximum end seen so far
    // catches it.
    const template = await api()
      .post('/api/v1/organized-play/templates')
      .set(dm)
      .send({
        name: 'Non Adjacent Overlap',
        timezone: 'UTC',
        count: 1,
        slots: [
          { weekday: 1, startTime: '10:00', durationMinutes: 240, roomId: sweepRoom.id, title: 'A long' },
          { weekday: 1, startTime: '11:00', durationMinutes: 60, roomId: sweepRoom.id, title: 'B short' },
          { weekday: 1, startTime: '12:30', durationMinutes: 30, roomId: sweepRoom.id, title: 'C short' },
        ],
      });
    expect(template.status).toBe(201);

    const rejected = await api()
      .post(`/api/v1/organized-play/templates/${template.body.id}/apply`)
      .set(dm)
      .send({ campaignId, startDate: '2100-08-02' });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('SCHEDULE_CONFLICT');
    expect(rejected.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);
    // Nothing was created by the rejected batch.
    const seriesAfter = await api().get(`/api/v1/campaigns/${campaignId}/series`).set(dm);
    expect(seriesAfter.body.some((s: { title: string }) => s.title === 'A long')).toBe(false);

    // Control: the same three windows in DIFFERENT rooms collide with nothing,
    // so the sweep is not simply flagging everything.
    const roomB = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Sweep B' })).body;
    const roomC = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Sweep C' })).body;
    const spread = await api()
      .post('/api/v1/organized-play/templates')
      .set(dm)
      .send({
        name: 'Same Windows Different Rooms',
        timezone: 'UTC',
        count: 1,
        slots: [
          { weekday: 1, startTime: '10:00', durationMinutes: 240, roomId: sweepRoom.id, title: 'A2' },
          { weekday: 1, startTime: '11:00', durationMinutes: 60, roomId: roomB.id, title: 'B2' },
          { weekday: 1, startTime: '12:30', durationMinutes: 30, roomId: roomC.id, title: 'C2' },
        ],
      });
    const ok = await api()
      .post(`/api/v1/organized-play/templates/${spread.body.id}/apply`)
      .set(dm)
      .send({ campaignId, startDate: '2100-09-06' });
    expect(ok.status).toBe(201);
    expect(ok.body.series).toHaveLength(3);
  });

  it('records the reason a night was restored, so the ledger explains itself', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Flooded', timezone: 'UTC', startDate: '2100-10-04', startTime: '18:00', freq: 'weekly', count: 1 });
    const occ = series.body.occurrences[0];

    expect((await api().delete(`/api/v1/schedule/${occ.id}`).set(dm).send({ reason: 'venue flooded' })).status).toBe(200);
    expect(
      (await api().post(`/api/v1/schedule/${occ.id}/restore`).set(dm).send({ reason: 'water cleared, venue reopened' })).status,
    ).toBe(201);

    const ledger = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body;
    // Both halves of the story, not just the cancellation: a restore explaining
    // nothing leaves a reader unable to tell recovery from a misclick.
    expect(ledger.map((e: { kind: string; reason: string }) => [e.kind, e.reason])).toEqual([
      ['cancel', 'venue flooded'],
      ['restore', 'water cleared, venue reopened'],
    ]);

    // Omitting it still works — the field is optional, like its cancel twin.
    expect((await api().delete(`/api/v1/schedule/${occ.id}`).set(dm).send({})).status).toBe(200);
    expect((await api().post(`/api/v1/schedule/${occ.id}/restore`).set(dm).send({})).status).toBe(201);
    const after = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body;
    expect(after[3]).toMatchObject({ kind: 'restore', reason: '' });
  });

  it('a cancelled occurrence is a metadata target but not a booking participant', async () => {
    const freed = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Freed Room' })).body;
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Half Cancelled', timezone: 'UTC', startDate: '2100-03-01', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 2 });
    expect(series.status).toBe(201);
    const [first, second] = series.body.occurrences;

    // Cancelling releases that window, so the rival booking below is legitimate.
    expect((await api().delete(`/api/v1/schedule/${first.id}`).set(dm).send({ reason: 'skip' })).status).toBe(200);
    const rival = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({ title: 'Took The Freed Slot', timezone: 'UTC', startDate: '2100-03-01', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 1, roomId: freed.id });
    expect(rival.status).toBe(201);

    // Assigning the room to the series must NOT count the cancelled night: the
    // only live occurrence needing the room is the second week, which is free.
    // Counting it would demand `force` for a collision that does not exist, on
    // behalf of a night that is not happening.
    const patched = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ roomId: freed.id });
    expect(patched.status).toBe(200);
    expect(patched.body.conflicts).toEqual([]);

    const byId = new Map(patched.body.occurrences.map((o: { id: number }) => [o.id, o]));
    // The cancelled night still RECEIVES the metadata, so restoring it later
    // brings back a current row — it just took no part in the booking check.
    expect(byId.get(first.id)).toMatchObject({ roomId: freed.id, status: 'cancelled' });
    expect(byId.get(second.id)).toMatchObject({ roomId: freed.id, status: 'scheduled' });

    // And restoring it now correctly refuses, because the room really is taken.
    const blocked = await api().post(`/api/v1/schedule/${first.id}/restore`).set(dm).send({});
    expect(blocked.status).toBe(409);
  });

  it('duplicating a one-off carries its timezone, which nothing else can repair', async () => {
    const night = await api()
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2100-05-04T23:00:00Z', title: 'Zoned Night', timezone: 'America/New_York' });
    expect(night.status).toBe(201);
    expect(night.body.localStart).toBe('2100-05-04T19:00');

    // `duplicate()` predates #588 but `timezone` does not, so a method that
    // copies "everything" silently stopped doing so when the column arrived.
    // ScheduledSessionUpdate carries no `timezone`, so a dropped zone here is
    // unrepairable without recreating the row.
    const copy = await api().post(`/api/v1/schedule/${night.body.id}/duplicate`).set(dm).send({ scheduledAt: '2100-05-11T23:00:00Z' });
    expect(copy.status).toBe(201);
    expect(copy.body.timezone).toBe('America/New_York');
    expect(copy.body.localStart).toBe('2100-05-11T19:00');

    // A zone-less original still duplicates to a zone-less copy.
    const plain = await api().post(`/api/v1/campaigns/${campaignId}/schedule`).set(dm).send({ scheduledAt: '2100-05-18T18:00:00Z' });
    const plainCopy = await api().post(`/api/v1/schedule/${plain.body.id}/duplicate`).set(dm).send({});
    expect(plainCopy.body).toMatchObject({ timezone: '', localStart: '' });
  });

  it('one malformed template slot does not discard the valid slots beside it', async () => {
    const holder = ctx.app.get<DbHolder>(DB_HOLDER);
    const raw: Database = holder.raw;
    const template = await api()
      .post('/api/v1/organized-play/templates')
      .set(dm)
      .send({ name: 'Partly Broken', timezone: 'UTC', count: 1, slots: [{ weekday: 4, startTime: '18:00', title: 'Good Slot' }] });
    expect(template.status).toBe(201);

    // Simulate a hand-edited or partially-migrated row: one unreadable slot
    // sitting beside a valid one. Previously a single bad entry reset the whole
    // list to [], so the template silently became one that creates nothing — and
    // there is no template-update endpoint with which to repair it.
    raw
      .prepare('UPDATE schedule_templates SET slots_json = ? WHERE id = ?')
      .run(JSON.stringify([{ weekday: 4, startTime: '18:00', durationMinutes: 240, roomId: null, assignedDmUserId: '', capacity: 0, title: 'Good Slot' }, { weekday: 99, startTime: 'not-a-time' }]), template.body.id);

    const listed = (await api().get('/api/v1/organized-play/templates').set(dm)).body.find(
      (t: { id: number }) => t.id === template.body.id,
    );
    expect(listed.slots).toHaveLength(1);
    expect(listed.slots[0].title).toBe('Good Slot');

    // …and the surviving slot still applies.
    const applied = await api()
      .post(`/api/v1/organized-play/templates/${template.body.id}/apply`)
      .set(dm)
      .send({ campaignId, startDate: '2100-06-01' });
    expect(applied.status).toBe(201);
    expect(applied.body.series).toHaveLength(1);
  });

  it('restoring a cancelled occurrence re-books its room and refuses a taken one', async () => {
    const room = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Restore Room' })).body;
    const mine = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Cancel Me', timezone: 'UTC', startDate: '2099-04-07', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 1, roomId: room.id });
    expect(mine.status).toBe(201);
    const occ = mine.body.occurrences[0];

    // Cancelling RELEASES the room: the rival booking below is legitimate, and the
    // server correctly reports the slot as free while the night is cancelled.
    expect((await api().delete(`/api/v1/schedule/${occ.id}`).set(dm).send({ reason: 'DM away' })).status).toBe(200);
    const probe = await api()
      .post('/api/v1/organized-play/conflicts')
      .set(dm)
      .send({ scheduledAt: occ.scheduledAt, durationMinutes: 180, roomId: room.id });
    expect(probe.body.conflicts).toEqual([]);

    const rival = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({ title: 'Took The Room', timezone: 'UTC', startDate: '2099-04-07', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 1, roomId: room.id });
    expect(rival.status).toBe(201);

    // …so restoring has to ASK FOR THE ROOM BACK. Flipping the status without a
    // probe silently recreates the double-booking and tells neither party.
    const blocked = await api().post(`/api/v1/schedule/${occ.id}/restore`).set(dm).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('SCHEDULE_CONFLICT');
    expect(blocked.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);
    // Rolled back: still cancelled, and no `restore` was appended to the ledger.
    const after = await api().get(`/api/v1/schedule/${occ.id}`).set(dm);
    expect(after.body.status).toBe('cancelled');
    const ledger = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body;
    expect(ledger.map((e: { kind: string }) => e.kind)).toEqual(['cancel']);

    // The coordinator can still overbook deliberately, same as its siblings.
    const forced = await api().post(`/api/v1/schedule/${occ.id}/restore`).set(dm).send({ force: true });
    expect(forced.status).toBe(201);
    expect(forced.body.status).toBe('scheduled');

    // A night holding no shared resource restores with NO BODY AT ALL — the
    // pre-#588 call shape has to keep working.
    const oneOff = await api().post(`/api/v1/campaigns/${campaignId}/schedule`).set(dm).send({ scheduledAt: '2099-04-21T18:00:00Z' });
    expect((await api().delete(`/api/v1/schedule/${oneOff.body.id}`).set(dm).send({ reason: 'x' })).status).toBe(200);
    expect((await api().post(`/api/v1/schedule/${oneOff.body.id}/restore`).set(dm)).status).toBe(201);
  });

  // Issue #1555: a genuinely completed occurrence must NOT release its room/DM.
  it('a genuinely completed occurrence still blocks a rival booking over its window', async () => {
    const room = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Completed Room' })).body;
    const mine = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Played It', timezone: 'UTC', startDate: '2099-05-05', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 1, roomId: room.id });
    expect(mine.status).toBe(201);
    const occ = mine.body.occurrences[0];

    // Link a real recap — the row becomes GENUINELY completed (not the
    // missing-recap artefact case), which used to fall out of conflict detection
    // entirely.
    const session = await api().post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ title: 'Recap' });
    expect(session.status).toBe(201);
    const linked = await api().post(`/api/v1/schedule/${occ.id}/link/${session.body.id}`).set(dm);
    expect(linked.status).toBe(201);
    expect(linked.body.status).toBe('completed');

    // A rival campaign tries to book the SAME room over the SAME window while the
    // night is completed. Before the fix this succeeded silently — the completed
    // row was invisible to findConflictRows.
    const rival = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({ title: 'Should Not Fit', timezone: 'UTC', startDate: '2099-05-05', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 1, roomId: room.id });
    expect(rival.status).toBe(409);
    expect(rival.body.code).toBe('SCHEDULE_CONFLICT');
    expect(rival.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);

    // Unlinking the recap flips the row back to `scheduled` with no schedule-write
    // probe at all today — but since the room was never released, that flip
    // cannot manufacture a double-booking: the room was already (correctly)
    // reported taken the entire time.
    const unlinked = await api().patch(`/api/v1/sessions/${session.body.id}`).set(dm).send({ scheduledSessionId: null });
    expect(unlinked.status).toBe(200);
    const afterUnlink = await api().get(`/api/v1/schedule/${occ.id}`).set(dm);
    expect(afterUnlink.body.status).toBe('scheduled');
    // The occurrence itself still shows up as holding the room — it never
    // stopped, so nothing needed to re-acquire it.
    const stillHeld = await api()
      .post('/api/v1/organized-play/conflicts')
      .set(dm)
      .send({ scheduledAt: occ.scheduledAt, durationMinutes: 180, roomId: room.id });
    expect(stillHeld.status).toBe(201);
    expect(stillHeld.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);
  });

  // Issue #1555: the DERIVED revival path — trashing (not deleting) the linked
  // recap makes a completed night read as `scheduled` again with no schedule
  // write at all (projectLink's read-time reconciliation). The room must stay
  // held throughout, exactly as it does for the direct-write unlink path above.
  it('trashing a linked recap does not release the room the completed night held', async () => {
    const room = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Trash Room' })).body;
    const mine = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Played And Trashed', timezone: 'UTC', startDate: '2099-05-12', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 1, roomId: room.id });
    expect(mine.status).toBe(201);
    const occ = mine.body.occurrences[0];

    const session = await api().post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ title: 'Recap' });
    const linked = await api().post(`/api/v1/schedule/${occ.id}/link/${session.body.id}`).set(dm);
    expect(linked.status).toBe(201);
    expect(linked.body.status).toBe('completed');

    // Trash the recap — the schedule row is NOT written at all, but reads back
    // as `scheduled` (projectLink) as soon as the recap is invisible.
    expect((await api().delete(`/api/v1/sessions/${session.body.id}`).set(dm)).status).toBe(200);
    const afterTrash = await api().get(`/api/v1/schedule/${occ.id}`).set(dm);
    expect(afterTrash.body.status).toBe('scheduled');

    // The room must still be reported taken for that window: a rival booking is
    // exactly the double-booking a probe-free revival would have permitted.
    const rival = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({ title: 'Should Not Fit Either', timezone: 'UTC', startDate: '2099-05-12', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 1, roomId: room.id });
    expect(rival.status).toBe(409);
    expect(rival.body.code).toBe('SCHEDULE_CONFLICT');
    expect(rival.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);
  });

  // Issue #1601 Part 2: getSeries used to copy the RAW `status` column, so a
  // completed occurrence whose recap was trashed read as `completed` in series
  // detail while the coordinator calendar (scheduleEffectiveStatusSql) and the
  // Schedule tab (projectLink) both showed `scheduled`. Series detail must project
  // through the same derived status as those two surfaces.
  it('a trashed-recap occurrence reads as scheduled in series detail (matches the Schedule tab and calendar)', async () => {
    // Hold a shared room so the occurrence is a member of the organized-play
    // pool (scheduleOrganizedPlaySql) and surfaces in the cross-campaign
    // calendar — otherwise the calendar check below would be vacuous.
    const driftRoom = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Drift Room' })).body;
    const mine = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Series Status Drift', timezone: 'UTC', startDate: '2099-06-09', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 1, roomId: driftRoom.id });
    expect(mine.status).toBe(201);
    const occ = mine.body.occurrences[0];

    // Link a real recap, then trash it: the schedule row still stores
    // `completed` + the link, but every read-time projection must show `scheduled`.
    const session = await api().post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ title: 'Recap' });
    expect(session.status).toBe(201);
    const linked = await api().post(`/api/v1/schedule/${occ.id}/link/${session.body.id}`).set(dm);
    expect(linked.status).toBe(201);
    expect(linked.body.status).toBe('completed');

    expect((await api().delete(`/api/v1/sessions/${session.body.id}`).set(dm)).status).toBe(200);

    // The Schedule tab read (projectLink) is the reference projection.
    const scheduleRead = await api().get(`/api/v1/schedule/${occ.id}`).set(dm);
    expect(scheduleRead.status).toBe(200);
    expect(scheduleRead.body.status).toBe('scheduled');
    expect(scheduleRead.body.sessionId).toBeNull();

    // The cross-campaign calendar (scheduleEffectiveStatusSql) agrees: the
    // occurrence holds a shared room, so it surfaces here with the derived
    // status, never the raw `completed` column.
    const calendar = await api()
      .get('/api/v1/organized-play/calendar')
      .set(dm)
      .query({ from: '2099-06-09T00:00:00Z', to: '2099-06-10T00:00:00Z', roomId: String(driftRoom.id) });
    expect(calendar.status).toBe(200);
    expect(calendar.body.entries.some((e: { status: string }) => e.status === 'completed')).toBe(false);

    // BEFORE the fix this read `completed` with a dangling sessionId — the one
    // surface that disagreed. It must now match the two above.
    const series = await api().get(`/api/v1/campaigns/${campaignId}/series/${mine.body.id}`).set(dm);
    expect(series.status).toBe(200);
    const projected = series.body.occurrences.find((o: { id: number }) => o.id === occ.id);
    expect(projected.status).toBe('scheduled');
    expect(projected.sessionId).toBeNull();
  });

  it('re-probes the room a cancelled night was MOVED to, not the one it held when restore began', async () => {
    const scheduling = ctx.app.get(SchedulingService);
    const opService = ctx.app.get(OrganizedPlayService);
    const actor = { id: 'dev:op-dm', name: 'OP DM', roles: [] as string[] };
    const fromRoom = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Race From' })).body;
    const toRoom = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Race To' })).body;

    const mine = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Restore Race', timezone: 'UTC', startDate: '2099-11-03', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 1, roomId: fromRoom.id });
    expect(mine.status).toBe(201);
    const occ = mine.body.occurrences[0];
    expect((await api().delete(`/api/v1/schedule/${occ.id}`).set(dm).send({ reason: 'DM away' })).status).toBe(200);

    // Another campaign holds the room the occurrence is about to be MOVED to.
    // Nothing holds the room it currently points at.
    const rival = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({ title: 'Holds Race To', timezone: 'UTC', startDate: '2099-11-03', startTime: '18:00', durationMinutes: 180, freq: 'weekly', count: 1, roomId: toRoom.id });
    expect(rival.status).toBe(201);

    // Pin the interleaving: restore reads the row, is overtaken by a series PATCH
    // that moves the cancelled occurrence onto the contended room — legitimate,
    // because a cancelled row is outside the live filter and the fan-out skips
    // its booking check by design — and only then runs its transaction.
    let release!: () => void;
    const overtaken = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    // Private on the service; reached through a cast because the suspension point
    // has to be the read this fix moved, not a public stand-in for it.
    const target = scheduling as unknown as {
      getRowWithEffectiveStatus: (id: number) => Promise<unknown>;
    };
    const realRead = target.getRowWithEffectiveStatus.bind(target);
    const spy = jest.spyOn(target, 'getRowWithEffectiveStatus').mockImplementation(async (rowId: number) => {
      const res = await realRead(rowId);
      if (!held) {
        held = true;
        await overtaken;
      }
      return res;
    });

    let outcome: string;
    try {
      // Called at the service layer, so the raw signal surfaces rather than the
      // 409 the controller renders it into.
      const restoring = scheduling
        .restore(occ.id, actor as never, 'dm')
        .then(() => 'restored')
        .catch((e: { name?: string }) => `rejected:${e?.name ?? 'err'}`);
      await new Promise((resolve) => setImmediate(resolve));
      const moved = await opService.updateSeries(mine.body.id, { roomId: toRoom.id } as never, actor as never, 'dm');
      expect(moved.occurrences[0].roomId).toBe(toRoom.id);
      release();
      outcome = await restoring;
    } finally {
      spy.mockRestore();
    }

    // Probing the STALE room found it free and would have flipped a row now
    // pointing at the rival's room back to `scheduled` — a live double-booking
    // created by the one path whose probe exists to prevent it.
    expect(outcome).toBe('rejected:SeriesConflictSignal');
    const after = await api().get(`/api/v1/schedule/${occ.id}`).set(dm);
    expect(after.body.status).toBe('cancelled');
    expect(after.body.roomId).toBe(toRoom.id);
    // Rolled back whole: no `restore` on the ledger for an attempt that failed.
    expect(
      (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body.map((e: { kind: string }) => e.kind),
    ).toEqual(['cancel']);
  });

  it('a cancel-then-restore is NOT a metadata override, so later series edits still reach it', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Lifecycle', timezone: 'UTC', startDate: '2099-05-05', startTime: '18:00', freq: 'weekly', count: 3, notes: 'v1' });
    expect(series.status).toBe(201);
    const skipped = series.body.occurrences[1];
    const untouched = series.body.occurrences[2];

    expect((await api().delete(`/api/v1/schedule/${skipped.id}`).set(dm).send({ reason: 'holiday' })).status).toBe(200);
    expect((await api().post(`/api/v1/schedule/${skipped.id}/restore`).set(dm).send({})).status).toBe(201);
    // Its ledger now holds cancel + restore — lifecycle entries, not a decision
    // about metadata.
    expect(
      (await api().get(`/api/v1/organized-play/occurrences/${skipped.id}/exceptions`).set(dm)).body.map((e: { kind: string }) => e.kind),
    ).toEqual(['cancel', 'restore']);

    const edited = await api()
      .patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`)
      .set(dm)
      .send({ title: 'Lifecycle (renamed)', capacity: 5 });
    expect(edited.status).toBe(200);

    const byId = new Map(edited.body.occurrences.map((o: { id: number }) => [o.id, o]));
    // The restored night must receive the edit: treating its lifecycle entries as
    // an override would freeze it out of every later series edit permanently,
    // leaving it with a stale title, room, DM and event keys forever.
    expect(byId.get(skipped.id)).toMatchObject({ title: 'Lifecycle (renamed)', capacity: 5 });
    expect(byId.get(untouched.id)).toMatchObject({ title: 'Lifecycle (renamed)', capacity: 5 });

    // A genuinely re-seated occurrence still keeps its override.
    expect((await api().post(`/api/v1/organized-play/occurrences/${untouched.id}/reassign`).set(dm).send({ capacity: 2 })).status).toBe(201);
    const second = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ capacity: 9 });
    expect(second.status).toBe(200);
    const afterSecond = new Map(second.body.occurrences.map((o: { id: number }) => [o.id, o]));
    expect(afterSecond.get(untouched.id)).toMatchObject({ capacity: 2 }); // override respected
    expect(afterSecond.get(skipped.id)).toMatchObject({ capacity: 9 }); // lifecycle-only, still fanned to
  });

  it('deleting a VENUE clears its rooms from template slots too', async () => {
    // deleteVenue cascade-deletes its rooms, so it carries the same hazard
    // deleteRoom guards against — and createTemplate only checks that a slot room
    // EXISTS, never that it belongs to the template's own venue, so a template can
    // legitimately book rooms in a venue that is later deleted.
    const templateVenue = await api().post('/api/v1/organized-play/venues').set(dm).send({ name: 'Template Home', timezone: 'UTC' });
    const doomedVenue = await api().post('/api/v1/organized-play/venues').set(dm).send({ name: 'Doomed Annexe', timezone: 'UTC' });
    const annexeRoom = (await api().post(`/api/v1/organized-play/venues/${doomedVenue.body.id}/rooms`).set(dm).send({ name: 'Annexe Table' })).body;

    const template = await api()
      .post('/api/v1/organized-play/templates')
      .set(dm)
      .send({
        name: 'Cross Venue Block',
        timezone: 'UTC',
        venueId: templateVenue.body.id,
        count: 1,
        slots: [{ weekday: 2, startTime: '18:00', roomId: annexeRoom.id, title: 'Annexe Slot' }],
      });
    expect(template.status).toBe(201);

    expect((await api().delete(`/api/v1/organized-play/venues/${doomedVenue.body.id}`).set(dm)).status).toBe(200);

    const listed = (await api().get('/api/v1/organized-play/templates').set(dm)).body.find(
      (t: { id: number }) => t.id === template.body.id,
    );
    expect(listed.slots[0].roomId).toBeNull();

    const applied = await api()
      .post(`/api/v1/organized-play/templates/${template.body.id}/apply`)
      .set(dm)
      .send({ campaignId, startDate: '2100-02-01' });
    expect(applied.status).toBe(201);
    expect(applied.body.series[0].roomId).toBeNull();
  });

  it('a series room change that would double-book the series against ITSELF is rejected', async () => {
    const selfRoom = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Self Clash Room' })).body;
    // Daily 24-hour local tables across the 2099-03-08 spring-forward, which makes
    // that local day 23 hours — so two of these occurrences genuinely overlap by an
    // hour in real time. Created with NO room and NO DM, so they hold no shared
    // resource and the intra-batch check at creation has nothing to group on:
    // creating them collides with nothing, which is what makes the PATCH below the
    // first moment the overlap can matter.
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({
        title: 'Overlapping Marathon',
        timezone: 'America/New_York',
        startDate: '2099-03-06',
        startTime: '19:00',
        durationMinutes: 1440,
        freq: 'daily',
        count: 4,
      });
    expect(series.status).toBe(201);
    // Sanity-check the premise rather than trusting the zone math: occurrence 2
    // starts before occurrence 1 has ended.
    const occs = series.body.occurrences as Array<{ scheduledAt: string; durationMinutes: number }>;
    const endOf = (o: { scheduledAt: string; durationMinutes: number }) => Date.parse(o.scheduledAt) + o.durationMinutes * 60_000;
    expect(Date.parse(occs[2].scheduledAt)).toBeLessThan(endOf(occs[1]));

    // Assigning them all to ONE room double-books it. No stored-row probe can see
    // this: each occurrence's probe excludes its own id, and its siblings still
    // hold the old null room while the probe runs — only the intra-batch check
    // catches it, which is the same guard create/extend/apply already run.
    const rejected = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ roomId: selfRoom.id });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('SCHEDULE_CONFLICT');
    expect(rejected.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);

    const untouched = await api().get(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm);
    expect(untouched.body.occurrences.every((o: { roomId: number | null }) => o.roomId === null)).toBe(true);

    const forced = await api()
      .patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`)
      .set(dm)
      .send({ roomId: selfRoom.id, force: true });
    expect(forced.status).toBe(200);
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

  /**
   * A double-submitted extend used to mint duplicate occurrence indexes — and
   * therefore duplicate ICS UIDs, which subscribers cannot recover from.
   *
   * Driven through the service rather than HTTP so the interleaving is
   * DETERMINISTIC: better-sqlite3 is synchronous, so nothing can interleave once
   * a transaction callback is running, but every `await` before it is a yield.
   * When the count and the occurrence-index set were read outside the
   * transaction, both calls awaited the same answer, both computed the same
   * "fresh" indexes, and both inserted them — and because the series holds no
   * room and no DM, the booking probe had nothing to collide on and reported
   * neither.
   */
  it('serializes two concurrent extends: no duplicate occurrence index and no duplicate ICS UID', async () => {
    const service = ctx.app.get(OrganizedPlayService);
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Double Submit', timezone: 'UTC', startDate: '2099-07-07', startTime: '18:00', freq: 'weekly', count: 2 });
    expect(series.status).toBe(201);
    const seriesId = series.body.id as number;
    const actor = { id: 'dev:op-dm', name: 'OP DM', roles: [] as string[] };

    await Promise.all([
      service.extendSeries(seriesId, 2, actor as never, 'dm'),
      service.extendSeries(seriesId, 2, actor as never, 'dm'),
    ]);

    const after = await api().get(`/api/v1/campaigns/${campaignId}/series/${seriesId}`).set(dm);
    const indexes = after.body.occurrences.map((o: { occurrenceIndex: number }) => o.occurrenceIndex);
    const uids = after.body.occurrences.map((o: { icsUid: string }) => o.icsUid);
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(new Set(uids).size).toBe(uids.length);
    // Both extensions land, one after the other: 2 + 2 + 2.
    expect(indexes.slice().sort((a: number, b: number) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(after.body.count).toBe(6);
  });

  it('keeps one recurrence id when a reschedule also changes the occurrence timezone', async () => {
    // 23:00 in Los Angeles is the NEXT day in Kiritimati (+21h), so the anchor
    // instant lands on a different local date depending on which zone reads it.
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Zone Drift', timezone: 'America/Los_Angeles', startDate: '2099-08-18', startTime: '23:00', freq: 'weekly', count: 2 });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[0];

    // First move re-labels the row's zone. `rescheduleOccurrence` accepts and
    // PERSISTS `timezone`, so the occurrence's own zone is as mutable as its wall
    // clock — and deriving the recurrence id from it meant the very next entry
    // read the same anchor instant in a different zone and filed under a
    // different date. `original_scheduled_at` pinned the instant; only the series
    // zone can pin the zone.
    expect(
      (
        await api()
          .post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`)
          .set(dm)
          .send({ scheduledAt: '2099-08-20T06:00:00.000Z', timezone: 'Pacific/Kiritimati' })
      ).status,
    ).toBe(201);
    expect(
      (await api().post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`).set(dm).send({ scheduledAt: '2099-08-21T06:00:00.000Z' })).status,
    ).toBe(201);

    const ledger = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body;
    const ids = ledger.map((e: { recurrenceLocalDate: string }) => e.recurrenceLocalDate);
    expect(new Set(ids).size).toBe(1);
    // The series' own zone, which is immutable — updateSeries never writes it.
    expect(ids).toEqual(['2099-08-18', '2099-08-18']);
  });

  it('a reassign that changes nothing files no override, so the series can still reach the occurrence', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'No-op Reassign', timezone: 'UTC', startDate: '2099-09-01', startTime: '18:00', freq: 'weekly', count: 2, capacity: 6 });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[0];

    // Reason-only: nothing about the seating changed. The ledger is append-only,
    // so an override written here could never be withdrawn — one stray call (or a
    // double-click) would freeze this night out of every later series edit
    // FOREVER, leaving it with a stale title, room, DM and event keys.
    const noop = await api().post(`/api/v1/organized-play/occurrences/${occ.id}/reassign`).set(dm).send({ reason: 'just checking' });
    expect(noop.status).toBe(201);
    // Repeating the values already stored is equally a no-op.
    expect((await api().post(`/api/v1/organized-play/occurrences/${occ.id}/reassign`).set(dm).send({ capacity: 6 })).status).toBe(201);
    expect((await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body).toEqual([]);

    const edited = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ title: 'No-op Reassign (v2)' });
    expect(edited.status).toBe(200);
    const byId = new Map(edited.body.occurrences.map((o: { id: number }) => [o.id, o]));
    expect(byId.get(occ.id)).toMatchObject({ title: 'No-op Reassign (v2)' });

    // A REAL re-seat still files its override and is still respected.
    expect((await api().post(`/api/v1/organized-play/occurrences/${occ.id}/reassign`).set(dm).send({ capacity: 2 })).status).toBe(201);
    expect((await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body.map((e: { kind: string }) => e.kind)).toEqual([
      'reassign',
    ]);
  });

  /**
   * The move guard's comment always described the right rule — a row that HOLDS
   * a room or a DM must not slide without a probe — but the code tested
   * `seriesId != null`, which is only a proxy for it. `reassignOccurrence` seats
   * ANY occurrence (it rejects cancelled rows and nothing else), so a plain
   * one-off can be given a room, which puts it in the conflict pool while its
   * `seriesId` stays null the whole time.
   */
  it('refuses to slide a ONE-OFF that holds a room, even though it belongs to no series', async () => {
    const guardRoom = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Guard Room' })).body;
    const night = await api()
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-05-04T18:00:00.000Z', title: 'One-shot at the store' });
    expect(night.status).toBe(201);
    expect(night.body.seriesId).toBeNull();

    // Before it holds anything, the legacy editor may move it freely — the guard
    // must not over-block an ordinary home game.
    const freeMove = await api().patch(`/api/v1/schedule/${night.body.id}`).set(dm).send({ scheduledAt: '2099-05-04T19:00:00.000Z' });
    expect(freeMove.status).toBe(200);

    // Now seat it. This is a legitimate booking: a one-shot at a game store.
    const seated = await api().post(`/api/v1/organized-play/occurrences/${night.body.id}/reassign`).set(dm).send({ roomId: guardRoom.id });
    expect(seated.status).toBe(201);
    expect(seated.body.occurrence.seriesId).toBeNull();
    expect(seated.body.occurrence.roomId).toBe(guardRoom.id);

    // …and the legacy PATCH must now refuse the move, because sliding it would
    // re-book the room somewhere else with no conflict probe.
    const blocked = await api().patch(`/api/v1/schedule/${night.body.id}`).set(dm).send({ scheduledAt: '2099-05-04T21:00:00.000Z' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/organized-play\/occurrences/);

    // Lengthening is the other way to widen the window, and is refused too.
    expect((await api().patch(`/api/v1/schedule/${night.body.id}`).set(dm).send({ durationMinutes: 600 })).status).toBe(400);
    // Shrinking still works — a contracting window cannot introduce an overlap.
    expect((await api().patch(`/api/v1/schedule/${night.body.id}`).set(dm).send({ durationMinutes: 60 })).status).toBe(200);
    // Prose still works.
    expect((await api().patch(`/api/v1/schedule/${night.body.id}`).set(dm).send({ title: 'One-shot (renamed)' })).status).toBe(200);

    // An assigned DM alone is equally a held resource, with no room involved.
    const dmOnly = await api()
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-05-11T18:00:00.000Z', title: 'DM-only one-off' });
    expect((await api().post(`/api/v1/organized-play/occurrences/${dmOnly.body.id}/reassign`).set(dm).send({ assignedDmUserId: 'dev:guest-dm' })).status).toBe(201);
    expect((await api().patch(`/api/v1/schedule/${dmOnly.body.id}`).set(dm).send({ scheduledAt: '2099-05-11T20:00:00.000Z' })).status).toBe(400);

    // A row carrying only an event key allocates NOTHING, so it stays movable:
    // the guard keys on what can collide, not on the wider "is this row visible
    // to organized play" pool predicate.
    const keyed = await api()
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-05-18T18:00:00.000Z', title: 'Event-keyed only' });
    const service = ctx.app.get(OrganizedPlayService);
    const holder = ctx.app.get<DbHolder>(DB_HOLDER);
    holder.raw.prepare('UPDATE scheduled_sessions SET event_id = ? WHERE id = ?').run('CCC-01', keyed.body.id);
    expect(service).toBeDefined();
    expect((await api().patch(`/api/v1/schedule/${keyed.body.id}`).set(dm).send({ scheduledAt: '2099-05-18T20:00:00.000Z' })).status).toBe(200);
  });

  /**
   * The instant/wall-clock invariant on the RESCHEDULE path.
   *
   * `expandRecurrence` was fixed to store the wall clock a gap occurrence really
   * gets, but `rescheduleOccurrence`'s `localStart` branch echoed the requested
   * value back — the same rule written twice and drifting, which is exactly the
   * failure mode the fix was for. Both now go through `materializeWallClock`.
   */
  it('stores the ACTUAL wall clock when a reschedule lands in a spring-forward gap', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Gap Move', timezone: 'America/New_York', startDate: '2099-04-07', startTime: '19:00', freq: 'weekly', count: 1 });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[0];

    // 02:30 does not exist on 2099-03-08 in New York: the clocks jump 02:00 -> 03:00.
    const moved = await api()
      .post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`)
      .set(dm)
      .send({ localStart: '2099-03-08T02:30' });
    expect(moved.status).toBe(201);

    // The instant is shifted past the transition — 03:30 EDT is 07:30Z…
    expect(moved.body.occurrence.scheduledAt).toBe('2099-03-08T07:30:00.000Z');
    // …so the PERSISTED wall clock must read 03:30, not the impossible 02:30 that
    // was asked for. Storing the request would make one row describe two times.
    expect(moved.body.occurrence.localStart).toBe('2099-03-08T03:30');

    // A non-gap move still echoes the requested clock exactly.
    const ordinary = await api()
      .post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`)
      .set(dm)
      .send({ localStart: '2099-03-15T02:30' });
    expect(ordinary.status).toBe(201);
    expect(ordinary.body.occurrence.localStart).toBe('2099-03-15T02:30');
    expect(ordinary.body.occurrence.scheduledAt).toBe('2099-03-15T06:30:00.000Z');
  });

  /**
   * The override set was read with an `await`ed select BEFORE the write
   * transaction opened, so a per-occurrence customization committing in that gap
   * was invisible to the fan-out and got rewritten to the series default — the
   * exact outcome the set exists to prevent.
   *
   * Driven through the service so the interleaving is deterministic: every
   * `await` before a synchronous better-sqlite3 transaction is a yield.
   */
  it('does not wipe a per-occurrence re-seat that lands while a series edit is in flight', async () => {
    const service = ctx.app.get(OrganizedPlayService);
    const actor = { id: 'dev:op-dm', name: 'OP DM', roles: [] as string[] };
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Race Fanout', timezone: 'UTC', startDate: '2099-06-02', startTime: '18:00', freq: 'weekly', count: 2, capacity: 6 });
    expect(series.status).toBe(201);
    const target = series.body.occurrences[0];

    // Both requests in flight at once: the re-seat files a `reassign` override
    // while the series-wide edit is between reading that set and writing.
    await Promise.all([
      service.updateSeries(series.body.id, { title: 'Race Fanout (v2)', capacity: 9 } as never, actor as never, 'dm'),
      service.reassignOccurrence(target.id, { capacity: 2 } as never, actor as never, 'dm'),
    ]);

    const after = await api().get(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm);
    const byId = new Map(after.body.occurrences.map((o: { id: number }) => [o.id, o]));
    // Whichever order they land in, the coordinator's explicit per-occurrence
    // capacity must survive: it is either applied after the fan-out, or seen by
    // the fan-out as an override and skipped. It must never be reset to 9.
    expect((byId.get(target.id) as { capacity: number }).capacity).toBe(2);
    // The override is on the ledger either way.
    expect(
      (await api().get(`/api/v1/organized-play/occurrences/${target.id}/exceptions`).set(dm)).body.map((e: { kind: string }) => e.kind),
    ).toEqual(['reassign']);
  });

  it('does not re-assert a stale venue when a room-clearing PATCH races a room change', async () => {
    const service = ctx.app.get(OrganizedPlayService);
    const actor = { id: 'dev:op-dm', name: 'OP DM', roles: [] as string[] };
    // A second venue, so "kept the old venue" and "kept the new one" are
    // distinguishable rather than both being the same id.
    const otherVenueId = (
      await api().post('/api/v1/organized-play/venues').set(dm).send({ name: 'The Second Table', timezone: 'UTC' })
    ).body.id;
    const otherRoomId = (
      await api().post(`/api/v1/organized-play/venues/${otherVenueId}/rooms`).set(dm).send({ name: 'Back Room', capacity: 6 })
    ).body.id;

    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Venue Race', timezone: 'UTC', startDate: '2099-10-06', startTime: '18:00', freq: 'weekly', count: 2, roomId: blueRoomId });
    expect(series.status).toBe(201);
    expect(series.body.venueId).toBe(venueId);

    // The interleaving is PINNED, not raced. A plain Promise.all does not
    // reproduce this: the room-clearing request has strictly fewer awaits than
    // the room-changing one, so it always reaches its transaction first and its
    // snapshot is never stale. The hazard needs the opposite order — the clearing
    // request must read the series, then be overtaken, then write. So the clearer
    // is suspended between its pre-transaction read and its transaction while the
    // room change runs to completion.
    let release!: () => void;
    const overtaken = new Promise<void>((resolve) => {
      release = resolve;
    });
    let suspended = false;
    const realRead = service.getSeriesRowOrThrow.bind(service);
    const spy = jest.spyOn(service, 'getSeriesRowOrThrow').mockImplementation(async (seriesId: number) => {
      const row = await realRead(seriesId);
      // Only the FIRST caller (the clearer) is held; the room change must be
      // allowed to proceed and commit while it waits.
      if (!suspended) {
        suspended = true;
        await overtaken;
      }
      return row;
    });

    try {
      const clearing = service.updateSeries(series.body.id, { roomId: null } as never, actor as never, 'dm');
      // Let the clearer reach the spy and park there.
      await new Promise((resolve) => setImmediate(resolve));
      // The room change commits in that gap: series and occurrences move to the
      // second venue.
      await service.updateSeries(series.body.id, { roomId: otherRoomId } as never, actor as never, 'dm');
      const moved = await api().get(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm);
      expect(moved.body.venueId).toBe(otherVenueId);

      release();
      await clearing;
    } finally {
      spy.mockRestore();
    }

    const after = await api().get(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm);
    expect(after.status).toBe(200);
    // The clearer's snapshot said venue #1. Deriving "keep the venue" from that
    // snapshot writes venue #1 back over the move that already committed — a
    // relocation neither request asked for, last-write-wins on a value the CALLER
    // never supplied. Derived from the in-transaction row, it keeps venue #2.
    expect(after.body.roomId).toBeNull();
    expect(after.body.venueId).toBe(otherVenueId);
    // …and every occurrence must agree with the series rather than carrying its
    // own copy of the stale derivation.
    for (const occ of after.body.occurrences) {
      expect(occ.venueId).toBe(otherVenueId);
      expect(occ.roomId).toBeNull();
    }
  });

  it('a reschedule that moves nothing files no override and pushes no SEQUENCE', async () => {
    // The twin of the no-op reassign case. The ledger is append-only and
    // updateSeries reads every `reschedule` entry as a permanent override, so a
    // client retry resending the current instant would detach this night from
    // its series forever.
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'No-op Move', timezone: 'UTC', startDate: '2099-06-16', startTime: '18:00', freq: 'weekly', count: 2 });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[0];

    const retry = await api()
      .post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`)
      .set(dm)
      .send({ scheduledAt: occ.scheduledAt, reason: 'client retry' });
    expect(retry.status).toBe(201);
    expect(retry.body.occurrence.icsSequence).toBe(occ.icsSequence);
    expect((await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body).toEqual([]);

    // Still reachable by the series, which is what the override would have cost.
    const edited = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ title: 'No-op Move (v2)' });
    const byId = new Map(edited.body.occurrences.map((o: { id: number }) => [o.id, o]));
    expect(byId.get(occ.id)).toMatchObject({ title: 'No-op Move (v2)' });

    // A REAL move still files its entry and bumps SEQUENCE. Re-read the sequence
    // first: the series rename above legitimately bumped it.
    const beforeMove = (await api().get(`/api/v1/schedule/${occ.id}`).set(dm)).body.icsSequence as number;
    const moved = await api()
      .post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`)
      .set(dm)
      .send({ scheduledAt: '2099-06-17T18:00:00.000Z' });
    expect(moved.status).toBe(201);
    expect(moved.body.occurrence.icsSequence).toBe(beforeMove + 1);
    expect((await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body.map((e: { kind: string }) => e.kind)).toEqual([
      'reschedule',
    ]);
  });

  it('a no-op room clear does not destroy a venue-only series, which nothing could restore', async () => {
    // SessionSeriesUpdate exposes no `venueId`, so a cleared venue cannot be put
    // back through the API at all — the series and every future occurrence would
    // drop off venue-filtered calendars permanently.
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Venue Only', timezone: 'UTC', startDate: '2099-06-23', startTime: '18:00', freq: 'weekly', count: 2, venueId });
    expect(series.status).toBe(201);
    expect(series.body.venueId).toBe(venueId);
    expect(series.body.roomId).toBeNull();

    // A client resending its current state: roomId is already null.
    const noop = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ roomId: null });
    expect(noop.status).toBe(200);
    expect(noop.body.venueId).toBe(venueId);
    expect(noop.body.occurrences.every((o: { venueId: number | null }) => o.venueId === venueId)).toBe(true);

    // Clearing a REAL room likewise keeps the venue: "no particular table" is not
    // the same statement as "not at this venue".
    const seated = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ roomId: blueRoomId, force: true });
    expect(seated.body.roomId).toBe(blueRoomId);
    const cleared = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ roomId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.roomId).toBeNull();
    expect(cleared.body.venueId).toBe(venueId);
  });

  it('a forced restore reports what it overbooked, like every other force path', async () => {
    const restoreRoomRes = await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Force Report Room' });
    // Asserted, not assumed: a duplicate room name 400s, and an undefined roomId
    // would silently make both bookings resource-less and the probe vacuous.
    expect(restoreRoomRes.status).toBe(201);
    const restoreRoom = restoreRoomRes.body;
    const night = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Restore Reports', timezone: 'UTC', startDate: '2099-06-30', startTime: '18:00', freq: 'weekly', count: 1, roomId: restoreRoom.id });
    expect(night.status).toBe(201);
    const occ = night.body.occurrences[0];

    // Cancel RELEASES the room…
    expect((await api().delete(`/api/v1/schedule/${occ.id}`).set(dm).send({ reason: 'flood' })).status).toBe(200);
    // …another campaign legitimately takes it…
    const rival = await api()
      .post(`/api/v1/campaigns/${otherCampaignId}/series`)
      .set(dm)
      .send({ title: 'Rival Table', timezone: 'UTC', startDate: '2099-06-30', startTime: '18:00', freq: 'weekly', count: 1, roomId: restoreRoom.id });
    expect(rival.status).toBe(201);

    // …so an unforced restore is refused, and a forced one must SAY what it took.
    expect((await api().post(`/api/v1/schedule/${occ.id}/restore`).set(dm).send({})).status).toBe(409);
    const forced = await api().post(`/api/v1/schedule/${occ.id}/restore`).set(dm).send({ force: true, reason: 'flood receded' });
    expect(forced.status).toBe(201);
    expect(Array.isArray(forced.body.conflicts)).toBe(true);
    expect(forced.body.conflicts.length).toBeGreaterThan(0);
    expect(forced.body.conflicts.some((c: { kind: string }) => c.kind === 'room')).toBe(true);
  });

  /**
   * Two per-occurrence writes racing on the SAME occurrence.
   *
   * Both endpoints validated against a row read with an `await` BEFORE their
   * transaction opened, so the later writer worked from a stale snapshot. Three
   * distinct consequences, all asserted here rather than just "last writer wins":
   * omitted fields were re-derived from the stale row, silently reverting a
   * reassignment that had landed in between; the ledger recorded a
   * `fromScheduledAt` that was never stored; and `icsSequence` was recomputed
   * from the stale value, so two moves produced the SAME sequence and every
   * subscribed calendar ignored the second.
   *
   * The interleaving is driven EXPLICITLY rather than with a bare `Promise.all`.
   * Racing the two calls does not reproduce it: they await a different number of
   * times before their transactions, so the one with fewer awaits always commits
   * first, and they write disjoint columns — a version of this test built that
   * way passed against the bug. Gating the scope lookup pins the exact order the
   * defect needs: read the row, let the other request commit, then write.
   */
  const gateScopeLookup = (service: OrganizedPlayService): { release: () => void; restore: () => void } => {
    const roles = (service as unknown as { roles: { accessibleCampaignIds: (u: unknown) => Promise<unknown> } }).roles;
    const real = roles.accessibleCampaignIds.bind(roles);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const spy = jest.spyOn(roles, 'accessibleCampaignIds').mockImplementation(async (u: unknown) => {
      const scope = await real(u);
      // Only the FIRST caller waits; the request we let overtake it runs freely.
      if (!gated) {
        gated = true;
        await gate;
      }
      return scope as never;
    });
    return { release, restore: () => spy.mockRestore() };
  };

  it('does not lose a re-seat that commits while a reschedule holds a stale snapshot', async () => {
    const service = ctx.app.get(OrganizedPlayService);
    const actor = { id: 'dev:op-dm', name: 'OP DM', roles: [] as string[] };
    const raceRoom = await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Race Room' });
    expect(raceRoom.status).toBe(201);
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Occurrence Race', timezone: 'UTC', startDate: '2099-08-04', startTime: '18:00', freq: 'weekly', count: 1 });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[0];

    const gate = gateScopeLookup(service);
    try {
      // The reschedule mentions no room, so it re-derives one — from the snapshot
      // it is holding. That is the field the re-seat is about to change.
      const move = service.rescheduleOccurrence(occ.id, { scheduledAt: '2099-08-05T18:00:00.000Z' } as never, actor as never, 'dm');
      await new Promise((resolve) => setImmediate(resolve));
      await service.reassignOccurrence(occ.id, { roomId: raceRoom.body.id } as never, actor as never, 'dm');
      gate.release();
      await move;
    } finally {
      gate.restore();
    }

    const after = (await api().get(`/api/v1/schedule/${occ.id}`).set(dm)).body;
    // The re-seat SURVIVES: the later writer re-derived the room from what was
    // actually stored, not from the row it read before the re-seat existed.
    expect(after.roomId).toBe(raceRoom.body.id);
    expect(after.scheduledAt).toBe('2099-08-05T18:00:00.000Z');

    // Lineage is honest: every recorded `fromScheduledAt` is an instant this
    // occurrence genuinely held.
    const ledger = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body as Array<{
      fromScheduledAt: string;
    }>;
    const heldInstants = new Set([occ.scheduledAt, '2099-08-05T18:00:00.000Z']);
    for (const entry of ledger) expect(heldInstants.has(entry.fromScheduledAt)).toBe(true);
  });

  it('gives two racing moves DISTINCT ICS sequences, so subscribers apply both', async () => {
    const service = ctx.app.get(OrganizedPlayService);
    const actor = { id: 'dev:op-dm', name: 'OP DM', roles: [] as string[] };
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Sequence Race', timezone: 'UTC', startDate: '2099-08-18', startTime: '18:00', freq: 'weekly', count: 1 });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[0];
    const seq0 = occ.icsSequence as number;

    const gate = gateScopeLookup(service);
    try {
      const first = service.rescheduleOccurrence(occ.id, { scheduledAt: '2099-08-19T18:00:00.000Z' } as never, actor as never, 'dm');
      await new Promise((resolve) => setImmediate(resolve));
      await service.rescheduleOccurrence(occ.id, { scheduledAt: '2099-08-20T18:00:00.000Z' } as never, actor as never, 'dm');
      gate.release();
      await first;
    } finally {
      gate.restore();
    }

    // Both moves happened, so SEQUENCE must have advanced TWICE. Recomputing it
    // from a stale snapshot made both writes produce seq0 + 1, and a calendar
    // client that has already applied seq0 + 1 discards the second revision —
    // leaving every subscriber on the wrong night with no way to notice.
    const after = (await api().get(`/api/v1/schedule/${occ.id}`).set(dm)).body;
    expect(after.icsSequence).toBe(seq0 + 2);
  });

  it('files the ledger entry that describes the change, not the endpoint that was called', async () => {
    const kindRoom = await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Kind Room' });
    expect(kindRoom.status).toBe(201);
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Ledger Kind', timezone: 'UTC', startDate: '2099-08-11', startTime: '18:00', freq: 'weekly', count: 1, capacity: 6 });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[0];
    const seq0 = occ.icsSequence as number;

    // A ROOM-ONLY edit through the reschedule endpoint. It moves no time, so it
    // is a re-seat however it was requested — and must not bump SEQUENCE, since
    // the room is not rendered into the feed.
    const roomOnly = await api()
      .post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`)
      .set(dm)
      .send({ scheduledAt: occ.scheduledAt, roomId: kindRoom.body.id });
    expect(roomOnly.status).toBe(201);
    expect(roomOnly.body.occurrence.icsSequence).toBe(seq0);
    const first = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body;
    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe('reassign');
    // …and it records WHAT changed, so an A->B->C run stays reconstructable.
    expect(first[0]).toMatchObject({ fromRoomId: null, toRoomId: kindRoom.body.id, fromCapacity: 6, toCapacity: 6 });

    // A real move is still a reschedule and still bumps.
    const timeMove = await api()
      .post(`/api/v1/organized-play/occurrences/${occ.id}/reschedule`)
      .set(dm)
      .send({ scheduledAt: '2099-08-12T18:00:00.000Z' });
    expect(timeMove.status).toBe(201);
    expect(timeMove.body.occurrence.icsSequence).toBe(seq0 + 1);
    const both = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body;
    expect(both.map((e: { kind: string }) => e.kind)).toEqual(['reassign', 'reschedule']);

    // The middle room of an A->B->C run survives in the ledger even though the
    // occurrence itself holds only the last one.
    const roomC = await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Kind Room C' });
    expect((await api().post(`/api/v1/organized-play/occurrences/${occ.id}/reassign`).set(dm).send({ roomId: roomC.body.id })).status).toBe(201);
    const lineage = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body as Array<{
      fromRoomId: number | null;
      toRoomId: number | null;
    }>;
    expect(lineage.map((e) => [e.fromRoomId, e.toRoomId])).toContainEqual([kindRoom.body.id, roomC.body.id]);
  });

  it('records a legacy prose edit in the ledger WITHOUT freezing the occurrence out of its series', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Prose Lineage', timezone: 'UTC', startDate: '2099-09-08', startTime: '18:00', freq: 'weekly', count: 2, notes: 'series notes' });
    expect(series.status).toBe(201);
    const occ = series.body.occurrences[0];

    // A DM edits this one night's notes through the ordinary Schedule tab.
    const edited = await api().patch(`/api/v1/schedule/${occ.id}`).set(dm).send({ notes: 'bring the map for THIS night' });
    expect(edited.status).toBe(200);

    // It is now visible in the lineage, which previously showed nothing at all.
    const ledger = (await api().get(`/api/v1/organized-play/occurrences/${occ.id}/exceptions`).set(dm)).body;
    expect(ledger.map((e: { kind: string }) => e.kind)).toEqual(['edit']);
    // Field names only — the note body is versioned elsewhere and the ledger is
    // readable by coordinators who may not be in this campaign.
    expect(ledger[0].reason).toBe('edited notes');
    expect(JSON.stringify(ledger[0])).not.toContain('bring the map');

    // …and it is NOT an override: a later series TITLE edit still reaches it.
    // Treating a prose edit as an override would detach this night permanently,
    // because the ledger is append-only.
    const renamed = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ title: 'Prose Lineage (v2)' });
    expect(renamed.status).toBe(200);
    const byId = new Map(renamed.body.occurrences.map((o: { id: number }) => [o.id, o]));
    expect(byId.get(occ.id)).toMatchObject({ title: 'Prose Lineage (v2)' });
    // The fan-out is field-scoped, so a title edit leaves the DM's notes alone.
    expect((byId.get(occ.id) as { notes: string }).notes).toBe('bring the map for THIS night');

    // A genuine re-seat still IS an override, so the two kinds stay distinct.
    expect((await api().post(`/api/v1/organized-play/occurrences/${occ.id}/reassign`).set(dm).send({ capacity: 3 })).status).toBe(201);
    const second = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ capacity: 9 });
    expect(second.status).toBe(200);
    const after = new Map(second.body.occurrences.map((o: { id: number }) => [o.id, o]));
    expect(after.get(occ.id)).toMatchObject({ capacity: 3 });
  });

  it('announces a series metadata edit with the NEW title, not the snapshot it read', async () => {
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Old Title', timezone: 'UTC', startDate: '2099-09-22', startTime: '18:00', freq: 'weekly', count: 2, notes: 'v1' });
    expect(series.status).toBe(201);

    const service = ctx.app.get(OrganizedPlayService);
    const notifications = (service as unknown as { notifications: { notifyCampaign: (...a: unknown[]) => Promise<void> } }).notifications;
    const seen: Array<{ label: string }> = [];
    const spy = jest.spyOn(notifications, 'notifyCampaign').mockImplementation(async (...args: unknown[]) => {
      const event = args[2] as { data?: { label?: string } };
      if (event?.data?.label !== undefined) seen.push({ label: event.data.label });
    });
    try {
      // Title AND notes together: notes makes it notifiable, title is the field
      // rendered into the notification's label.
      const res = await api()
        .patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`)
        .set(dm)
        .send({ title: 'New Title', notes: 'v2' });
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    expect(seen).toHaveLength(1);
    // The rows the fan-out read were snapshots taken BEFORE it wrote, so passing
    // them verbatim announced the old title for a night that already had the new one.
    expect(seen[0].label).toBe('New Title');
  });

  it('does not push a fresh SEQUENCE for a room change, which the feed never renders', async () => {
    const seqRoom = (await api().post(`/api/v1/organized-play/venues/${venueId}/rooms`).set(dm).send({ name: 'Sequence Room' })).body;
    const series = await api()
      .post(`/api/v1/campaigns/${campaignId}/series`)
      .set(dm)
      .send({ title: 'Room Seq', timezone: 'UTC', startDate: '2099-09-15', startTime: '18:00', freq: 'weekly', count: 2 });
    expect(series.status).toBe(201);
    const [first, second] = series.body.occurrences;

    // The emitter renders SUMMARY from `title`, LOCATION from the free-text
    // `location` column and DESCRIPTION from `notes` — never the room. A re-seat
    // therefore produces a byte-identical VEVENT, and a fresh SEQUENCE would
    // announce a revision to every subscriber that changed nothing they can see.
    const reseated = await api().post(`/api/v1/organized-play/occurrences/${first.id}/reassign`).set(dm).send({ roomId: seqRoom.id });
    expect(reseated.status).toBe(201);
    expect(reseated.body.occurrence.roomId).toBe(seqRoom.id);
    expect(reseated.body.occurrence.icsSequence).toBe(first.icsSequence);

    // The bulk form of the same change, through the series fan-out. The two must
    // not disagree about what "renders".
    const fanned = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ roomId: seqRoom.id, force: true });
    expect(fanned.status).toBe(200);
    const after = new Map(fanned.body.occurrences.map((o: { id: number }) => [o.id, o]));
    expect(after.get(second.id)).toMatchObject({ roomId: seqRoom.id, icsSequence: second.icsSequence });

    // …and a title change in the same breath still does bump it, so this is a
    // rule about what renders and not a blanket "fan-outs never bump".
    const renamed = await api().patch(`/api/v1/campaigns/${campaignId}/series/${series.body.id}`).set(dm).send({ title: 'Room Seq (v2)' });
    expect(renamed.status).toBe(200);
    const renamedById = new Map(renamed.body.occurrences.map((o: { id: number }) => [o.id, o]));
    expect(renamedById.get(second.id)).toMatchObject({ title: 'Room Seq (v2)', icsSequence: second.icsSequence + 1 });
  });
});
