import { isNull, type Column, type SQL } from 'drizzle-orm';

/**
 * Soft-delete / trash convention (issue #116).
 *
 * The trashable entities (campaigns, quests, npcs, locations, sessions, notes,
 * characters) carry a nullable `deleted_at` column: NULL means live, a timestamp
 * means the row is in the trash — kept on disk + restorable for a grace period,
 * but excluded from every NORMAL read. Rather than bespoke logic per entity, each
 * service composes this single predicate into its list/get WHERE clauses:
 *
 *   .where(and(eq(quests.campaignId, id), notDeleted(quests.deletedAt)))
 *
 * The inverse (a Trash view) filters on `deleted_at IS NOT NULL` directly, and
 * restore/purge paths deliberately read WITHOUT this predicate so they can find a
 * trashed row the normal reads hide.
 */
export function notDeleted(deletedAtColumn: Column): SQL {
  return isNull(deletedAtColumn);
}
