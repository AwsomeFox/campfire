import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, characters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { CharactersService } from '../../src/modules/characters/characters.service';
import { CampaignAccessService } from '../../src/modules/membership/campaign-access.service';
import { RoleResolver } from '../../src/modules/membership/role-resolver.service';
import { fromJsonText } from '../../src/common/json';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #1039, service layer: two spells resolving against the same character in the same
 * turn must both deduct a slot.
 *
 * WHY THIS IS NOT AN HTTP E2E TEST. supertest dispatches each request onto the Nest handler
 * and better-sqlite3 is synchronous, so two HTTP calls tend to run one-after-the-other and the
 * read-modify-write window never opens. Driving the SERVICE directly does interleave: each
 * drizzle better-sqlite3 query returns a synchronous value wrapped in a resolved promise, so
 * every `await` yields to the microtask queue and two in-flight calls swap between statements.
 * This is the same reasoning — and the same spec shape — as
 * `encounter-condition-concurrency.spec.ts` (#747), which found the identical class of bug on
 * the combatant conditions array.
 *
 * Against the pre-#1039 code the sequence was `await getRowOrThrow()` … `await db.update()`,
 * with the decision computed from the PRE-await snapshot. Two concurrent casts therefore both
 * read `used: 0`, both wrote `used: 1`, and one deduction vanished — unlimited casting arriving
 * through the back door rather than through the missing-error front door the issue describes.
 * The fix re-reads inside a synchronous `db.transaction`, which better-sqlite3 runs to
 * completion with no JS yield.
 */
describe('spell slot concurrency (real SQLite, service layer) — #1039', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    const revisions = new RevisionsService(orm, new ModerationService(orm, audit));
    const access = new CampaignAccessService(orm, new RoleResolver(orm));
    const service = new CharactersService(orm, audit, revisions, events, rolls, access);
    return { orm, service };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };

  /** A caster with `max` level-1 slots, none spent. */
  function seed(orm: ReturnType<typeof build>['orm'], max: number): number {
    const ts = '2026-07-27T00:00:00.000Z';
    orm.insert(campaigns).values({ name: 'Slots', createdAt: ts, updatedAt: ts }).run();
    const [row] = orm
      .insert(characters)
      .values({
        campaignId: 1,
        name: 'Caster',
        spellSlots: JSON.stringify({ '1': { max, used: 0 } }),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    return row.id;
  }

  function usedAt(orm: ReturnType<typeof build>['orm'], id: number): number {
    const [row] = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all();
    return fromJsonText<Record<string, { max: number; used: number }>>(row.spellSlots, {})['1']?.used ?? 0;
  }

  it('four simultaneous casts deduct four slots — none is lost', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const id = seed(orm, 4);

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => service.patchSpellSlots(id, { level: 1, delta: 1 }, dmUser, 'dm')),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    // The property the whole transaction exists for. Pre-fix this was less than 4.
    expect(usedAt(orm, id)).toBe(4);
  });

  it('the slot budget is a HARD cap under concurrency: 6 casts against 4 slots yield exactly 4', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const id = seed(orm, 4);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => service.patchSpellSlots(id, { level: 1, delta: 1 }, dmUser, 'dm')),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // Exactly the budget succeeds and the overflow FAILS — it is not clamped into a silent
    // success, which is what would let the AI narrate six spells off four slots.
    expect(fulfilled).toHaveLength(4);
    expect(rejected).toHaveLength(2);
    expect(usedAt(orm, id)).toBe(4);
    for (const r of rejected) {
      const err = (r as PromiseRejectedResult).reason as { status?: number; response?: { code?: string } };
      expect(err.status).toBe(400);
      expect(err.response?.code).toBe('insufficient_slots');
    }
  });

  it('a refused overspend writes nothing at all', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const id = seed(orm, 1);

    await service.patchSpellSlots(id, { level: 1, delta: 1 }, dmUser, 'dm');
    const before = usedAt(orm, id);
    await expect(service.patchSpellSlots(id, { level: 1, delta: 1 }, dmUser, 'dm')).rejects.toMatchObject({
      status: 400,
    });
    // The failure is thrown from inside the transaction, so the read is rolled back with it.
    expect(usedAt(orm, id)).toBe(before);
  });

  it('interleaved spends and restores compose rather than clobbering each other', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const id = seed(orm, 4);
    await service.patchSpellSlots(id, { level: 1, delta: 2 }, dmUser, 'dm'); // used = 2

    await Promise.allSettled([
      service.patchSpellSlots(id, { level: 1, delta: 1 }, dmUser, 'dm'),
      service.patchSpellSlots(id, { level: 1, delta: -1 }, dmUser, 'dm'),
    ]);

    // +1 and -1 against used=2 must net to 2 in either order. A stale-snapshot write would
    // land on 1 or 3 depending on which call happened to finish last.
    expect(usedAt(orm, id)).toBe(2);
  });

  /**
   * Issue #1902 rework, third review pass on the SAME defect the tests above already
   * cover from the "two of MY OWN requests at once" angle: `delta` is meaningless without
   * knowing what it's relative to, and neither the transaction's synchronous re-read NOR
   * the web panel's round-1 cache-reconciliation fix protects a caller who computed its
   * delta from a render that is now stale because a DIFFERENT actor wrote to the sheet in
   * between — two SEQUENTIAL, non-overlapping calls (no interleaving needed to reproduce
   * this one). `expectedUpdatedAt` (`ResourceTrackerPanel`'s `spellSlotPatchBody`, wired
   * through `patchSpellSlots` -> `RevisionsService.assertNotStale`) is the fix: a stale
   * token is rejected with 409 instead of the delta being silently applied on top of state
   * the caller never saw.
   */
  it('expectedUpdatedAt rejects a spend whose token is stale — the real fix behind the "renders 1, commits 2" defect', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const id = seed(orm, 4);
    const staleToken = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all()[0].updatedAt;

    // A concurrent actor spends a slot — used: 0 -> 1 — and the character row's
    // `updatedAt` moves. `staleToken` above is now stale.
    await service.patchSpellSlots(id, { level: 1, delta: 1 }, dmUser, 'dm');
    expect(usedAt(orm, id)).toBe(1);

    // A caller who rendered BEFORE that write (and so still holds `staleToken`) tries to
    // spend what it believes is the FIRST slot. Without the CAS check this delta would
    // land on top of the fresh `used: 1`, silently becoming a second, unintended spend.
    let caught: { status?: number; response?: { code?: string } } | undefined;
    try {
      await service.patchSpellSlots(id, { level: 1, delta: 1, expectedUpdatedAt: staleToken }, dmUser, 'dm');
    } catch (err) {
      caught = err as typeof caught;
    }
    expect(caught?.status).toBe(409);
    expect(caught?.response?.code).toBe('STALE_WRITE');
    // The rejected write applied NOTHING — still 1, not 2.
    expect(usedAt(orm, id)).toBe(1);
  });

  it('expectedUpdatedAt succeeds against a fresh token, and omitting it stays unconditional (every other caller unaffected)', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const id = seed(orm, 4);
    const freshToken = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all()[0].updatedAt;

    await service.patchSpellSlots(id, { level: 1, delta: 1, expectedUpdatedAt: freshToken }, dmUser, 'dm');
    expect(usedAt(orm, id)).toBe(1);

    // Omitted => unconditional write, exactly like the AI DM / MCP tools and every other
    // existing caller of this contract that never opts into the CAS token.
    await service.patchSpellSlots(id, { level: 1, delta: 1 }, dmUser, 'dm');
    expect(usedAt(orm, id)).toBe(2);
  });
});
