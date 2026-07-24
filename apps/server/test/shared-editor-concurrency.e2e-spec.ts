import request from 'supertest';
import { closeTestApp, createTestApp, type TestAppContext } from './test-app';

const dmA = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-tab-a' };
const dmB = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-tab-b' };
const otherPlayer = { 'x-dev-role': 'player', 'x-dev-user': 'other-player' };

function expectOneWinner(results: request.Response[]) {
  const winners = results.filter((result) => result.status >= 200 && result.status < 300);
  const stale = results.filter((result) => result.status === 409);
  expect(winners).toHaveLength(1);
  expect(stale).toHaveLength(1);
  expect(stale[0].body).toMatchObject({ code: 'STALE_WRITE' });
  expect(stale[0].body.currentUpdatedAt).toBe(winners[0].body.updatedAt);
  return { winner: winners[0], stale: stale[0] };
}

/** Real HTTP + SQLite coverage for issue #881's shared editors. */
describe('shared editor optimistic concurrency (e2e) — #881', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.app.listen(0);
    baseUrl = await ctx.app.getUrl();
    const campaign = await request(baseUrl).post('/api/v1/campaigns').set(dmA).send({ name: 'Concurrency table' });
    campaignId = campaign.body.id;
  });

  afterAll(async () => closeTestApp(ctx));

  it('atomically creates and then updates Session Zero; stale safety edits never land and prior safety content is recoverable', async () => {
    const emptyA = await request(baseUrl).get(`/api/v1/campaigns/${campaignId}/session-zero`).set(dmA);
    const emptyB = await request(baseUrl).get(`/api/v1/campaigns/${campaignId}/session-zero`).set(dmB);
    expect(emptyA.body.updatedAt).toBe(emptyB.body.updatedAt);

    const first = await Promise.all([
      request(baseUrl).put(`/api/v1/campaigns/${campaignId}/session-zero`).set(dmA).send({ lines: ['spiders'], expectedUpdatedAt: emptyA.body.updatedAt }),
      request(baseUrl).put(`/api/v1/campaigns/${campaignId}/session-zero`).set(dmB).send({ lines: ['harm to children'], expectedUpdatedAt: emptyB.body.updatedAt }),
    ]);
    const created = expectOneWinner(first).winner.body;

    const second = await Promise.all([
      request(baseUrl).put(`/api/v1/campaigns/${campaignId}/session-zero`).set(dmA).send({ veils: ['gore'], expectedUpdatedAt: created.updatedAt }),
      request(baseUrl).put(`/api/v1/campaigns/${campaignId}/session-zero`).set(dmB).send({ safetyTools: ['X-Card'], expectedUpdatedAt: created.updatedAt }),
    ]);
    expectOneWinner(second);

    const revisions = await request(baseUrl).get(`/api/v1/revisions/session_zero/${campaignId}`).set(dmA);
    expect(revisions.status).toBe(200);
    expect(revisions.body).toHaveLength(1);
    expect(revisions.body[0].snapshot.lines).toEqual(created.lines);
  });

  it('rejects racing timeline-event and calendar edits with the latest revision token', async () => {
    const event = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .set(dmA)
      .send({ title: 'Coronation', body: 'Old canon' });
    expectOneWinner(await Promise.all([
      request(baseUrl).patch(`/api/v1/timeline/${event.body.id}`).set(dmA).send({ body: 'Canon A', expectedUpdatedAt: event.body.updatedAt }),
      request(baseUrl).patch(`/api/v1/timeline/${event.body.id}`).set(dmB).send({ body: 'Canon B', expectedUpdatedAt: event.body.updatedAt }),
    ]));
    const eventRevisions = await request(baseUrl).get(`/api/v1/revisions/timeline_event/${event.body.id}`).set(dmA);
    expect(eventRevisions.body[0].snapshot.body).toBe('Old canon');
    expect((await request(baseUrl)
      .post(`/api/v1/revisions/timeline_event/${event.body.id}/${eventRevisions.body[0].id}/restore`)
      .set(dmA)).status).toBe(201);
    expect((await request(baseUrl).get(`/api/v1/timeline/${event.body.id}`).set(dmA)).body.body).toBe('Old canon');

    const calendarA = await request(baseUrl).get(`/api/v1/campaigns/${campaignId}/timeline/calendar`).set(dmA);
    const calendarB = await request(baseUrl).get(`/api/v1/campaigns/${campaignId}/timeline/calendar`).set(dmB);
    const calendarWinner = expectOneWinner(await Promise.all([
      request(baseUrl).put(`/api/v1/campaigns/${campaignId}/timeline/calendar`).set(dmA).send({ currentDate: 'Day 1', expectedUpdatedAt: calendarA.body.updatedAt }),
      request(baseUrl).put(`/api/v1/campaigns/${campaignId}/timeline/calendar`).set(dmB).send({ currentDate: 'Day 2', expectedUpdatedAt: calendarB.body.updatedAt }),
    ])).winner.body;
    const firstNote = await request(baseUrl)
      .put(`/api/v1/campaigns/${campaignId}/timeline/calendar`)
      .set(dmA)
      .send({ note: 'First calendar note', expectedUpdatedAt: calendarWinner.updatedAt });
    await request(baseUrl)
      .put(`/api/v1/campaigns/${campaignId}/timeline/calendar`)
      .set(dmA)
      .send({ note: 'Second calendar note', expectedUpdatedAt: firstNote.body.updatedAt });
    const calendarHistory = await request(baseUrl).get(`/api/v1/revisions/timeline_calendar/${campaignId}`).set(dmA);
    const firstNoteRevision = calendarHistory.body.find((revision: { snapshot: { note?: string } }) => revision.snapshot.note === 'First calendar note');
    expect(firstNoteRevision).toBeDefined();
    await request(baseUrl)
      .post(`/api/v1/revisions/timeline_calendar/${campaignId}/${firstNoteRevision.id}/restore`)
      .set(dmA)
      .expect(201);
    expect((await request(baseUrl).get(`/api/v1/campaigns/${campaignId}/timeline/calendar`).set(dmA)).body.note).toBe('First calendar note');
  });

  it('protects scheduled-session notes and records their prior prose', async () => {
    const schedule = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/schedule`)
      .set(dmA)
      .send({ scheduledAt: '2030-02-01T20:00:00.000Z', notes: 'Bring minis' });
    expectOneWinner(await Promise.all([
      request(baseUrl).patch(`/api/v1/schedule/${schedule.body.id}`).set(dmA).send({ notes: 'Bring minis and maps', expectedUpdatedAt: schedule.body.updatedAt }),
      request(baseUrl).patch(`/api/v1/schedule/${schedule.body.id}`).set(dmB).send({ notes: 'Online only', expectedUpdatedAt: schedule.body.updatedAt }),
    ]));
    const revisions = await request(baseUrl).get(`/api/v1/revisions/scheduled_session/${schedule.body.id}`).set(dmA);
    expect(revisions.body[0].snapshot.notes).toBe('Bring minis');
    await request(baseUrl)
      .post(`/api/v1/revisions/scheduled_session/${schedule.body.id}/${revisions.body[0].id}/restore`)
      .set(dmA)
      .expect(201);
    expect((await request(baseUrl).get(`/api/v1/schedule/${schedule.body.id}`).set(dmA)).body.notes).toBe('Bring minis');
  });

  it('protects Storyline play-record link edits', async () => {
    const session = await request(baseUrl).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dmA).send({ number: 20 });
    const quest = await request(baseUrl).post(`/api/v1/campaigns/${campaignId}/quests`).set(dmA).send({ title: 'Link target' });
    const arc = await request(baseUrl).post(`/api/v1/campaigns/${campaignId}/arcs`).set(dmA).send({ title: 'Arc' });
    const beat = await request(baseUrl).post(`/api/v1/arcs/${arc.body.id}/beats`).set(dmA).send({ title: 'Beat' });
    expectOneWinner(await Promise.all([
      request(baseUrl).patch(`/api/v1/beats/${beat.body.id}`).set(dmA).send({ sessionId: session.body.id, expectedUpdatedAt: beat.body.updatedAt }),
      request(baseUrl).patch(`/api/v1/beats/${beat.body.id}`).set(dmB).send({ questId: quest.body.id, expectedUpdatedAt: beat.body.updatedAt }),
    ]));
    const linkedBeat = await request(baseUrl).get(`/api/v1/beats/${beat.body.id}`).set(dmA);
    const firstBody = await request(baseUrl)
      .patch(`/api/v1/beats/${beat.body.id}`)
      .set(dmA)
      .send({ body: 'First beat prose', expectedUpdatedAt: linkedBeat.body.updatedAt });
    await request(baseUrl)
      .patch(`/api/v1/beats/${beat.body.id}`)
      .set(dmA)
      .send({ body: 'Second beat prose', expectedUpdatedAt: firstBody.body.updatedAt });
    const history = await request(baseUrl).get(`/api/v1/revisions/story_beat/${beat.body.id}`).set(dmA);
    const firstBodyRevision = history.body.find((revision: { snapshot: { body?: string } }) => revision.snapshot.body === 'First beat prose');
    await request(baseUrl)
      .post(`/api/v1/revisions/story_beat/${beat.body.id}/${firstBodyRevision.id}/restore`)
      .set(dmA)
      .expect(201);
    expect((await request(baseUrl).get(`/api/v1/beats/${beat.body.id}`).set(dmA)).body.body).toBe('First beat prose');
  });

  it('protects author/DM discussion edits, preserves the rejected draft client-side contract, and restores prior prose', async () => {
    const session = await request(baseUrl).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dmA).send({ number: 21 });
    const comment = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(dmA)
      .send({ entityType: 'session', entityId: session.body.id, body: 'Original thought' });
    expectOneWinner(await Promise.all([
      request(baseUrl).patch(`/api/v1/comments/${comment.body.id}`).set(dmA).send({ body: 'Edit from browser A', expectedUpdatedAt: comment.body.updatedAt }),
      request(baseUrl).patch(`/api/v1/comments/${comment.body.id}`).set(dmB).send({ body: 'Edit from browser B', expectedUpdatedAt: comment.body.updatedAt }),
    ]));
    const revisions = await request(baseUrl).get(`/api/v1/comments/${comment.body.id}/revisions`).set(dmA);
    expect(revisions.body[0].snapshot.body).toBe('Original thought');
    expect((await request(baseUrl).get(`/api/v1/comments/${comment.body.id}/revisions`).set(otherPlayer)).status).toBe(403);
    const restore = await request(baseUrl)
      .post(`/api/v1/comments/${comment.body.id}/revisions/${revisions.body[0].id}/restore`)
      .set(dmA);
    expect(restore.status).toBe(201);
    const current = await request(baseUrl).get(`/api/v1/comments/${comment.body.id}`).set(dmA);
    expect(current.body.body).toBe('Original thought');

    const hiddenQuest = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/quests`)
      .set(dmA)
      .send({ title: 'Secret anchor', hidden: true });
    const secretComment = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/comments`)
      .set(dmA)
      .send({ entityType: 'quest', entityId: hiddenQuest.body.id, body: 'Secret discussion' });
    await request(baseUrl)
      .patch(`/api/v1/comments/${secretComment.body.id}`)
      .set(dmA)
      .send({ body: 'Edited secret', expectedUpdatedAt: secretComment.body.updatedAt });
    expect((await request(baseUrl).get(`/api/v1/comments/${secretComment.body.id}/revisions`).set(otherPlayer)).status).toBe(404);
  });

  it('allows a conflict retry only against the returned current revision', async () => {
    const event = await request(baseUrl)
      .post(`/api/v1/campaigns/${campaignId}/timeline`)
      .set(dmA)
      .send({ title: 'Retry', body: 'base' });
    const winner = await request(baseUrl).patch(`/api/v1/timeline/${event.body.id}`).set(dmA).send({ body: 'remote', expectedUpdatedAt: event.body.updatedAt });
    const stale = await request(baseUrl).patch(`/api/v1/timeline/${event.body.id}`).set(dmB).send({ body: 'local draft', expectedUpdatedAt: event.body.updatedAt });
    expect(stale.body.currentUpdatedAt).toBe(winner.body.updatedAt);
    const retry = await request(baseUrl).patch(`/api/v1/timeline/${event.body.id}`).set(dmB).send({ body: 'remote\n\nlocal draft', expectedUpdatedAt: stale.body.currentUpdatedAt });
    expect(retry.status).toBe(200);
    expect(retry.body.body).toBe('remote\n\nlocal draft');
  });
});
