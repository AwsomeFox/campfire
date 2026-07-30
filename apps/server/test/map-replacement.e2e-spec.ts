import request from 'supertest';
import type { Server } from 'node:http';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { locations, encounters, combatants } from '../src/db/schema';
import { eq } from 'drizzle-orm';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

/**
 * Smallest real PNG payload (1x1, 8-bit RGB). Uploads are validated against the image
 * header, so the fixture must actually decode.
 */
const MINIMAL_PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
  'hex',
);

describe('map replacement lifecycle (issue #870)', () => {
  let ctx: TestAppContext;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Map Lifecycle' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function uploadMap(server: Server, fileName: string): Promise<number> {
    const res = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/attachments`)
      .set(dm)
      .field('kind', 'map')
      .attach('file', MINIMAL_PNG_1X1, fileName);
    expect(res.status).toBe(201);
    return res.body.id;
  }

  describe('campaign region map', () => {
    it('preserves location pins by default when replacing the map', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const mapA = await uploadMap(server, 'a.png');

      await request(server)
        .patch(`/api/v1/campaigns/${campaignId}`)
        .set(dm)
        .send({ mapAttachmentId: mapA })
        .expect(200);

      const [loc] = await db
        .insert(locations)
        .values({
          campaignId,
          name: 'Pin Keep',
          kind: 'point',
          status: 'unexplored',
          mapX: 25,
          mapY: 50,
          body: '',
          dmSecret: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();

      const mapB = await uploadMap(server, 'b.png');
      const replace = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}`)
        .set(dm)
        .send({ mapAttachmentId: mapB });
      expect(replace.status).toBe(200);

      const kept = await db.select().from(locations).where(eq(locations.id, loc.id)).limit(1);
      expect(kept[0]?.mapX).toBe(25);
      expect(kept[0]?.mapY).toBe(50);
    });

    it('resets location pins when mapAlignment is reset', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const mapA = await uploadMap(server, 'c.png');

      await request(server)
        .patch(`/api/v1/campaigns/${campaignId}`)
        .set(dm)
        .send({ mapAttachmentId: mapA })
        .expect(200);

      const [loc] = await db
        .insert(locations)
        .values({
          campaignId,
          name: 'Pin Drop',
          kind: 'point',
          status: 'unexplored',
          mapX: 10,
          mapY: 20,
          body: '',
          dmSecret: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .returning();

      const mapB = await uploadMap(server, 'd.png');
      const replace = await request(server)
        .patch(`/api/v1/campaigns/${campaignId}`)
        .set(dm)
        .send({ mapAttachmentId: mapB, mapAlignment: 'reset' });
      expect(replace.status).toBe(200);

      const cleared = await db.select().from(locations).where(eq(locations.id, loc.id)).limit(1);
      expect(cleared[0]?.mapX).toBeNull();
      expect(cleared[0]?.mapY).toBeNull();
    });
  });

  describe('encounter battle map', () => {
    it('preserves tokens, grid, fog, and AoE by default when replacing the map', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const mapA = await uploadMap(server, 'enc-a.png');

      const encRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Battle A', hidden: false });
      expect(encRes.status).toBe(201);
      const encounterId = encRes.body.id;

      // Seed a combatant with a placed token.
      const [combatant] = await db
        .insert(combatants)
        .values({
          encounterId,
          kind: 'monster',
          name: 'Goblin',
          initiative: 10,
          hpCurrent: 10,
          hpMax: 10,
          tokenX: 30,
          tokenY: 40,
          tokenSize: 'medium',
          conditions: '[]',
        })
        .returning();

      await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({
          mapAttachmentId: mapA,
          gridSize: 5,
          gridScale: 5,
          gridUnit: 'ft',
          gridOffsetX: 1,
          gridOffsetY: 2,
          fog: { enabled: true, revealed: [{ x: 10, y: 10, w: 10, h: 10 }] },
          aoe: [{ id: 't1', shape: 'circle', x: 50, y: 50, sizeFt: 5, angleDeg: 0, color: '#fff' }],
        })
        .expect(200);

      const mapB = await uploadMap(server, 'enc-b.png');
      const replace = await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({ mapAttachmentId: mapB });
      expect(replace.status).toBe(200);

      const row = await db.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1);
      expect(row[0]?.mapAttachmentId).toBe(mapB);
      expect(row[0]?.gridSize).toBe(5);
      expect(row[0]?.gridOffsetX).toBe(1);
      expect(row[0]?.fog).not.toBeNull();
      expect(row[0]?.aoe).not.toBeNull();

      const token = await db.select().from(combatants).where(eq(combatants.id, combatant.id)).limit(1);
      expect(token[0]?.tokenX).toBe(30);
      expect(token[0]?.tokenY).toBe(40);
    });

    it('resets tokens, grid, fog, and AoE when mapAlignment is reset', async () => {
      const server = ctx.app.getHttpServer();
      const db = ctx.app.get<DrizzleDb>(DB);
      const mapA = await uploadMap(server, 'enc-c.png');

      const encRes = await request(server)
        .post(`/api/v1/campaigns/${campaignId}/encounters`)
        .set(dm)
        .send({ name: 'Battle B', hidden: false });
      expect(encRes.status).toBe(201);
      const encounterId = encRes.body.id;

      const [combatant] = await db
        .insert(combatants)
        .values({
          encounterId,
          kind: 'monster',
          name: 'Goblin',
          initiative: 10,
          hpCurrent: 10,
          hpMax: 10,
          tokenX: 30,
          tokenY: 40,
          tokenSize: 'medium',
          conditions: '[]',
        })
        .returning();

      await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({
          mapAttachmentId: mapA,
          gridSize: 5,
          gridScale: 5,
          gridUnit: 'ft',
          gridOffsetX: 1,
          gridOffsetY: 2,
          fog: { enabled: true, revealed: [{ x: 10, y: 10, w: 10, h: 10 }] },
          aoe: [{ id: 't1', shape: 'circle', x: 50, y: 50, sizeFt: 5, angleDeg: 0, color: '#fff' }],
        })
        .expect(200);

      const mapB = await uploadMap(server, 'enc-d.png');
      const replace = await request(server)
        .patch(`/api/v1/encounters/${encounterId}`)
        .set(dm)
        .send({ mapAttachmentId: mapB, mapAlignment: 'reset' });
      expect(replace.status).toBe(200);

      const row = await db.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1);
      expect(row[0]?.mapAttachmentId).toBe(mapB);
      expect(row[0]?.gridSize).toBeNull();
      expect(row[0]?.gridScale).toBeNull();
      expect(row[0]?.gridOffsetX).toBe(0);
      expect(row[0]?.gridOffsetY).toBe(0);
      expect(row[0]?.fog).toBeNull();
      expect(row[0]?.aoe).toBe('[]');

      const token = await db.select().from(combatants).where(eq(combatants.id, combatant.id)).limit(1);
      expect(token[0]?.tokenX).toBeNull();
      expect(token[0]?.tokenY).toBeNull();
    });
  });
});
