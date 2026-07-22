import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { characters, sessionAttendees } from '../src/db/schema';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'att-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'att-player' };

/**
 * Issue #121 — per-session attendance (the West Marches "who was there" record).
 * A session was number/title/playedAt/recap only, so a rotating-cast table with a
 * big roster couldn't record which characters actually played a given outing. These
 * tests pin: attendance round-trips (set + get), replace-set semantics, empty clears,
 * only same-campaign characters are valid attendees, and the dm-only write guard.
 */
describe('session attendance (e2e) — issue #121', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let sessionId: number;
  let charA: number;
  let charB: number;
  let charC: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();

    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'West Marches' });
    campaignId = camp.body.id;

    const s = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number: 1, title: 'The Delve' });
    sessionId = s.body.id;

    const a = await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Aria' });
    const b = await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Bram' });
    const c = await request(server).post(`/api/v1/campaigns/${campaignId}/characters`).set(dm).send({ name: 'Cael' });
    charA = a.body.id;
    charB = b.body.id;
    charC = c.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('attendance is empty until set', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/sessions/${sessionId}/attendance`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('set + get attendance round-trips', async () => {
    const server = ctx.app.getHttpServer();

    const put = await request(server).put(`/api/v1/sessions/${sessionId}/attendance`).set(dm).send({ characterIds: [charA, charB] });
    expect(put.status).toBe(200);
    expect(put.body.map((r: { characterId: number }) => r.characterId).sort()).toEqual([charA, charB].sort());
    // denormalized name comes back for display
    const aria = put.body.find((r: { characterId: number }) => r.characterId === charA);
    expect(aria.characterName).toBe('Aria');

    const get = await request(server).get(`/api/v1/sessions/${sessionId}/attendance`).set(dm);
    expect(get.status).toBe(200);
    expect(get.body.map((r: { characterId: number }) => r.characterId).sort()).toEqual([charA, charB].sort());
  });

  it('reflects a rename immediately and survives retirement and soft-delete', async () => {
    const server = ctx.app.getHttpServer();
    const session = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({ number: 659, title: 'The Rename' });
    const character = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/characters`)
      .set(dm)
      .send({ name: 'Aria Before' });

    const set = await request(server)
      .put(`/api/v1/sessions/${session.body.id}/attendance`)
      .set(dm)
      .send({ characterIds: [character.body.id] });
    expect(set.status).toBe(200);
    expect(set.body[0].characterName).toBe('Aria Before');

    const rename = await request(server)
      .patch(`/api/v1/characters/${character.body.id}`)
      .set(dm)
      .send({ name: 'Aria After' });
    expect(rename.status).toBe(200);

    const renamedAttendance = await request(server).get(`/api/v1/sessions/${session.body.id}/attendance`).set(dm);
    expect(renamedAttendance.status).toBe(200);
    expect(renamedAttendance.body).toEqual([
      expect.objectContaining({ characterId: character.body.id, characterName: 'Aria After' }),
    ]);

    // The read is a live join, not a hidden synchronization write: the stored
    // compatibility snapshot remains the name captured by setAttendance.
    const db = ctx.app.get<DrizzleDb>(DB);
    const [stored] = await db
      .select()
      .from(sessionAttendees)
      .where(and(eq(sessionAttendees.sessionId, session.body.id), eq(sessionAttendees.characterId, character.body.id)));
    expect(stored.characterName).toBe('Aria Before');

    const retire = await request(server)
      .patch(`/api/v1/characters/${character.body.id}`)
      .set(dm)
      .send({ status: 'retired' });
    expect(retire.status).toBe(200);
    const retiredAttendance = await request(server).get(`/api/v1/sessions/${session.body.id}/attendance`).set(dm);
    expect(retiredAttendance.body[0].characterName).toBe('Aria After');

    const remove = await request(server).delete(`/api/v1/characters/${character.body.id}`).set(dm);
    expect(remove.status).toBe(200);
    const trashedAttendance = await request(server).get(`/api/v1/sessions/${session.body.id}/attendance`).set(dm);
    expect(trashedAttendance.status).toBe(200);
    expect(trashedAttendance.body).toEqual([
      expect.objectContaining({ characterId: character.body.id, characterName: 'Aria After' }),
    ]);

    // Pre-#69 databases may not have the modern FK cascade, so a historical
    // attendee can outlive a hard-deleted character. Simulate that legacy orphan
    // and verify the write-time snapshot is the graceful fallback.
    await db.run(sql`PRAGMA foreign_keys = OFF`);
    try {
      await db.delete(characters).where(eq(characters.id, character.body.id));
    } finally {
      await db.run(sql`PRAGMA foreign_keys = ON`);
    }
    const orphanedAttendance = await request(server).get(`/api/v1/sessions/${session.body.id}/attendance`).set(dm);
    expect(orphanedAttendance.status).toBe(200);
    expect(orphanedAttendance.body).toEqual([
      expect.objectContaining({ characterId: character.body.id, characterName: 'Aria Before' }),
    ]);
  });

  it('setting attendance again replaces the set (not additive)', async () => {
    const server = ctx.app.getHttpServer();

    const put = await request(server).put(`/api/v1/sessions/${sessionId}/attendance`).set(dm).send({ characterIds: [charC] });
    expect(put.status).toBe(200);
    expect(put.body.map((r: { characterId: number }) => r.characterId)).toEqual([charC]);

    const get = await request(server).get(`/api/v1/sessions/${sessionId}/attendance`).set(dm);
    expect(get.body.map((r: { characterId: number }) => r.characterId)).toEqual([charC]);
  });

  it('an empty array clears attendance', async () => {
    const server = ctx.app.getHttpServer();
    const put = await request(server).put(`/api/v1/sessions/${sessionId}/attendance`).set(dm).send({ characterIds: [] });
    expect(put.status).toBe(200);
    expect(put.body).toEqual([]);
  });

  it('only characters in the session\'s own campaign are valid attendees (400 otherwise)', async () => {
    const server = ctx.app.getHttpServer();

    // A character in a DIFFERENT campaign must not be recordable as an attendee here.
    const otherCamp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Other Table' });
    const outsider = await request(server).post(`/api/v1/campaigns/${otherCamp.body.id}/characters`).set(dm).send({ name: 'Outsider' });

    const bad = await request(server).put(`/api/v1/sessions/${sessionId}/attendance`).set(dm).send({ characterIds: [charA, outsider.body.id] });
    expect(bad.status).toBe(400);

    // A non-existent character id is likewise rejected.
    const missing = await request(server).put(`/api/v1/sessions/${sessionId}/attendance`).set(dm).send({ characterIds: [999999] });
    expect(missing.status).toBe(400);

    // The rejected write left attendance untouched (still cleared from the prior test).
    const get = await request(server).get(`/api/v1/sessions/${sessionId}/attendance`).set(dm);
    expect(get.body).toEqual([]);
  });

  it('a player may read attendance but not set it (dm-only write)', async () => {
    const server = ctx.app.getHttpServer();

    await request(server).put(`/api/v1/sessions/${sessionId}/attendance`).set(dm).send({ characterIds: [charA] });

    const playerGet = await request(server).get(`/api/v1/sessions/${sessionId}/attendance`).set(player);
    expect(playerGet.status).toBe(200);
    expect(playerGet.body.map((r: { characterId: number }) => r.characterId)).toEqual([charA]);

    const playerPut = await request(server).put(`/api/v1/sessions/${sessionId}/attendance`).set(player).send({ characterIds: [charB] });
    expect(playerPut.status).toBe(403);
  });

  it('attendance on an unknown session 404s', async () => {
    const server = ctx.app.getHttpServer();
    const res = await request(server).get(`/api/v1/sessions/999999/attendance`).set(dm);
    expect(res.status).toBe(404);
  });

  it('deleting a session drops its attendance rows', async () => {
    const server = ctx.app.getHttpServer();

    const s = await request(server).post(`/api/v1/campaigns/${campaignId}/sessions`).set(dm).send({ number: 2, title: 'Doomed' });
    await request(server).put(`/api/v1/sessions/${s.body.id}/attendance`).set(dm).send({ characterIds: [charA, charB] });

    const del = await request(server).delete(`/api/v1/sessions/${s.body.id}`).set(dm);
    expect(del.status).toBe(200);

    // The session is gone, so its attendance endpoint 404s (rows were cleaned up).
    const get = await request(server).get(`/api/v1/sessions/${s.body.id}/attendance`).set(dm);
    expect(get.status).toBe(404);
  });
});
