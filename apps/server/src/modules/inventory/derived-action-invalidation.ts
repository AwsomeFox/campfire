import { and, eq, inArray, isNull } from 'drizzle-orm';
import { inventoryItems } from '../../db/schema';
import type { DrizzleDb } from '../../db/db.module';

/**
 * Characters whose DERIVED equipped actions a campaign-wide mechanics change would alter
 * (issue #2097 review: chatgpt-codex-connector P2).
 *
 * A derived action is computed on read, so a rule-system or homebrew-profile switch changes
 * what every equipped weapon does the instant it commits — no rows need touching. But the web
 * client is not polling: `RunSessionPage` refreshes its merged-action and turn caches only on
 * `character.updated`, so an already-open encounter card goes on offering the previous
 * system's attack until someone reloads, and resolving it then fails the expected-spec check.
 * Read-time derivation removed the invalidation *work*; it did not remove the need to announce.
 *
 * A shared function rather than a private method on whichever service needed it first, for the
 * reason an earlier review found: `campaigns.ruleSystem` is written from more than one place
 * (`CampaignsService.update` and the admin catalog's `update_module`), and only one of them
 * used to invalidate. One function is what makes "every writer announces" checkable by grep
 * instead of by memory.
 *
 * Only items with NO stored action are counted: a stored action is a human's, it is returned
 * verbatim, and a mechanics change does not alter it. Trashed items are excluded — they grant
 * nothing to invalidate.
 *
 * The SQL null test is deliberately narrower than the read path's, which also treats a stored
 * action carrying no mechanics as absent (issue #2144) and so derives over it. Such a row can
 * only predate that fix — no write creates one now, and the next PATCH of the item clears it —
 * and the cost of missing it here is one stale open encounter card until a reload, which is
 * not worth a JSON predicate in a hot query.
 */
export function charactersWithDerivedActions(db: Pick<DrizzleDb, 'select'>, campaignId: number): number[] {
  const rows = db
    .select({ characterId: inventoryItems.characterId })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.campaignId, campaignId),
        eq(inventoryItems.ownerType, 'character'),
        eq(inventoryItems.equipped, true),
        isNull(inventoryItems.equippedAction),
        isNull(inventoryItems.deletedAt),
      ),
    )
    .all();
  return [...new Set(rows.map((row) => row.characterId).filter((id): id is number => id != null))];
}

/**
 * Campaign/character pairs whose derived actions a change to these LIVE rule entries would
 * alter (issue #2097 review: chatgpt-codex-connector P2).
 *
 * Narrower than the campaign-wide sweep above, and for a different writer: `RulesService`
 * rewrites `dataJson` in place (homebrew edits, pack re-syncs), which only reaches items that
 * derive from the live entry — i.e. legacy items holding a `ruleEntryId` with no accepted
 * compendium snapshot. An item WITH a snapshot is unaffected until someone explicitly accepts
 * a refresh, which is the whole point of the snapshot and is announced on its own path.
 *
 * Cross-campaign by nature: a shared pack's entry is referenced from every campaign that
 * acquired from it, so the result carries the campaign id with each character rather than
 * assuming one.
 */
export function charactersDerivingFromEntries(
  db: Pick<DrizzleDb, 'select'>,
  ruleEntryIds: readonly number[],
): Array<{ campaignId: number; characterId: number }> {
  if (ruleEntryIds.length === 0) return [];
  const rows = db
    .select({ campaignId: inventoryItems.campaignId, characterId: inventoryItems.characterId })
    .from(inventoryItems)
    .where(
      and(
        inArray(inventoryItems.ruleEntryId, [...new Set(ruleEntryIds)]),
        isNull(inventoryItems.compendiumSnapshot),
        eq(inventoryItems.ownerType, 'character'),
        eq(inventoryItems.equipped, true),
        isNull(inventoryItems.equippedAction),
        isNull(inventoryItems.deletedAt),
      ),
    )
    .all();
  const seen = new Set<string>();
  const out: Array<{ campaignId: number; characterId: number }> = [];
  for (const row of rows) {
    if (row.characterId == null) continue;
    const key = `${row.campaignId}:${row.characterId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ campaignId: row.campaignId, characterId: row.characterId });
  }
  return out;
}
