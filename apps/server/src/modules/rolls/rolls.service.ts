import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { and, desc, eq, lte } from 'drizzle-orm';
import type { DiceRoll, RollResult, RollResultTerm } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { diceRolls } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import type { RequestUser } from '../../common/user.types';

/**
 * #614: how many dice rolls each campaign keeps before the oldest are pruned.
 *
 * History was previously hard-capped at 200 with synchronous delete-on-insert
 * — every 201st roll silently evicted the oldest row, with no policy, no
 * disclosure, and no way to recover or reconfigure it. That was a log that
 * lied about being durable.
 *
 * The new policy is *disclosed bounded retention*: a much higher default, an
 * env override, and `0`/negative to keep everything (for tables that ship the
 * DB off-box or simply never want to lose a roll). Pruning also moved off the
 * insert hot path onto a background sweep (see `onApplicationBootstrap`) so a
 * player's roll is never slowed or raced by a delete.
 *
 * Default 1000: ~5x the old silent cap, enough for many sessions of a
 * combat-heavy table, small enough that an unbounded-log operator running with
 * the default still won't grow the DB without limit. The GET feed stays
 * separately bounded (`DEFAULT_ROLL_LIST_LIMIT`); this number is the *durable*
 * ceiling on what's stored, not what a single request returns.
 */
export const DEFAULT_DICE_ROLLS_RETENTION = 1000;

/** Default/maximum page size for the shared roll feed (GET /campaigns/:id/rolls). */
export const DEFAULT_ROLL_LIST_LIMIT = 50;

/**
 * How often the background retention sweep runs. The sweep is best-effort and
 * off the hot path, so an hourly cadence is plenty — a few over-cap rows live
 * briefly until the next tick, which is strictly better than the old "gone
 * immediately and forever" behavior. Mirrors the audit-log sweep's daily
 * `.unref()`d-timer convention but tighter (rolls accumulate faster than
 * audit rows during combat).
 */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Resolves the configured per-campaign dice-roll retention from
 * `DICE_ROLLS_RETENTION`. `0` or a negative value disables pruning entirely
 * (keep all history); a non-numeric or empty value falls back to the default.
 * Read fresh on each call so an operator flipping the env (then restarting)
 * sees the new policy without a code change — same convention as
 * `AUDIT_RETENTION_DAYS`.
 */
export function resolveDiceRollsRetention(): number {
  const raw = process.env.DICE_ROLLS_RETENTION;
  if (raw === undefined || raw === '') return DEFAULT_DICE_ROLLS_RETENTION;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DICE_ROLLS_RETENTION;
  return Math.trunc(n);
}

/** True when retention is configured to keep history indefinitely (0/negative). */
export function retentionIsUnbounded(): boolean {
  return resolveDiceRollsRetention() <= 0;
}

function toDomain(row: typeof diceRolls.$inferSelect): DiceRoll {
  const kept = row.kept != null ? fromJsonText<number[]>(row.kept, []) : undefined;
  const terms = row.terms != null ? fromJsonText<RollResultTerm[]>(row.terms, []) : undefined;
  return {
    id: row.id,
    campaignId: row.campaignId,
    rollerUserId: row.rollerUserId,
    rollerName: row.rollerName,
    expr: row.expr,
    rolls: fromJsonText<number[]>(row.rolls, []),
    ...(kept !== undefined ? { kept } : {}),
    total: row.total,
    // Compound-expression breakdown (issue #536); absent for a classic single-term roll.
    ...(terms !== undefined && terms.length > 0 ? { terms } : {}),
    ...(row.label ? { label: row.label } : {}),
    // success is derived, not stored — it's always total >= dc when a dc is set.
    ...(row.dc != null ? { dc: row.dc, success: row.total >= row.dc } : {}),
    createdAt: row.createdAt,
  };
}

/**
 * Persistence for the campaign-shared dice log (issue #35). Deliberately dumb —
 * record + list only, no push mechanics — so a later SSE stream (issue #4) can
 * emit the recorded DiceRoll as-is without this store changing shape. The actual
 * dice math stays in common/dice.ts; auditing stays with the roll endpoint
 * (EncountersService.rollDiceForCampaign).
 *
 * Retention (issue #614) is *disclosed bounded*: `record` only inserts; a
 * background sweep prunes over-cap campaigns on an interval, off the player's
 * hot path. `DICE_ROLLS_RETENTION` configures the cap (0/negative = keep all).
 */
