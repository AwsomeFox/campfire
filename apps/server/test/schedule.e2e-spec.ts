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
import { campaigns, scheduledSessions } from '../src/db/schema';
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

  it('members can clear an RSVP note with an explicit empty string', async () => {
    const server = ctx.app.getHttpServer();
    const next = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/next`).set(player);
    const scheduleId = next.body.id;

    await request(server)
      .put(`/api/v1/schedule/${scheduleId}/rsvp`)
      .set(player)
      .send({ status: 'yes', note: 'bringing snacks' });

    const cleared = await request(server)
      .put(`/api/v1/schedule/${scheduleId}/rsvp`)
      .set(player)
      .send({ note: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.rsvps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'dev:player-1', status: 'yes', note: '' }),
      ]),
    );
  });

  it('status-only RSVP updates preserve a note edited concurrently', async () => {
    const server = ctx.app.getHttpServer();
    const next = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/next`).set(player);
    const scheduleId = next.body.id;

    await request(server)
      .put(`/api/v1/schedule/${scheduleId}/rsvp`)
      .set(player)
      .send({ status: 'yes', note: 'old note' });

    await request(server)
      .put(`/api/v1/schedule/${scheduleId}/rsvp`)
      .set(player)
      .send({ note: 'fresh note' });

    const statusOnly = await request(server)
      .put(`/api/v1/schedule/${scheduleId}/rsvp`)
      .set(player)
      .send({ status: 'maybe' });
    expect(statusOnly.status).toBe(200);
    expect(statusOnly.body.rsvps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'dev:player-1', status: 'maybe', note: 'fresh note' }),
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

    const playerDelete = await request(server).delete(`/api/v1/schedule/${id}`).set(player).send({});
    expect(playerDelete.status).toBe(403);

    const del = await request(server).delete(`/api/v1/schedule/${id}`).set(dm).send({});
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ id, status: 'cancelled' });

    const list = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule`).set(dm);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, status: 'cancelled' }),
      ]),
    );
    const upcoming = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(dm);
    expect(upcoming.body.some((s: { id: number }) => s.id === id)).toBe(false);
  });

  it('accepts omitted and empty cancel bodies and treats repeat cancel as idempotent', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-08-15T18:00:00Z', title: 'Optional cancel body' });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const withoutBody = await request(server).delete(`/api/v1/schedule/${id}`).set(dm);
    expect(withoutBody.status).toBe(200);
    expect(withoutBody.body).toMatchObject({ id, status: 'cancelled', cancellationReason: '' });
    expect(withoutBody.body.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const repeated = await request(server).delete(`/api/v1/schedule/${id}`).set(dm).send({});
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({ id, status: 'cancelled', cancellationReason: '' });
    expect(repeated.body.cancelledAt).toBe(withoutBody.body.cancelledAt);
  });

  it('cancel retains RSVPs, records metadata, and restore returns the row to upcoming', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-10-01T18:00:00Z', title: 'Keep the RSVPs' });
    const id = created.body.id;

    await request(server).put(`/api/v1/schedule/${id}/rsvp`).set(player).send({ status: 'yes', note: 'can still make it' }).expect(200);
    await request(server).put(`/api/v1/schedule/${id}/rsvp`).set(dm).send({ status: 'maybe' }).expect(200);

    const cancelled = await request(server)
      .delete(`/api/v1/schedule/${id}`)
      .set(dm)
      .send({ reason: 'DM is travelling' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      id,
      status: 'cancelled',
      cancelledBy: 'dev:dm-1',
      cancellationReason: 'DM is travelling',
    });
    expect(cancelled.body.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(cancelled.body.rsvps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'dev:player-1', status: 'yes', note: 'can still make it' }),
        expect.objectContaining({ userId: 'dev:dm-1', status: 'maybe' }),
      ]),
    );

    const get = await request(server).get(`/api/v1/schedule/${id}`).set(player);
    expect(get.status).toBe(200);
    expect(get.body.rsvps).toHaveLength(2);

    const rsvpAfterCancel = await request(server).put(`/api/v1/schedule/${id}/rsvp`).set(player).send({ status: 'no' });
    expect(rsvpAfterCancel.status).toBe(400);

    const upcoming = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(player);
    expect(upcoming.body.some((s: { id: number }) => s.id === id)).toBe(false);

    const past = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/past`).set(player);
    expect(past.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, status: 'cancelled', rsvps: expect.any(Array) }),
      ]),
    );

    const duplicate = await request(server)
      .post(`/api/v1/schedule/${id}/duplicate`)
      .set(dm)
      .send({ scheduledAt: '2099-10-08T18:00:00Z', title: 'Rescheduled night' });
    expect(duplicate.status).toBe(201);
    expect(duplicate.body).toMatchObject({
      status: 'scheduled',
      scheduledAt: '2099-10-08T18:00:00.000Z',
      title: 'Rescheduled night',
      rsvps: [],
    });

    const restored = await request(server).post(`/api/v1/schedule/${id}/restore`).set(dm);
    expect(restored.status).toBe(201);
    expect(restored.body).toMatchObject({
      id,
      status: 'scheduled',
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: '',
    });
    expect(restored.body.rsvps).toHaveLength(2);

    const upcomingAfterRestore = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(player);
    expect(upcomingAfterRestore.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, status: 'scheduled', rsvps: expect.any(Array) }),
      ]),
    );
  });

  it('creating a recap with scheduledSessionId completes and links the schedule', async () => {
    const server = ctx.app.getHttpServer();
    const scheduled = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-11-01T18:00:00Z', title: 'Played night' });
    expect(scheduled.status).toBe(201);

    const recap = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({
        title: 'Played night recap',
        playedAt: '2099-11-01',
        recap: 'We played the linked night.',
        scheduledSessionId: scheduled.body.id,
      });
    expect(recap.status).toBe(201);
    expect(recap.body.scheduledSessionId).toBe(scheduled.body.id);

    const linked = await request(server).get(`/api/v1/schedule/${scheduled.body.id}`).set(player);
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({
      id: scheduled.body.id,
      status: 'completed',
      sessionId: recap.body.id,
    });

    const upcoming = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(player);
    expect(upcoming.body.some((s: { id: number }) => s.id === scheduled.body.id)).toBe(false);
  });

  it('does not leave a session pointing at a new schedule when update-time linking fails', async () => {
    const server = ctx.app.getHttpServer();
    const originalSchedule = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-11-03T18:00:00Z', title: 'Original linked night' });
    expect(originalSchedule.status).toBe(201);
    const recap = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({
        title: 'Already linked recap',
        playedAt: '2099-11-03',
        recap: 'This recap is already linked.',
        scheduledSessionId: originalSchedule.body.id,
      });
    expect(recap.status).toBe(201);
    expect(recap.body.scheduledSessionId).toBe(originalSchedule.body.id);

    const replacementSchedule = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-11-10T18:00:00Z', title: 'Replacement night' });
    expect(replacementSchedule.status).toBe(201);

    const relink = await request(server)
      .patch(`/api/v1/sessions/${recap.body.id}`)
      .set(dm)
      .send({ scheduledSessionId: replacementSchedule.body.id });
    expect(relink.status).toBe(400);

    const unchangedRecap = await request(server).get(`/api/v1/sessions/${recap.body.id}`).set(dm);
    expect(unchangedRecap.status).toBe(200);
    expect(unchangedRecap.body.scheduledSessionId).toBe(originalSchedule.body.id);

    const untouchedReplacement = await request(server).get(`/api/v1/schedule/${replacementSchedule.body.id}`).set(player);
    expect(untouchedReplacement.status).toBe(200);
    expect(untouchedReplacement.body).toMatchObject({
      id: replacementSchedule.body.id,
      status: 'scheduled',
      sessionId: null,
    });
  });

  it('a rejected relink rolls back the other fields in the same PATCH (no partial write)', async () => {
    const server = ctx.app.getHttpServer();
    const originalSchedule = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-11-04T18:00:00Z', title: 'Partial-write origin' });
    const recap = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({
        title: 'Original title',
        playedAt: '2099-11-04',
        recap: 'Original recap body.',
        scheduledSessionId: originalSchedule.body.id,
      });
    expect(recap.status).toBe(201);

    const replacementSchedule = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-11-11T18:00:00Z', title: 'Partial-write replacement' });

    // A PATCH carrying BOTH a field edit and a relink that must be rejected. The field
    // edit used to commit (and audit) before the link guard fired, so the caller got a
    // 400 describing a change that had in fact been saved.
    const rejected = await request(server)
      .patch(`/api/v1/sessions/${recap.body.id}`)
      .set(dm)
      .send({
        title: 'Title that must NOT stick',
        recap: 'Recap that must NOT stick.',
        scheduledSessionId: replacementSchedule.body.id,
      });
    expect(rejected.status).toBe(400);

    const after = await request(server).get(`/api/v1/sessions/${recap.body.id}`).set(dm);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({
      title: 'Original title',
      recap: 'Original recap body.',
      scheduledSessionId: originalSchedule.body.id,
    });

    // ...and neither schedule moved.
    const origAfter = await request(server).get(`/api/v1/schedule/${originalSchedule.body.id}`).set(player);
    expect(origAfter.body).toMatchObject({ status: 'completed', sessionId: recap.body.id });
    const replAfter = await request(server).get(`/api/v1/schedule/${replacementSchedule.body.id}`).set(player);
    expect(replAfter.body).toMatchObject({ status: 'scheduled', sessionId: null });
  });

  it('a field edit and an unlink in one PATCH both apply, leaving no half-link', async () => {
    const server = ctx.app.getHttpServer();
    const scheduled = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-11-06T18:00:00Z', title: 'Unlink with edit' });
    const recap = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({
        title: 'Before edit',
        playedAt: '2099-11-06',
        recap: 'Before edit body.',
        scheduledSessionId: scheduled.body.id,
      });
    expect(recap.status).toBe(201);

    const patched = await request(server)
      .patch(`/api/v1/sessions/${recap.body.id}`)
      .set(dm)
      .send({ title: 'After edit', scheduledSessionId: null });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ title: 'After edit', scheduledSessionId: null });

    // The schedule side cleared in the same transaction — no dangling completed row.
    const scheduleAfter = await request(server).get(`/api/v1/schedule/${scheduled.body.id}`).set(player);
    expect(scheduleAfter.body).toMatchObject({ status: 'scheduled', sessionId: null });
  });

  it('an identical retry of a linked recap is idempotent instead of 400', async () => {
    const server = ctx.app.getHttpServer();
    const scheduled = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-12-15T18:00:00Z', title: 'Retry night' });
    const body = {
      title: 'Retry recap',
      playedAt: '2099-12-15',
      recap: 'A byte-identical retry of this recap must not 400.',
      scheduledSessionId: scheduled.body.id,
    };

    const first = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send(body);
    expect(first.status).toBe(201);
    expect(first.body.scheduledSessionId).toBe(scheduled.body.id);

    // #160 retry-safety: the first call flipped the schedule to 'completed', which used
    // to make the retry's pre-check reject it outright. It must dedupe to the same row.
    const retry = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send(body);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.scheduledSessionId).toBe(scheduled.body.id);

    const scheduleAfter = await request(server).get(`/api/v1/schedule/${scheduled.body.id}`).set(player);
    expect(scheduleAfter.body).toMatchObject({ status: 'completed', sessionId: first.body.id });
  });

  it('clearing scheduledSessionId unlinks BOTH sides instead of stranding the schedule', async () => {
    const server = ctx.app.getHttpServer();
    const scheduled = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-11-17T18:00:00Z', title: 'Unlink me' });
    expect(scheduled.status).toBe(201);
    const scheduleId = scheduled.body.id;

    const recap = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({
        title: 'Unlink recap',
        playedAt: '2099-11-17',
        recap: 'Linked, then unlinked.',
        scheduledSessionId: scheduleId,
      });
    expect(recap.status).toBe(201);

    const linked = await request(server).get(`/api/v1/schedule/${scheduleId}`).set(player);
    expect(linked.body).toMatchObject({ status: 'completed', sessionId: recap.body.id });

    const unlink = await request(server)
      .patch(`/api/v1/sessions/${recap.body.id}`)
      .set(dm)
      .send({ scheduledSessionId: null });
    expect(unlink.status).toBe(200);
    expect(unlink.body.scheduledSessionId).toBeNull();

    // The schedule must not stay 'completed' pointing back at a recap that no longer
    // claims it — that half-link renders a dead Recap link and blocks every future link.
    const afterUnlink = await request(server).get(`/api/v1/schedule/${scheduleId}`).set(player);
    expect(afterUnlink.status).toBe(200);
    expect(afterUnlink.body).toMatchObject({ id: scheduleId, status: 'scheduled', sessionId: null });

    // Back to 'scheduled' means it is live again, and re-linking is possible.
    const upcoming = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(player);
    expect(upcoming.body.some((s: { id: number }) => s.id === scheduleId)).toBe(true);

    const relink = await request(server)
      .patch(`/api/v1/sessions/${recap.body.id}`)
      .set(dm)
      .send({ scheduledSessionId: scheduleId });
    expect(relink.status).toBe(200);
    expect(relink.body.scheduledSessionId).toBe(scheduleId);
  });

  it('hides the recap link while the linked session is trashed, and restores it on untrash', async () => {
    const server = ctx.app.getHttpServer();
    const scheduled = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-11-20T18:00:00Z', title: 'Trash the recap' });
    expect(scheduled.status).toBe(201);
    const scheduleId = scheduled.body.id;

    const recap = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({
        title: 'Trashable recap',
        playedAt: '2099-11-20',
        recap: 'This recap gets trashed.',
        scheduledSessionId: scheduleId,
      });
    expect(recap.status).toBe(201);
    const sessionId = recap.body.id;

    const linked = await request(server).get(`/api/v1/schedule/${scheduleId}`).set(player);
    expect(linked.body).toMatchObject({ status: 'completed', sessionId });

    // Trash (soft-delete) the recap. The session becomes unreadable...
    const trash = await request(server).delete(`/api/v1/sessions/${sessionId}`).set(dm);
    expect(trash.status).toBe(200);
    expect((await request(server).get(`/api/v1/sessions/${sessionId}`).set(dm)).status).toBe(404);

    // ...so the schedule must stop advertising a Recap link that would 404, and must
    // stop claiming it was completed by a recap nobody can open.
    const whileTrashed = await request(server).get(`/api/v1/schedule/${scheduleId}`).set(player);
    expect(whileTrashed.status).toBe(200);
    expect(whileTrashed.body).toMatchObject({ id: scheduleId, sessionId: null, status: 'scheduled' });

    // Every list projection must agree with that single read — including the LIVE ones,
    // which filter in SQL and so never reached the read-time reconciliation. This night
    // is future-dated, so once it reconciles to 'scheduled' it is a real upcoming game
    // again: it must come BACK to Upcoming/Next and must NOT sit in Past. Filtering on
    // the raw status silently dropped it from the view a DM plans from.
    const upcomingWhileTrashed = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(player);
    expect(upcomingWhileTrashed.body.map((s: { id: number }) => s.id)).toContain(scheduleId);
    expect(upcomingWhileTrashed.body.find((s: { id: number }) => s.id === scheduleId)).toMatchObject({
      sessionId: null,
      status: 'scheduled',
    });

    // Live and past are exact complements: present in Upcoming means absent from Past.
    const pastWhileTrashed = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/past`).set(player);
    expect(pastWhileTrashed.body.items.map((s: { id: number }) => s.id)).not.toContain(scheduleId);

    const fullList = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule`).set(player);
    expect(fullList.body.find((s: { id: number }) => s.id === scheduleId)).toMatchObject({
      sessionId: null,
      status: 'scheduled',
    });

    // The link is only HIDDEN, never torn down — restoring the recap brings it back
    // with no repair write. This is the whole reason the fix is read-time.
    const restored = await request(server).post(`/api/v1/sessions/${sessionId}/restore`).set(dm);
    expect(restored.status).toBe(201);
    expect(restored.body.scheduledSessionId).toBe(scheduleId);

    const afterRestore = await request(server).get(`/api/v1/schedule/${scheduleId}`).set(player);
    expect(afterRestore.status).toBe(200);
    expect(afterRestore.body).toMatchObject({ id: scheduleId, status: 'completed', sessionId });

    // ...and the live/past split flips back with it, still exactly complementary.
    const upcomingAfterRestore = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(player);
    expect(upcomingAfterRestore.body.map((s: { id: number }) => s.id)).not.toContain(scheduleId);
    const pastAfterRestore = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/past`).set(player);
    expect(pastAfterRestore.body.items.map((s: { id: number }) => s.id)).toContain(scheduleId);
  });

  it('accepts RSVPs and a DM cancel on a future night whose linked recap is trashed', async () => {
    // Regression: the read path reconciles this row to an effective 'scheduled' and
    // scheduleLiveSql() keeps it in Upcoming, so the web renders it as an ordinary game
    // night with RSVP controls and a Cancel button. Both write guards used to read the
    // RAW 'completed' column and 400 — the card looked live and every control on it failed.
    const server = ctx.app.getHttpServer();
    const scheduled = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-11-27T18:00:00Z', title: 'Write guards vs trashed recap' });
    expect(scheduled.status).toBe(201);
    const scheduleId = scheduled.body.id;

    const recap = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({
        title: 'Recap headed for the trash',
        playedAt: '2099-11-27',
        recap: 'Soon to be trashed.',
        scheduledSessionId: scheduleId,
      });
    expect(recap.status).toBe(201);
    await request(server).delete(`/api/v1/sessions/${recap.body.id}`).set(dm).expect(200);

    // What the UI is looking at: a normal upcoming night.
    const upcoming = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(player);
    expect(upcoming.body.find((s: { id: number }) => s.id === scheduleId)).toMatchObject({
      status: 'scheduled',
      sessionId: null,
    });

    // (a) a player's RSVP must land, not 400.
    const rsvp = await request(server)
      .put(`/api/v1/schedule/${scheduleId}/rsvp`)
      .set(player)
      .send({ status: 'yes', note: 'bringing dice' });
    expect(rsvp.status).toBe(200);
    expect(rsvp.body.rsvps).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: 'dev:player-1', status: 'yes' })]),
    );

    // (b) the DM's Cancel must land, not 400.
    const cancel = await request(server)
      .delete(`/api/v1/schedule/${scheduleId}`)
      .set(dm)
      .send({ reason: 'called off after all' });
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ id: scheduleId, status: 'cancelled', cancellationReason: 'called off after all' });

    // Cancelling leaves the stored link alone (the trash stays reversible), and the
    // cancelled night drops out of Upcoming like any other.
    const upcomingAfter = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/upcoming`).set(player);
    expect(upcomingAfter.body.map((s: { id: number }) => s.id)).not.toContain(scheduleId);
  });

  it('never shows a recap link on a cancelled night, but keeps the stored link intact', async () => {
    // State chain reachable only since remove() started reading the EFFECTIVE status:
    // a future `completed` row whose recap is trashed reads as 'scheduled', so the DM
    // can cancel it — and cancel deliberately leaves session_id alone so the Trash
    // stays reversible. Untrash the recap and the raw row is `cancelled` WITH a live
    // link, which would render a "Cancelled" tag beside a working "Recap" link.
    const server = ctx.app.getHttpServer();
    const scheduled = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-12-05T18:00:00Z', title: 'Cancelled, recap restored' });
    expect(scheduled.status).toBe(201);
    const scheduleId = scheduled.body.id;

    const recap = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({
        title: 'Recap that comes back',
        playedAt: '2099-12-05',
        recap: 'Trashed, then restored.',
        scheduledSessionId: scheduleId,
      });
    expect(recap.status).toBe(201);
    const sessionId = recap.body.id;

    await request(server).delete(`/api/v1/sessions/${sessionId}`).set(dm).expect(200);
    await request(server).delete(`/api/v1/schedule/${scheduleId}`).set(dm).send({ reason: 'off' }).expect(200);

    // The recap comes back out of the Trash while the night stays cancelled.
    await request(server).post(`/api/v1/sessions/${sessionId}/restore`).set(dm).expect(201);

    const cancelled = await request(server).get(`/api/v1/schedule/${scheduleId}`).set(player);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ id: scheduleId, status: 'cancelled', sessionId: null });

    const past = await request(server).get(`/api/v1/campaigns/${campaignId}/schedule/past`).set(player);
    expect(past.body.items.find((s: { id: number }) => s.id === scheduleId)).toMatchObject({
      status: 'cancelled',
      sessionId: null,
    });

    // Hidden at READ time only — nothing was thrown away. The export still records the
    // stored link, and restoring the SCHEDULE brings back the completed lifecycle with
    // no repair write.
    const exported = await request(server).get(`/api/v1/campaigns/${campaignId}/export`).set(dm);
    expect(exported.body.scheduledSessions.find((s: { id: number }) => s.id === scheduleId)).toMatchObject({
      status: 'cancelled',
      sessionId,
    });

    const restored = await request(server).post(`/api/v1/schedule/${scheduleId}/restore`).set(dm);
    expect(restored.status).toBe(201);
    expect(restored.body).toMatchObject({ id: scheduleId, status: 'completed', sessionId });
  });

  it('rejects an edit to a cancelled night rather than notifying the party about it', async () => {
    // update() had no status guard at all: a DM could PATCH the time of a called-off
    // game and the party would get a "rescheduled" push for a night that is not
    // happening (plus a committed notes revision). Restore is the way back.
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-11-28T18:00:00Z', title: 'Called off' });
    expect(created.status).toBe(201);
    const id = created.body.id;

    await request(server).delete(`/api/v1/schedule/${id}`).set(dm).send({ reason: 'flu' }).expect(200);

    const patch = await request(server)
      .patch(`/api/v1/schedule/${id}`)
      .set(dm)
      .send({ scheduledAt: '2099-11-29T18:00:00Z', notes: 'moved it' });
    expect(patch.status).toBe(400);

    // Nothing was written — not the time, not the notes.
    const unchanged = await request(server).get(`/api/v1/schedule/${id}`).set(dm);
    expect(unchanged.body).toMatchObject({
      id,
      status: 'cancelled',
      scheduledAt: '2099-11-28T18:00:00.000Z',
      notes: '',
    });

    // Restore first, then edit: the documented path, and it still works.
    await request(server).post(`/api/v1/schedule/${id}/restore`).set(dm).expect(201);
    const afterRestore = await request(server)
      .patch(`/api/v1/schedule/${id}`)
      .set(dm)
      .send({ scheduledAt: '2099-11-29T18:00:00Z' });
    expect(afterRestore.status).toBe(200);
    expect(afterRestore.body.scheduledAt).toBe('2099-11-29T18:00:00.000Z');
  });

  it('keeps cancelled nights out of campaign search, which has no room to badge them', async () => {
    // Before #504 a cancelled night was hard-deleted, so search never returned one.
    // SearchResult carries no status field, so a retained cancelled row would look
    // exactly like a live game night in the results list.
    const server = ctx.app.getHttpServer();
    const searchCampaign = await request(server)
      .post('/api/v1/campaigns')
      .set(dm)
      .send({ name: 'Schedule Search Campaign' });
    const searchCampaignId = searchCampaign.body.id;

    const live = await request(server)
      .post(`/api/v1/campaigns/${searchCampaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-05-05T18:00:00Z', title: 'Basilisk Gulch showdown' });
    const doomed = await request(server)
      .post(`/api/v1/campaigns/${searchCampaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-05-12T18:00:00Z', title: 'Basilisk Gulch rematch' });
    expect(doomed.status).toBe(201);

    const before = await request(server)
      .get(`/api/v1/campaigns/${searchCampaignId}/search?q=Basilisk%20Gulch`)
      .set(dm);
    expect(before.status).toBe(200);
    const idsBefore = before.body.results
      .filter((r: { type: string }) => r.type === 'scheduled_session')
      .map((r: { id: number }) => r.id);
    expect(idsBefore).toEqual(expect.arrayContaining([live.body.id, doomed.body.id]));

    await request(server).delete(`/api/v1/schedule/${doomed.body.id}`).set(dm).send({}).expect(200);

    const after = await request(server)
      .get(`/api/v1/campaigns/${searchCampaignId}/search?q=Basilisk%20Gulch`)
      .set(dm);
    const idsAfter = after.body.results
      .filter((r: { type: string }) => r.type === 'scheduled_session')
      .map((r: { id: number }) => r.id);
    expect(idsAfter).toContain(live.body.id);
    expect(idsAfter).not.toContain(doomed.body.id);
  });

  it('exports the RAW schedule row even while its linked recap is trashed', async () => {
    const server = ctx.app.getHttpServer();
    const scheduled = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-12-20T18:00:00Z', title: 'Archive fidelity' });
    const recap = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({
        title: 'Archived recap',
        playedAt: '2099-12-20',
        recap: 'Exported while trashed.',
        scheduledSessionId: scheduled.body.id,
      });
    expect(recap.status).toBe(201);
    await request(server).delete(`/api/v1/sessions/${recap.body.id}`).set(dm).expect(200);

    // Reads reconcile the trashed link away...
    const read = await request(server).get(`/api/v1/schedule/${scheduled.body.id}`).set(player);
    expect(read.body).toMatchObject({ status: 'scheduled', sessionId: null });

    // ...but the archive must record what the DB actually holds. The trash is
    // reversible; an export that downgraded the night to 'scheduled' would not be.
    const exported = await request(server).get(`/api/v1/campaigns/${campaignId}/export`).set(dm);
    expect(exported.status).toBe(200);
    const archived = exported.body.scheduledSessions.find((s: { title: string }) => s.title === 'Archive fidelity');
    expect(archived).toMatchObject({ status: 'completed', sessionId: recap.body.id });
  });

  it('duplicating a session whose window was shrunk below the create floor clamps the duration', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dm)
      .send({ scheduledAt: '2099-11-24T18:00:00Z', durationMinutes: 240, title: 'Ended early' });
    expect(created.status).toBe(201);

    // Mid-session "End session" (#818) legitimately shrinks a live night below the
    // 15-minute create floor; ScheduledSessionUpdate allows min 0.
    const shrink = await request(server)
      .patch(`/api/v1/schedule/${created.body.id}`)
      .set(dm)
      .send({ durationMinutes: 0 });
    expect(shrink.status).toBe(200);
    expect(shrink.body.durationMinutes).toBe(0);

    // Duplicate copies the source duration when the caller omits it (REST/MCP path).
    // The copy is a NEW live night, so it must still satisfy the create floor of 15.
    const duplicate = await request(server)
      .post(`/api/v1/schedule/${created.body.id}/duplicate`)
      .set(dm)
      .send({ scheduledAt: '2099-12-01T18:00:00Z' });
    expect(duplicate.status).toBe(201);
    expect(duplicate.body.status).toBe('scheduled');
    expect(duplicate.body.durationMinutes).toBeGreaterThanOrEqual(15);
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
      await request(server).delete(`/api/v1/schedule/${maxOk.body.id}`).set(dm).send({});
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

      await request(server).delete(`/api/v1/schedule/${overlap.body.id}`).set(dm).send({});
      await request(server).delete(`/api/v1/schedule/${later.body.id}`).set(dm).send({});
      await request(server).delete(`/api/v1/schedule/${live.body.id}`).set(dm).send({});
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

      await request(server).delete(`/api/v1/schedule/${id}`).set(dm).send({});
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

      await request(server).delete(`/api/v1/schedule/${morning.body.id}`).set(dm).send({});
      await request(server).delete(`/api/v1/schedule/${evening.body.id}`).set(dm).send({});
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

      await request(server).delete(`/api/v1/schedule/${created.body.id}`).set(dm).send({});
    });

    it('keeps the same ICS UID and marks cancelled schedules as STATUS:CANCELLED', async () => {
      const server = ctx.app.getHttpServer();
      const created = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/schedule`)
        .set(dm)
        .send({ scheduledAt: '2099-09-03T18:00:00Z', title: 'Calendar cancellation' });
      expect(created.status).toBe(201);
      const uid = `UID:campfire-c${campaignId}-s${created.body.id}@campfire`;

      const before = await request(server).get(`/api/v1/calendar/${token}.ics`);
      expect(before.status).toBe(200);
      expect(before.text).toContain(uid);
      expect(before.text).not.toContain(`${uid}\r\nSTATUS:CANCELLED`);

      const cancelled = await request(server).delete(`/api/v1/schedule/${created.body.id}`).set(dm).send({});
      expect(cancelled.status).toBe(200);

      const after = await request(server).get(`/api/v1/calendar/${token}.ics`);
      expect(after.status).toBe(200);
      expect(after.text).toContain(uid);
      expect(after.text).toContain('STATUS:CANCELLED');
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

      await request(server).delete(`/api/v1/schedule/${created.body.id}`).set(dm).send({});
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

  it('issue #1521: a row whose scheduledAt julianday() cannot parse lands in Past, not nowhere', async () => {
    // Defence in depth for the projections. The import boundary now rejects
    // unparseable scheduledAt values, so the only way such a row can exist is a
    // direct DB edit / hand-corrupted row. scheduleEndedSql() treats an
    // unclassifiable end instant as ended, so the row surfaces in Past (where an
    // operator can find and fix it) instead of vanishing from BOTH Upcoming and
    // Past — which is what a NULL julianday() comparison did before. Parseable
    // rows are unaffected: the IS NULL arm is dead for them, so the strict
    // live/past complement is preserved.
    const server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Corrupt Schedule Campaign' });
    const corruptCampaignId: number = camp.body.id;
    const db = ctx.app.get<DrizzleDb>(DB);
    const corruptTs = new Date().toISOString();
    const [bad] = await db
      .insert(scheduledSessions)
      .values({
        campaignId: corruptCampaignId,
        scheduledAt: 'not-a-real-date', // julianday() -> NULL
        durationMinutes: 240,
        title: 'Corrupt imported night',
        status: 'scheduled',
        createdAt: corruptTs,
        updatedAt: corruptTs,
      })
      .returning()
      .all();

    const upcoming = await request(server).get(`/api/v1/campaigns/${corruptCampaignId}/schedule/upcoming`).set(dm);
    expect(upcoming.body.find((s: { id: number }) => s.id === bad.id)).toBeUndefined();

    const past = await request(server).get(`/api/v1/campaigns/${corruptCampaignId}/schedule/past`).set(dm);
    expect(past.body.items.map((s: { id: number }) => s.id)).toContain(bad.id);
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
