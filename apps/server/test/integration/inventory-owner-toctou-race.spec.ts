import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { ConflictException } from '@nestjs/common';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, characters, inventoryItems } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import type { RequestUser } from '../../src/common/user.types';
import type { Role } from '@campfire/schema';
import { nowIso } from '../../src/common/time';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #1901 review (chatgpt-codex-connector P1): "Revalidate the target owner before
 * displacing equipment."
 *
 * `InventoryService.update()` reads the item and runs `assertCanWriteOwner` against its
 * CURRENT owner BEFORE opening the write transaction (both are async; better-sqlite3
 * transactions must be synchronous). If a concurrent request moves the item to a DIFFERENT
 * character in that window, the authorization already performed is stale — the transaction
 * re-reads the row (`fresh`), but without a check, the slot-conflict query still used the
 * OLD owner's characterId and the final UPDATE targeted the row by id alone, so a caller
 * authorized only for character A's items could end up equipping (and displacing an incumbent
 * for) an item that fresh() shows now belongs to character B — crossing the authorization
 * boundary AGENTS.md says the server, not the client, must enforce.
 *
 * These tests simulate the interleaving deterministically by spying on `getRowOrThrow` (the
 * first read `update()` performs) and, as a side effect of THAT call, running the "concurrent"
 * move directly against the database before returning — exactly the window the review
 * describes, with no reliance on real thread/process timing.
 *
 * Round 2 (same review thread): re-checking the ITEM's owner alone isn't sufficient — a
 * non-DM caller's authorization also depends on the CHARACTER's `ownerUserId` matching them,
 * for both the character the item currently lives on and, on a move, the destination
 * character. If the DM reassigns that SAME character's owner in the same window, the item's
 * own ownerType/characterId never change, so the item-owner check alone would pass while the
 * authorization it stood on no longer holds. The tests below cover that second dimension too.
 */