@Injectable()
export class RollsService implements OnApplicationBootstrap {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  /**
   * Kick off retention. Prune once at boot (awaited so a test's immediate
   * `.close()` can't race an in-flight delete), then re-sweep hourly on an
   * `.unref()`d timer so it never keeps Node alive. Mirrors the audit sweep.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.pruneOverCap();
    const timer = setInterval(() => {
      void this.pruneOverCap();
    }, PRUNE_INTERVAL_MS);
    timer.unref();
  }

  /**
   * Persists a roll result under the roller's identity. Does NOT prune —
   * pruning moved to the background sweep (issue #614) so the insert path is
   * always fast and a roll is never lost to a synchronous delete race.
   */
  async record(campaignId: number, result: RollResult, user: RequestUser): Promise<DiceRoll> {
    const [row] = await this.db
      .insert(diceRolls)
      .values({
        campaignId,
        rollerUserId: user.id,
        rollerName: user.name,
        expr: result.expr,
        rolls: toJsonText(result.rolls),
        kept: result.kept !== undefined ? toJsonText(result.kept) : null,
        terms: result.terms !== undefined ? toJsonText(result.terms) : null,
        total: result.total,
        label: result.label ?? null,
        dc: result.dc ?? null,
        createdAt: nowIso(),
      })
      .returning();
    return toDomain(row);
  }

  /**
   * Most-recent-first roll feed for a campaign. The `limit` caps what a single
   * request returns (the live feed window); it is independent of the durable
   * retention ceiling, which governs how many rows *exist* at all.
   */
  async listForCampaign(campaignId: number, limit = DEFAULT_ROLL_LIST_LIMIT): Promise<DiceRoll[]> {
    const rows = await this.db
      .select()
      .from(diceRolls)
      .where(eq(diceRolls.campaignId, campaignId))
      .orderBy(desc(diceRolls.id))
      .limit(limit);
    return rows.map(toDomain);
  }

  /**
   * #614: prunes every campaign down to its newest `retention` rows. A
   * retention of 0/negative is a documented "keep everything" policy and this
   * is a no-op. Idempotent and safe to call from the boot sweep, from tests,
   * or manually; never called from `record` (the hot path stays insert-only).
   *
   * Accepts an optional override so tests can drive a specific cap without
   * mutating `process.env` (mirrors `AuditService.pruneExpired(days)`). When
   * omitted, the configured `DICE_ROLLS_RETENTION` is used.
   *
   * AUTOINCREMENT ids are monotonic, so id order == insertion order: to keep
   * the newest N rows we find the id of the (N+1)th-newest row and delete
   * everything at or below it. Scanning per-campaign ids is cheap thanks to
   * `idx_dice_rolls_campaign`, and we only do work at all for campaigns that
   * are actually over-cap.
   *
   * Returns the number of rows deleted, so callers (and tests) can observe
   * that work happened without re-querying.
   */
  async pruneOverCap(retentionOverride?: number): Promise<number> {
    const retention = retentionOverride ?? resolveDiceRollsRetention();
    if (retention <= 0) return 0; // keep-all policy — never prune.

    // Distinct campaigns with at least one row. Cheaper than a GROUP BY HAVING
    // COUNT > retention on SQLite (which would still scan the index) and keeps
    // the per-campaign delete bounded by `lte(id, threshold)` on the indexed
    // campaign_id column.
    const campaigns = await this.db
      .select({ campaignId: diceRolls.campaignId })
      .from(diceRolls)
      .groupBy(diceRolls.campaignId);
    let deleted = 0;
    for (const { campaignId } of campaigns) {
      // The id of the (retention+1)th-newest roll: everything at or below it
      // is over-cap and gets evicted. Absent when the campaign is at/under cap.
      const [overflow] = await this.db
        .select({ id: diceRolls.id })
        .from(diceRolls)
        .where(eq(diceRolls.campaignId, campaignId))
        .orderBy(desc(diceRolls.id))
        .limit(1)
        .offset(retention);
      if (overflow) {
        const result = await this.db
          .delete(diceRolls)
          .where(and(eq(diceRolls.campaignId, campaignId), lte(diceRolls.id, overflow.id)));
        deleted += result.changes;
      }
    }
    return deleted;
  }
}
