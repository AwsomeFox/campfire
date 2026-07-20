import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lte } from 'drizzle-orm';
import type { DiceRoll, RollResult } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { diceRolls } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import type { RequestUser } from '../../common/user.types';

/** Rolls kept per campaign — older rolls are pruned on insert (a log, not an archive). */
export const MAX_ROLLS_PER_CAMPAIGN = 200;

/** Default/maximum page size for the shared roll feed (GET /campaigns/:id/rolls). */
export const DEFAULT_ROLL_LIST_LIMIT = 50;

function toDomain(row: typeof diceRolls.$inferSelect): DiceRoll {
  return {
    id: row.id,
    campaignId: row.campaignId,
    rollerUserId: row.rollerUserId,
    rollerName: row.rollerName,
    expr: row.expr,
    rolls: fromJsonText<number[]>(row.rolls, []),
    total: row.total,
    createdAt: row.createdAt,
  };
}

/**
 * Persistence for the campaign-shared dice log (issue #35). Deliberately dumb —
 * record + list only, no push mechanics — so a later SSE stream (issue #4) can
 * emit the recorded DiceRoll as-is without this store changing shape. The actual
 * dice math stays in common/dice.ts; auditing stays with the roll endpoint
 * (EncountersService.rollDiceForCampaign).
 */
@Injectable()
export class RollsService {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  /** Persists a roll result under the roller's identity and prunes old history. */
  async record(campaignId: number, result: RollResult, user: RequestUser): Promise<DiceRoll> {
    const [row] = await this.db
      .insert(diceRolls)
      .values({
        campaignId,
        rollerUserId: user.id,
        rollerName: user.name,
        expr: result.expr,
        rolls: toJsonText(result.rolls),
        total: result.total,
        createdAt: nowIso(),
      })
      .returning();

    // Keep only the newest MAX_ROLLS_PER_CAMPAIGN rows for this campaign: find the id
    // of the (MAX+1)th-newest roll and delete everything at or below it. AUTOINCREMENT
    // ids are monotonic, so id order == insertion order.
    const [overflow] = await this.db
      .select({ id: diceRolls.id })
      .from(diceRolls)
      .where(eq(diceRolls.campaignId, campaignId))
      .orderBy(desc(diceRolls.id))
      .limit(1)
      .offset(MAX_ROLLS_PER_CAMPAIGN);
    if (overflow) {
      await this.db.delete(diceRolls).where(and(eq(diceRolls.campaignId, campaignId), lte(diceRolls.id, overflow.id)));
    }

    return toDomain(row);
  }

  /** Most-recent-first roll feed for a campaign. */
  async listForCampaign(campaignId: number, limit = DEFAULT_ROLL_LIST_LIMIT): Promise<DiceRoll[]> {
    const rows = await this.db
      .select()
      .from(diceRolls)
      .where(eq(diceRolls.campaignId, campaignId))
      .orderBy(desc(diceRolls.id))
      .limit(limit);
    return rows.map(toDomain);
  }
}