describe('InventoryService.update() owner TOCTOU race (#1901 review: chatgpt-codex-connector P1)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const alice: RequestUser = { id: 'user-alice', name: 'Alice', serverRole: 'user', devRole: 'player' };
  const bob: RequestUser = { id: 'user-bob', name: 'Bob', serverRole: 'user', devRole: 'player' };
  const dm: RequestUser = { id: 'user-dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };

  function build() {
    dataDir = makeTempDataDir();
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const service = new InventoryService(orm, audit, events);
    return { orm, service };
  }

  function seed(orm: ReturnType<typeof build>['orm']) {
    const ts = nowIso();
    const [campaign] = orm.insert(campaigns).values({ name: 'TOCTOU Test', createdAt: ts, updatedAt: ts }).returning().all();
    const [characterA] = orm
      .insert(characters)
      .values({ campaignId: campaign.id, ownerUserId: alice.id, name: 'Alice PC', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [characterB] = orm
      .insert(characters)
      .values({ campaignId: campaign.id, ownerUserId: bob.id, name: 'Bob PC', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    // The item Alice is authorized to write — currently equipped nowhere, owned by A.
    const [item] = orm
      .insert(inventoryItems)
      .values({ campaignId: campaign.id, ownerType: 'character', characterId: characterA.id, name: 'Contested Blade', qty: 1, createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    // Bob's incumbent, equipped in the slot the race will target on HIS character.
    const [bobIncumbent] = orm
      .insert(inventoryItems)
      .values({
        campaignId: campaign.id,
        ownerType: 'character',
        characterId: characterB.id,
        name: "Bob's Rapier",
        qty: 1,
        equipped: true,
        equipSlot: 'main-hand',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    return { campaign, characterA, characterB, item, bobIncumbent };
  }

  /** Moves `itemId` to `characterId` directly, bypassing the service — the "concurrent writer". */
  function raceMoveItem(orm: ReturnType<typeof build>['orm'], itemId: number, characterId: number) {
    orm.update(inventoryItems).set({ characterId, updatedAt: nowIso() }).where(eq(inventoryItems.id, itemId)).run();
  }

  it('rejects rather than silently equipping/displacing on the NEW owner when the item moved mid-request', async () => {
    const { orm, service } = build();
    const { characterB, item, bobIncumbent } = seed(orm);

    const original = service.getRowOrThrow.bind(service);
    const spy = jest.spyOn(service, 'getRowOrThrow').mockImplementation(async (id: number, opts?: { includeDeleted?: boolean }) => {
      const row = await original(id, opts);
      if (id === item.id) {
        // The window: another writer moves this item to Bob's character right after
        // Alice's authorization check read it as A's, but before the transaction opens.
        raceMoveItem(orm, item.id, characterB.id);
      }
      return row;
    });

    await expect(
      service.update(
        item.id,
        { equipped: true, equipSlot: 'main-hand', displaceEquipped: true, expectedConflictingItemId: bobIncumbent.id },
        alice,
        'player',
      ),
    ).rejects.toThrow(ConflictException);

    spy.mockRestore();

    // Bob's incumbent is untouched — still equipped, still in its slot.
    const [incumbentAfter] = orm.select().from(inventoryItems).where(eq(inventoryItems.id, bobIncumbent.id)).all();
    expect(incumbentAfter.equipped).toBe(true);
    expect(incumbentAfter.equipSlot).toBe('main-hand');

    // The contested item was NOT equipped onto Bob's character.
    const [itemAfter] = orm.select().from(inventoryItems).where(eq(inventoryItems.id, item.id)).all();
    expect(itemAfter.equipped).toBe(false);
    expect(itemAfter.characterId).toBe(characterB.id); // the race's own move still happened — just never compounded
  });

  it('the same guard rejects a plain (non-displacing) equip attempt raced the same way', async () => {
    const { orm, service } = build();
    const { characterB, item } = seed(orm);

    const original = service.getRowOrThrow.bind(service);
    const spy = jest.spyOn(service, 'getRowOrThrow').mockImplementation(async (id: number, opts?: { includeDeleted?: boolean }) => {
      const row = await original(id, opts);
      if (id === item.id) raceMoveItem(orm, item.id, characterB.id);
      return row;
    });

    await expect(service.update(item.id, { equipped: true, equipSlot: 'off-hand' }, alice, 'player')).rejects.toThrow(ConflictException);

    spy.mockRestore();
    const [itemAfter] = orm.select().from(inventoryItems).where(eq(inventoryItems.id, item.id)).all();
    expect(itemAfter.equipped).toBe(false);
  });

  /** Reassigns `characterId`'s owner directly — the DM transferring a character mid-request. */
  function raceReassignCharacterOwner(orm: ReturnType<typeof build>['orm'], characterId: number, ownerUserId: string) {
    orm.update(characters).set({ ownerUserId, updatedAt: nowIso() }).where(eq(characters.id, characterId)).run();
  }

  /**
   * `assertCanWriteOwner` is private; `as any` is required to spy on it. Unlike
   * `getRowOrThrow` (called at the very top of `update()`, BEFORE either
   * `assertCanWriteOwner` call), hooking a character-reassignment race into
   * `getRowOrThrow` fires too early: `assertCanWriteOwner` would then read the
   * ALREADY-reassigned character and correctly (legitimately) reject with
   * `ForbiddenException` before the request ever reaches the transaction this PR
   * hardened — which is a real rejection, but not the TOCTOU window under test, and an
   * earlier version of these two tests made exactly that mistake (confirmed by a real CI
   * run: both failed with `ForbiddenException`, "Only dm or the owning player may manage
   * this character's items" — case (2), the test didn't reproduce the described race, not
   * case (1), a broken guard). The race must fire AFTER the real `assertCanWriteOwner`
   * call has already captured its (still-valid) decision — exactly where the review
   * describes it: "between assertCanWriteOwner and the transaction."
   */
  function raceCharacterOwnerAfterAuth(
    service: InventoryService,
    orm: ReturnType<typeof build>['orm'],
    targetCharacterId: number,
    newOwnerUserId: string,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    const original: (
      ownerType: 'party' | 'character',
      characterId: number | null,
      campaignId: number,
      u: RequestUser,
      r: Role,
    ) => Promise<unknown> = svc.assertCanWriteOwner.bind(svc);
    return jest.spyOn(svc, 'assertCanWriteOwner').mockImplementation(async (...args: unknown[]) => {
      const [ownerType, characterId, campaignId, u, r] = args as ['party' | 'character', number | null, number, RequestUser, Role];
      const result = await original(ownerType, characterId, campaignId, u, r);
      if (characterId === targetCharacterId) {
        raceReassignCharacterOwner(orm, targetCharacterId, newOwnerUserId);
      }
      return result;
    });
  }

  it('rejects a displacing equip when the SOURCE character is reassigned to a different owner mid-request (item itself never moves)', async () => {
    const { orm, service } = build();
    const { characterA, item, bobIncumbent } = seed(orm);
    // The incumbent this time lives on Alice's OWN character A, in the slot Alice is
    // equipping into — the item never changes owner, only character A's owner does.
    orm.update(inventoryItems).set({ characterId: characterA.id }).where(eq(inventoryItems.id, bobIncumbent.id)).run();

    // The window: the DM transfers character A itself to a different player right after
    // Alice's assertCanWriteOwner(characterA) authorized her against it (still A's owner
    // at that moment), but before the transaction opens.
    const spy = raceCharacterOwnerAfterAuth(service, orm, characterA.id, 'user-someone-else');

    await expect(
      service.update(
        item.id,
        { equipped: true, equipSlot: 'main-hand', displaceEquipped: true, expectedConflictingItemId: bobIncumbent.id },
        alice,
        'player',
      ),
    ).rejects.toThrow(ConflictException);

    spy.mockRestore();

    // The incumbent on (now-reassigned) character A is untouched.
    const [incumbentAfter] = orm.select().from(inventoryItems).where(eq(inventoryItems.id, bobIncumbent.id)).all();
    expect(incumbentAfter.equipped).toBe(true);
    expect(incumbentAfter.equipSlot).toBe('main-hand');
    const [itemAfter] = orm.select().from(inventoryItems).where(eq(inventoryItems.id, item.id)).all();
    expect(itemAfter.equipped).toBe(false);
  });

  it('rejects a MOVE + equip when the DESTINATION character is reassigned to a different owner mid-request', async () => {
    const { orm, service } = build();
    const ts = nowIso();
    const { campaign, characterA, item } = seed(orm);
    // Character C — also owned by Alice right now, so her destination authorization
    // (assertCanWriteOwner for the move) legitimately passes at request time.
    const [characterC] = orm
      .insert(characters)
      .values({ campaignId: campaign.id, ownerUserId: alice.id, name: 'Alice PC 2', createdAt: ts, updatedAt: ts })
      .returning()
      .all();

    // The window: the DM transfers the DESTINATION character to a different player right
    // after Alice's destination assertCanWriteOwner(characterC) passed against her own C
    // (still hers at that moment), but before the transaction opens. Racing specifically on
    // characterC's id means character A's OWN (source) authorization call is untouched —
    // only the destination check goes stale.
    const spy = raceCharacterOwnerAfterAuth(service, orm, characterC.id, 'user-someone-else');

    await expect(
      service.update(item.id, { characterId: characterC.id, equipped: true, equipSlot: 'main-hand' }, alice, 'player'),
    ).rejects.toThrow(ConflictException);

    spy.mockRestore();

    // The item never actually landed equipped on the now-reassigned character C.
    const [itemAfter] = orm.select().from(inventoryItems).where(eq(inventoryItems.id, item.id)).all();
    expect(itemAfter.equipped).toBe(false);
    expect(itemAfter.characterId).toBe(characterA.id);
  });

  /**
   * Issue #1901 review (devin-ai-integration): the item-owner guard above was scoped too
   * broadly — it fired for EVERY write, including a DM's bare qty/name/notes edit that never
   * depended on the item's owner at all (`assertCanWriteOwner` returns early for `role ===
   * 'dm'`), and a non-equip/non-move player edit that likewise doesn't feed the stale
   * `finalCharacterId` into anything security-relevant. Narrowed to fire only when
   * `equipWillChange || moved || role !== 'dm'`. These two tests cover both edges: the DM's
   * bare edit must now SUCCEED despite the concurrent move (the bug), and a PLAYER's bare edit
   * must still be REJECTED the same way (confirming the narrowing didn't overshoot and drop
   * protection for non-DM callers).
   */
  it('a DM\'s bare rename succeeds despite a concurrent move to a different character (review: devin-ai-integration)', async () => {
    const { orm, service } = build();
    const { characterB, item } = seed(orm);

    const original = service.getRowOrThrow.bind(service);
    const spy = jest.spyOn(service, 'getRowOrThrow').mockImplementation(async (id: number, opts?: { includeDeleted?: boolean }) => {
      const row = await original(id, opts);
      if (id === item.id) raceMoveItem(orm, item.id, characterB.id);
      return row;
    });

    const updated = await service.update(item.id, { name: 'Renamed Blade' }, dm, 'dm');
    spy.mockRestore();

    expect(updated.name).toBe('Renamed Blade');
  });

  it('a PLAYER\'s bare rename is still rejected when the item concurrently moved off their character', async () => {
    const { orm, service } = build();
    const { characterB, item } = seed(orm);

    const original = service.getRowOrThrow.bind(service);
    const spy = jest.spyOn(service, 'getRowOrThrow').mockImplementation(async (id: number, opts?: { includeDeleted?: boolean }) => {
      const row = await original(id, opts);
      if (id === item.id) raceMoveItem(orm, item.id, characterB.id);
      return row;
    });

    await expect(service.update(item.id, { name: 'Renamed Blade' }, alice, 'player')).rejects.toThrow(ConflictException);
    spy.mockRestore();

    const [itemAfter] = orm.select().from(inventoryItems).where(eq(inventoryItems.id, item.id)).all();
    expect(itemAfter.name).toBe('Contested Blade');
  });
});
