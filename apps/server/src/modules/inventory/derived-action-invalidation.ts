import { and, eq, isNull } from 'drizzle-orm';
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
