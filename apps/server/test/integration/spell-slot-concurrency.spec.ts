import fs, { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { nextUpdatedAt } from '../../src/common/stale-write';
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

  /**
   * Issue #1902 rework, round 6 — the LOAD-BEARING fix this round, and per its own
   * review comment "invisible in normal use and will regress silently" if left
   * uncovered. `patchSpellSlots` used to stamp its write with `nowIso()`
   * (`new Date().toISOString()`). Two writes landing inside the SAME millisecond can
   * therefore produce the IDENTICAL ISO string — a real write happens, but the character
   * row's `updatedAt` (the CAS token every `expectedUpdatedAt` check above compares
   * against) never visibly moves. A caller who read the sheet BEFORE that write would
   * then present the OLD token, find it still matches the (unmoved) stored value, and
   * have its stale delta silently applied on top of state it never saw — exactly the
   * defect `expectedUpdatedAt` exists to prevent, defeated by the token itself failing to
   * advance. `nextUpdatedAt` guarantees monotonic advancement even inside one
   * millisecond; this test freezes the clock to reproduce the collision deterministically
   * rather than relying on real-clock timing luck (which would make this pass or fail
   * depending on machine speed).
   */
  it('#1902 rework: nextUpdatedAt keeps the CAS token monotonic even when two writes land in the exact same millisecond', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const id = seed(orm, 4);

    const frozen = new Date('2026-01-01T00:00:00.000Z');
    jest.useFakeTimers({ advanceTimers: false });
    jest.setSystemTime(frozen);
    try {
      // Force the character's stored `updatedAt` to match the frozen instant EXACTLY —
      // this is the precondition the reviewer described ("two character writes occur
      // within the same millisecond").
      orm.update(characters).set({ updatedAt: frozen.toISOString() }).where(eq(characters.id, id)).run();
      const before = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all()[0];
      expect(before.updatedAt).toBe(frozen.toISOString());

      // Write X: some other actor spends a slot, unconditionally (no expectedUpdatedAt).
      // The clock has not advanced by even one tick.
      await service.patchSpellSlots(id, { level: 1, delta: 1 }, dmUser, 'dm');
      const afterWriteX = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all()[0];

      // The defect this guards against: with the old `nowIso()` write, `afterWriteX`'s
      // token would be IDENTICAL to `before`'s — a real write happened, but the CAS
      // token never moved, so the compare-and-set below would incorrectly pass.
      expect(afterWriteX.updatedAt).not.toBe(before.updatedAt);

      // A caller who read the sheet BEFORE Write X (holding `before.updatedAt`) must now
      // be correctly rejected as stale — the token DID advance despite the frozen clock,
      // so the CAS guard actually protects against Write X rather than looking like it
      // did while rejecting nothing.
      await expect(
        service.patchSpellSlots(id, { level: 1, delta: 1, expectedUpdatedAt: before.updatedAt }, dmUser, 'dm'),
      ).rejects.toMatchObject({ status: 409 });
      // The rejected write applied nothing — still 1 (Write X's spend), not 2.
      expect(usedAt(orm, id)).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * Issue #1902 rework, round 9 (Devin) — `updatedAt` is a ROW-LEVEL compare-and-set
   * token: `patchSpellSlots`'s `expectedUpdatedAt` guard is only as sound as every OTHER
   * writer of that same row keeping the SAME monotonic-advancement promise. This test
   * exercises two representative non-spell-slot writers — the general PATCH (`update`)
   * and `patchHp` — under a frozen clock, proving the round-9 sweep (every `characters`
   * row writer now uses `nextUpdatedAt`, not `nowIso()`) actually closed the gap network-
   * wide rather than just for spell slots.
   */
  it('#1902 rework: non-spell-slot writers (update, patchHp) also advance the CAS token under a frozen clock', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const id = seed(orm, 4);

    const frozen = new Date('2026-01-01T00:00:00.000Z');
    jest.useFakeTimers({ advanceTimers: false });
    jest.setSystemTime(frozen);
    try {
      orm.update(characters).set({ updatedAt: frozen.toISOString() }).where(eq(characters.id, id)).run();
      const beforeUpdate = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all()[0];
      expect(beforeUpdate.updatedAt).toBe(frozen.toISOString());

      // The general PATCH (`update`) — still frozen at the exact same instant.
      await service.update(id, { name: 'Renamed mid-freeze' }, dmUser, 'dm');
      const afterUpdate = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all()[0];
      expect(afterUpdate.updatedAt).not.toBe(beforeUpdate.updatedAt);

      // patchHp, immediately after, still inside the same frozen millisecond — its own
      // write must advance AGAIN relative to what `update` just produced.
      await service.patchHp(id, { set: 3 }, dmUser, 'dm');
      const afterHp = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all()[0];
      expect(afterHp.updatedAt).not.toBe(afterUpdate.updatedAt);
      expect(afterHp.hpCurrent).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * Issue #1902 rework, round 12 (codex P2) — round 9's sweep made `update()` STAMP its
   * write with `nextUpdatedAt`, but the ROOT it advanced from (`existing.updatedAt`) was
   * still captured before this method's own awaited `assertProgressionAllowed` /
   * `adapterForCampaign` checks (only reached when the PATCH touches `xp`/`level`). If a
   * DIFFERENT, CAS-protected writer (e.g. `patchSpellSlots`) commits in that gap,
   * `existing.updatedAt` is now stale relative to the row — and because `nextUpdatedAt` is
   * a PURE function of its input token and the current instant, `update()`'s own write,
   * still computed from that stale root, can publish the IDENTICAL token the concurrent
   * writer already produced (rather than one strictly after it) when both land in the same
   * millisecond. A client holding that colliding token as a LATER `expectedUpdatedAt` would
   * incorrectly read it as "still current" even though `update()`'s own fields are newer.
   * Fixed by re-reading the row's actual current `updatedAt` immediately before the write.
   * `levelUp` had the identical structural defect (its own awaited progression/adapter
   * checks before computing the token) and received the same fix.
   */
  it('#1902 rework (round 12): update() re-reads the token instead of publishing one that collides with a concurrent writer', async () => {
    dataDir = makeTempDataDir();
    const { orm, service } = build();
    const id = seed(orm, 4);

    const frozen = new Date('2026-02-02T00:00:00.000Z');
    jest.useFakeTimers({ advanceTimers: false });
    jest.setSystemTime(frozen);
    // Spy on the awaited progression check `update()` only reaches when the PATCH touches
    // xp/level — the exact seam a concurrent writer's commit needs to land in for this bug
    // to manifest. The mock performs a raw, synchronous write standing in for that
    // concurrent commit (this suite's own established technique — see the class doc
    // comment above — for a deterministic stand-in rather than a real, unreliable race).
    const spy = jest
      .spyOn(service as unknown as { assertProgressionAllowed: (...args: unknown[]) => Promise<void> }, 'assertProgressionAllowed')
      .mockImplementation(async () => {
        const current = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all()[0];
        orm.update(characters).set({ updatedAt: nextUpdatedAt(current.updatedAt) }).where(eq(characters.id, id)).run();
      });
    try {
      orm.update(characters).set({ updatedAt: frozen.toISOString() }).where(eq(characters.id, id)).run();
      const before = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all()[0];
      expect(before.updatedAt).toBe(frozen.toISOString());

      // `xp` alone (no `level`) is enough to reach the awaited progression check.
      await service.update(id, { xp: 100 }, dmUser, 'dm');

      // What the concurrent writer (the spy) actually produced.
      const concurrentWriterToken = nextUpdatedAt(before.updatedAt);
      const after = orm.select().from(characters).where(eq(characters.id, id)).limit(1).all()[0];
      // The defect this guards against: `update()`'s own write, computed from the STALE
      // pre-await `existing.updatedAt`, would ALSO evaluate to `nextUpdatedAt(before.updatedAt)`
      // under a frozen clock — the IDENTICAL token the concurrent writer already produced —
      // silently colliding rather than advancing past it.
      expect(after.updatedAt).not.toBe(concurrentWriterToken);
      expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(concurrentWriterToken));
      expect(after.xp).toBe(100);
    } finally {
      jest.useRealTimers();
      spy.mockRestore();
    }
  });

  /**
   * Issue #1902 rework, round 13 (codex P2) — both `breakConcentration` mirrors (one in
   * `action-resolver.service.ts`, one in `encounters.service.ts`; they cascade a broken
   * concentrator's dependent conditions onto every affected combatant, mirroring the
   * linked sheet for each) stamped the sheet write with ONE SHARED `now = nowIso()` for
   * every affected character — the same class of bug fixed for `restParty`/
   * `applyPartyRecovery`/`awardXp`: a shared, non-monotonic timestamp for a multi-row
   * write can coincide with (or roll BACKWARD relative to) a concurrent CAS-protected
   * writer's own token. Fixed by reading each character's OWN current `updatedAt` inside
   * the same transaction and keying `nextUpdatedAt` off that, per character, matching
   * every other multi-row `characters` writer in this rework.
   *
   * This is a source-shape check, not a full behavioral harness — driving
   * `cascadeConcentrationLoss` end-to-end needs a running encounter with a concentrating
   * caster and a dependent condition on another combatant, which is already covered
   * functionally by `test/integration/action-resolver.spec.ts` and
   * `test/integration/encounter-condition-concurrency.spec.ts` (both pass unchanged: the
   * fix only changes the TOKEN value written, never any other field). This test pins the
   * specific defect class those functional tests cannot see — a same-millisecond
   * collision — the same way `condition-columns-single-writer.spec.ts` mechanically
   * enforces its own invariant rather than relying on incidental behavioral coverage.
   */
  it('#1902 rework (round 13): both breakConcentration sheet mirrors advance the CAS token per-character, not from one shared stamp', () => {
    const actionResolverSrc = readFileSync(resolve(__dirname, '../../src/modules/encounters/action-resolver.service.ts'), 'utf8');
    const encountersSrc = readFileSync(resolve(__dirname, '../../src/modules/encounters/encounters.service.ts'), 'utf8');
    for (const src of [actionResolverSrc, encountersSrc]) {
      // Reads the row fresh, inside the same transaction, right before using it —
      // not a pre-loop snapshot shared across every affected character.
      expect(src).toMatch(/const currentChar = tx\.select\(\{ updatedAt: characters\.updatedAt \}\)\.from\(characters\)\.where\(eq\(characters\.id, row\.characterId\)\)\.get\(\);/);
      expect(src).toMatch(/updatedAt: nextUpdatedAt\(currentChar\?\.updatedAt \?\? now\)/);
    }
  });
});
