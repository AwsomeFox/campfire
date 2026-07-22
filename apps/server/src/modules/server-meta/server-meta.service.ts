import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { ServerInstance } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { SERVER_META_KEY, serverMeta } from '../../db/schema';
import { nowIso } from '../../common/time';

/**
 * Owns the single-row `server_meta` row that carries this install's data
 * identity (issue #723): a stable per-install UUID plus a monotonic
 * `data_generation` that is bumped on every whole-server restore.
 *
 *   - `instanceId` is generated ONCE (lazily, on the first read of a fresh row)
 *     and then never changes for the life of the install. Because it lives
 *     INSIDE the SQLite DB that a backup/restore swaps in wholesale, the same
 *     physical box keeps its UUID across restores — which is correct: the UUID
 *     distinguishes physically distinct installs (two homelabs, dev vs prod),
 *     not "before vs after a restore on the same box".
 *   - `dataGeneration` is the actual "the bytes under these IDs have changed"
 *     signal. {@link bumpGeneration} increments it atomically, and
 *     {@link BackupService} calls that AFTER the restored DB is reopened so the
 *     bump lands on the NEW DB (not the pre-restore one we're about to discard).
 *
 * Both values ride on `/me` (Me.instance) via AuthService.buildMe so the web
 * client can namespace its SW runtime cache by `${instanceId}:${dataGeneration}`
 * and notice the change on the first proven-live /me after a restore.
 *
 * Concurrency: getOrCreateRow() is the only writer for the seed case and runs a
 * single INSERT ... ON CONFLICT DO NOTHING, so two simultaneous first-time
 * callers can't corrupt the row; bumpGeneration() uses UPDATE ... SET
 * data_generation = data_generation + 1 so concurrent bumps still advance
 * monotonically. SQLite serializes both under its per-database write lock.
 */
@Injectable()
export class ServerMetaService {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  /**
   * Return the singleton row, seeding it (instanceId + generation=0) on the
   * first ever call. Idempotent: a parallel seed resolves to one row via
   * INSERT ... ON CONFLICT DO NOTHING. Always reflects the CURRENT DB — so
   * after BackupService reopens the restored DB this returns that DB's row
   * (seeding it fresh if the restored archive predates the server_meta table).
   */
  private async getOrCreateRow(): Promise<{ instanceId: string; dataGeneration: number }> {
    const [existing] = await this.db
      .select()
      .from(serverMeta)
      .where(eq(serverMeta.key, SERVER_META_KEY))
      .limit(1);
    if (existing) {
      return { instanceId: existing.instanceId, dataGeneration: existing.dataGeneration };
    }
    // Seed. ON CONFLICT DO NOTHING makes a concurrent seed a no-op rather than
    // a unique-violation; re-read afterward so both callers agree on the row.
    const ts = nowIso();
    const instanceId = randomUUID();
    await this.db
      .insert(serverMeta)
      .values({
        key: SERVER_META_KEY,
        instanceId,
        dataGeneration: 0,
        updatedAt: ts,
      })
      .onConflictDoNothing();
    const [row] = await this.db
      .select()
      .from(serverMeta)
      .where(eq(serverMeta.key, SERVER_META_KEY))
      .limit(1);
    // row is guaranteed present after the insert-or-conflict above.
    return {
      instanceId: row?.instanceId ?? instanceId,
      dataGeneration: row?.dataGeneration ?? 0,
    };
  }

  /**
   * The current data identity for /me (Me.instance). Memoizable in principle,
   * but /me is called rarely relative to data writes and reads the singleton
   * row by primary key, so we don't bother caching — every call sees the live
   * row, which is what we want immediately after a restore + bump.
   */
  async getInstance(): Promise<ServerInstance> {
    const row = await this.getOrCreateRow();
    return { instanceId: row.instanceId, dataGeneration: row.dataGeneration };
  }

  /**
   * Atomically advance the data generation. Called by BackupService.restore
   * AFTER the restored DB has been reopened (so the bump lands on the new DB).
   * The increment is a single UPDATE, so concurrent callers still advance
   * monotonically; SQLite serializes them under its write lock. Seeding the row
   * first (getOrCreateRow) guarantees the UPDATE matches exactly one row even
   * on a freshly-restored DB that predates server_meta.
   */
  async bumpGeneration(): Promise<ServerInstance> {
    await this.getOrCreateRow();
    await this.db
      .update(serverMeta)
      .set({ dataGeneration: sqlIncrementGeneration(), updatedAt: nowIso() })
      .where(eq(serverMeta.key, SERVER_META_KEY));
    return this.getInstance();
  }
}

/**
 * `data_generation = data_generation + 1` expressed for drizzle's `.set()`.
 * Kept local because drizzle's SQL builder is the cleanest way to emit a
 * column-relative update; the alternative (read-then-write) would race across
 * concurrent restores and lose increments.
 */
function sqlIncrementGeneration() {
  return sql`${serverMeta.dataGeneration} + 1`;
}
