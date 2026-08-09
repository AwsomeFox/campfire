import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { campaignLibraryBulkOperations, inventoryItems } from '../../db/schema';
import type { DrizzleDb } from '../../db/db.module';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * Invalidate a campaign's SERVER-DERIVED equipped actions (issue #2097).
 *
 * A derived action encodes the rule system it was computed under, and
 * `ActionResolverService` resolves whatever is stored against the campaign's CURRENT adapter
 * — so anything that changes a campaign's mechanics has to drop them, or 5e numbers keep
 * being rolled under the new system.
 *
 * This lives here, taking a transaction, rather than as a private method on whichever service
 * happened to need it first. Review (chatgpt-codex-connector P1) found `campaigns.ruleSystem`
 * being written from three places — `CampaignsService.update`, the admin catalog's
 * `update_module`, and `RulesService.uninstall`'s dormant-slug reset — of which only the
 * first ran any cleanup. A shared function inside the caller's own transaction is what makes
 * "every writer invalidates" checkable by grep instead of by memory.
 *
 * Only `derived` rows are touched. A `manual` action is a human's, and whether it still
 * applies under new mechanics is their call. The equip state is untouched too: the sword is
 * still worn, it just grants nothing until re-equipped.
 *
 * Returns the affected character ids so a caller with a live-events channel can invalidate
 * open encounter screens. Callers operating on trashed campaigns have no screens to tell.
 */
export function clearDerivedEquippedActionsIn(tx: Tx, campaignId: number, now: string): number[] {
  const derivedInCampaign = and(eq(inventoryItems.campaignId, campaignId), eq(inventoryItems.equippedActionSource, 'derived'));

  const affected = tx.select({ characterId: inventoryItems.characterId }).from(inventoryItems).where(derivedInCampaign).all();

  if (affected.length > 0) {
    // LIVE rows advance `updatedAt`: their granted action genuinely changed, and readers key
    // cache freshness off it.
    tx.update(inventoryItems)
      .set({ equippedAction: null, equippedActionSource: null, updatedAt: now })
      .where(and(derivedInCampaign, isNull(inventoryItems.deletedAt)))
      .run();
    // TOMBSTONES deliberately do NOT. `CampaignLibraryService.undoBulk()` fences on a
    // tombstone's `updatedAt` still matching the version its journal recorded, so bumping it
    // made undoing an archive fail after a mechanics change — even though this same
    // transaction scrubs the journal and the restore would be safe.
    tx.update(inventoryItems)
      .set({ equippedAction: null, equippedActionSource: null })
      .where(and(derivedInCampaign, isNotNull(inventoryItems.deletedAt)))
      .run();
  }

  // …and the UNDO JOURNALS, which hold their own copies. A bulk operation's `beforeJson`
  // keeps the pre-operation action indefinitely and undo restores it verbatim, so a journal
  // written before a system switch would put the old mechanics back the moment anyone undid
  // an unrelated bulk operation.
  //
  // Deliberately NOT behind the `affected.length` check above: the dangerous case is exactly
  // the one where no live row matches, because a bulk move already cleared the live action
  // while its journal kept the copy.
  for (const journal of tx
    .select({ id: campaignLibraryBulkOperations.id, beforeJson: campaignLibraryBulkOperations.beforeJson })
    .from(campaignLibraryBulkOperations)
    .where(eq(campaignLibraryBulkOperations.campaignId, campaignId))
    .all()) {
    const scrubbed = scrubDerivedActionsFromJournal(journal.beforeJson);
    if (scrubbed !== null) {
      tx.update(campaignLibraryBulkOperations)
        .set({ beforeJson: scrubbed, inverseJson: scrubbed })
        .where(eq(campaignLibraryBulkOperations.id, journal.id))
        .run();
    }
  }

  return [...new Set(affected.map((row) => row.characterId).filter((cid): cid is number => cid != null))];
}

/**
 * Null out every `derived` equipped action recorded in a bulk-operation journal, returning the
 * rewritten JSON — or null when nothing needed changing, so the caller can skip the write.
 *
 * Structure-agnostic on purpose: the journal is a heterogeneous record of whatever the
 * operation touched, and this only cares about the `equippedAction`/`equippedActionSource`
 * pair wherever it appears. A `manual` action — or one with no provenance, which predates
 * migration 0177 and was therefore hand-authored — is left exactly as recorded.
 */
export function scrubDerivedActionsFromJournal(beforeJson: string | null): string | null {
  if (!beforeJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(beforeJson);
  } catch {
    return null;
  }
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const record = { ...(node as Record<string, unknown>) };
    if (record.equippedActionSource === 'derived') {
      record.equippedAction = null;
      record.equippedActionSource = null;
      changed = true;
    }
    for (const key of Object.keys(record)) record[key] = walk(record[key]);
    return record;
  };
  const next = walk(parsed);
  return changed ? JSON.stringify(next) : null;
}
