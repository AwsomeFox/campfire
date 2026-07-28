import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { playRooms, playVenues } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { OrganizedPlayService } from '../../src/modules/sessions/organized-play.service';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #1638, service layer: `createRoom`/`updateRoom` each run a sibling-name clash
 * SELECT before their write, but that SELECT is outside any transaction. Two concurrent
 * callers can both pass the check before either writes, and the second write then hits
 * the raw `UNIQUE(venue_id, name)` index on `play_rooms`.
 *
 * WHY THIS IS NOT AN HTTP E2E TEST. supertest serialises on a single agent and
 * better-sqlite3 is synchronous, so two `.post()` calls never actually interleave — a
 * test written that way would pass whether or not the race exists (the same trap
 * documented on #1586/#1588's service-layer specs). This drives `OrganizedPlayService`
 * directly against a real SQLite file and fires both writes BEFORE awaiting either, so
 * the two `await`s inside `assertRoomNameAvailable`/the INSERT genuinely interleave.
 *
 * This is deliberately NOT the #1588 data-loss family: both rows in a race are still
 * correct afterwards and the UNIQUE index still holds. What #1638 asks for is that the
 * LOSING caller gets the same clean 400 `assertRoomNameAvailable` produces in the
 * non-racing case, not a raw SQLITE_CONSTRAINT_UNIQUE error surfacing as a 500 — i.e.
 * `runRoomWrite`'s catch-and-translate backstop is what these specs are asserting.
 */
describe('OrganizedPlayService room name clash — concurrent write race (#1638, real SQLite)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function build() {
    dataDir = makeTempDataDir();
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    // createRoom/updateRoom never touch notifications or roles — stubbed, unused.
    const service = new OrganizedPlayService(orm, audit, events, {} as any, {} as any);
    return { orm, service };
  }

  const admin: RequestUser = { id: 'dev:admin', name: 'Admin', serverRole: 'admin', devRole: 'dm' };

  function seedVenue(orm: ReturnType<typeof build>['orm']): number {
    const ts = '2026-07-27T00:00:00.000Z';
    const [row] = orm
      .insert(playVenues)
      .values({ name: 'The Guildhall', timezone: 'UTC', createdAt: ts, updatedAt: ts })
      .returning().all();
    return row.id;
  }

  function seedRoom(orm: ReturnType<typeof build>['orm'], venueId: number, name: string): number {
    const ts = '2026-07-27T00:00:00.000Z';
    const [row] = orm
      .insert(playRooms)
      .values({ venueId, name, createdAt: ts, updatedAt: ts })
      .returning().all();
    return row.id;
  }

  it('two concurrent createRoom calls racing the same sibling name: one succeeds, the loser gets a clean 400 (not a raw constraint error)', async () => {
    const { orm, service } = build();
    const venueId = seedVenue(orm);

    const a = service.createRoom(venueId, { name: 'Table 1' } as any, admin);
    const b = service.createRoom(venueId, { name: 'Table 1' } as any, admin);
    const results = await Promise.allSettled([a, b]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err?.constructor?.name).toBe('BadRequestException');
    expect(err?.message).toContain('already has a room named "Table 1"');
    // Not a raw better-sqlite3 constraint error leaking past the translation.
    expect(err?.message).not.toMatch(/SQLITE_CONSTRAINT|UNIQUE constraint failed/i);

    const rows = orm.select().from(playRooms).where(eq(playRooms.venueId, venueId)).all();
    expect(rows).toHaveLength(1);
  });

  it('two concurrent updateRoom calls racing onto the same sibling name: one succeeds, the loser gets a clean 400', async () => {
    const { orm, service } = build();
    const venueId = seedVenue(orm);
    seedRoom(orm, venueId, 'Table 1');
    const roomBId = seedRoom(orm, venueId, 'Table 2');
    const roomCId = seedRoom(orm, venueId, 'Table 3');

    // Both B and C try to rename onto the same NEW sibling name simultaneously.
    const a = service.updateRoom(roomBId, { name: 'Table Prime' } as any, admin);
    const b = service.updateRoom(roomCId, { name: 'Table Prime' } as any, admin);
    const results = await Promise.allSettled([a, b]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err?.constructor?.name).toBe('BadRequestException');
    expect(err?.message).toContain('already has a room named "Table Prime"');
    expect(err?.message).not.toMatch(/SQLITE_CONSTRAINT|UNIQUE constraint failed/i);

    const primeRows = orm.select().from(playRooms).all().filter((r: any) => r.name === 'Table Prime');
    expect(primeRows).toHaveLength(1);
  });

  it('createRoom against different venues never clashes (sanity: the constraint is venue-scoped)', async () => {
    const { orm, service } = build();
    const venueId1 = seedVenue(orm);
    const ts = '2026-07-27T00:00:00.000Z';
    const [venue2] = orm.insert(playVenues).values({ name: 'The Other Hall', timezone: 'UTC', createdAt: ts, updatedAt: ts }).returning().all();

    const a = service.createRoom(venueId1, { name: 'Table 1' } as any, admin);
    const b = service.createRoom(venue2.id, { name: 'Table 1' } as any, admin);
    const results = await Promise.allSettled([a, b]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });
});
