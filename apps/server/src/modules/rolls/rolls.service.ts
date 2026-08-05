import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { and, desc, eq, inArray, lte, notExists, sql } from 'drizzle-orm';
import type { DiceRoll, RollResult, RollResultTerm, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { diceRolls, encounters, npcs } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import type { RequestUser } from '../../common/user.types';
import { UNKNOWN_COMBATANT_LABEL } from '../encounters/encounters.logic';

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
  const source = row.source === 'manual' ? 'manual' : 'rolled';
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
    source,
    ...(row.actor ? { actor: row.actor } : {}),
    ...(row.natural20 != null ? { natural20: row.natural20 } : {}),
    ...(row.encounterId != null ? { encounterId: row.encounterId } : {}),
    ...(row.npcId != null ? { npcId: row.npcId } : {}),
    createdAt: row.createdAt,
  };
}

/** The subset shared by the root DB handle and a synchronous Drizzle transaction. */
type RollWriteDb = Pick<DrizzleDb, 'insert'>;

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
    return this.recordInTransaction(this.db, campaignId, result, user);
  }

  /**
   * Inserts a roll using an existing transaction. Encounter death saves use this
   * so the state transition and its shared-tray evidence commit or roll back as
   * one SQLite unit (issue #1462).
   */
  recordInTransaction(db: RollWriteDb, campaignId: number, result: RollResult, user: RequestUser): DiceRoll {
    const [row] = db
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
        source: result.source ?? 'rolled',
        actor: result.actor ?? null,
        natural20: result.natural20 ?? null,
        encounterId: result.encounterId ?? null,
        npcId: result.npcId ?? null,
        createdAt: nowIso(),
      })
      .returning()
      .all();
    return toDomain(row);
  }

  /**
   * Most-recent-first roll feed for a campaign. The `limit` caps what a single
   * request returns (the live feed window); it is independent of the durable
   * retention ceiling, which governs how many rows *exist* at all.
   *
   * `role` drives issue #1904 read-time redaction: omit it (or pass `dm`) only for
   * DM-facing returns (export, scribe recaps, the DM's own feed) — mirrors the
   * `viewerRole` convention on `EncountersService.getWithCombatantsOrThrow`. A write-time
   * check alone cannot catch an encounter/NPC that becomes hidden AFTER a roll naming it
   * was already persisted, so a non-DM role re-checks CURRENT visibility on every read.
   */
  async listForCampaign(campaignId: number, limit = DEFAULT_ROLL_LIST_LIMIT, role?: Role): Promise<DiceRoll[]> {
    if (role === undefined || role === 'dm') {
      const rows = await this.db
        .select()
        .from(diceRolls)
        .where(eq(diceRolls.campaignId, campaignId))
        .orderBy(desc(diceRolls.id))
        .limit(limit);
      return rows.map(toDomain);
    }
    // Issue #1904 review finding (2 rounds; reconciled with a concurrently-pushed
    // bounded-cursor-loop attempt at the same fix — see the PR thread reply for why this
    // SQL-pushdown approach was kept instead): applying the LIMIT before dropping
    // hidden-encounter rolls can hand a non-DM caller a short (or empty) page while older
    // VISIBLE rolls exist just past the cutoff. The first fix widened the candidate window
    // and redacted in app code — CORRECT, but it made every non-DM poll of this endpoint
    // (the hottest one in live play) fetch up to the full retention ceiling instead of the
    // page actually asked for, ~20x the DB/JSON-decode work per poll. Pushing the exclusion
    // into the query itself removes the amplification rather than bounding it: a correlated
    // NOT EXISTS drops a row whose encounter is hidden RIGHT THERE, so the existing LIMIT is
    // already correct and the SQL engine (not this process) does the filtering work — with
    // no iteration cap that could still under-fill a page if more than N consecutive newest
    // rolls turn out to be hidden.
    //
    // Hidden-NPC label masking deliberately stays OUT of this query: unlike the
    // encounter-hidden case, it never removes a row (see maskHiddenNpcLabels below) — only
    // the ROW-COUNT-changing predicate needs to be pushed into SQL to fix pagination; a
    // predicate that just swaps a label can stay a plain, LIMIT-bounded post-process.
    const rows = await this.db
      .select()
      .from(diceRolls)
      .where(
        and(
          eq(diceRolls.campaignId, campaignId),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(encounters)
              .where(and(eq(encounters.id, diceRolls.encounterId), eq(encounters.hidden, true))),
          ),
        ),
      )
      .orderBy(desc(diceRolls.id))
      .limit(limit);
    return this.maskHiddenNpcLabels(rows.map(toDomain));
  }

  /**
   * Issue #1904 review finding: redacts a SINGLE previously-recorded roll for a role that may
   * differ from the one it was originally rendered for. Used by EncountersService's idempotent
   * per-combatant initiative-roll replay, which otherwise reuses the roll payload verbatim
   * across a role change (e.g. the DM who rolled for a visible NPC is demoted after the NPC
   * is hidden, then replays the same idempotency key) — exactly the gap `listForCampaign`
   * closes for the shared feed, but the replay path returns one roll directly rather than
   * going through that list. Delegates to `redactForRole` so both paths share one masking
   * rule; `null` covers the (encounter-hidden) case where redaction would drop the row
   * entirely — the caller falls back to omitting the roll rather than showing a half object.
   */
  async redactRollForRole(roll: DiceRoll, role: Role): Promise<DiceRoll | null> {
    if (role === 'dm') return roll;
    const [redacted] = await this.redactForRole([roll]);
    return redacted ?? null;
  }

  /**
   * Issue #1904: re-checks CURRENT visibility for every roll tied to an encounter/NPC and
   * redacts what a non-DM may no longer see, regardless of what was safe to persist at
   * WRITE time. A roll naming a now-hidden ENCOUNTER is dropped wholesale (mirrors that
   * hidden encounters are indistinguishable from nonexistent for a non-DM elsewhere in this
   * codebase); a roll naming a combatant linked to a now-hidden NPC keeps its row and gets
   * its label masked via {@link maskHiddenNpcLabels}.
   *
   * Used only by {@link redactRollForRole} (the single-roll idempotent-replay path), where
   * there is no SQL query to push a filter into — `listForCampaign` instead expresses the
   * row-dropping encounter check directly in its query (a correlated `NOT EXISTS`) and calls
   * `maskHiddenNpcLabels` on its own already-paginated result, so a non-DM's list read never
   * pays for an app-level filter over a wide over-fetched candidate window (issue #1904
   * follow-up review finding: the earlier app-level version of this filter, applied here,
   * required exactly that over-fetch to keep pagination correct, ~20x the per-poll cost on
   * the hottest polling endpoint in live play).
   */
  private async redactForRole(rolls: DiceRoll[]): Promise<DiceRoll[]> {
    const encounterIds = [...new Set(rolls.map((r) => r.encounterId).filter((id): id is number => id !== undefined))];
    if (encounterIds.length === 0) return this.maskHiddenNpcLabels(rolls);

    const hiddenEncounterIds = new Set(
      (await this.db.select({ id: encounters.id }).from(encounters).where(and(inArray(encounters.id, encounterIds), eq(encounters.hidden, true)))).map(
        (r) => r.id,
      ),
    );
    const survivors =
      hiddenEncounterIds.size === 0 ? rolls : rolls.filter((r) => r.encounterId === undefined || !hiddenEncounterIds.has(r.encounterId));
    return this.maskHiddenNpcLabels(survivors);
  }

  /**
   * Issue #1904: masks the label (and severs `npcId`) of any roll linked to a combatant
   * whose NPC is CURRENTLY hidden — the dice log entry itself is not secret, only the
   * label's naming, mirroring how a hidden-NPC combatant token still shows in initiative
   * order without exposing who it is. Deliberately does NOT drop the row: unlike the
   * hidden-ENCOUNTER case, this never changes the result's row count, so `listForCampaign`
   * can call it directly on its already-paginated (LIMIT-bounded) page with no risk of
   * shrinking it below the requested size — no over-fetch needed for this half of
   * redaction, only for the row-dropping encounter check (pushed into SQL instead, see
   * `listForCampaign`).
   *
   * The reconstructed label assumes the exact "<name> · Initiative" suffix every current
   * npcId-tagged producer writes (encounters.service.ts's bulk and per-combatant initiative
   * rolls — the only callers that set npcId today), and matches the SAME string those write
   * paths already use for an NPC hidden AT roll time, so a masked entry looks identical
   * regardless of when the hide happened. Revisit this if a future roll type starts tagging
   * npcId for a different action label.
   */
  private async maskHiddenNpcLabels(rolls: DiceRoll[]): Promise<DiceRoll[]> {
    const npcIds = [...new Set(rolls.map((r) => r.npcId).filter((id): id is number => id !== undefined))];
    if (npcIds.length === 0) return rolls;

    const hiddenNpcIds = new Set(
      (await this.db.select({ id: npcs.id }).from(npcs).where(and(inArray(npcs.id, npcIds), eq(npcs.hidden, true)))).map((r) => r.id),
    );
    if (hiddenNpcIds.size === 0) return rolls;

    return rolls.map((r) => {
      if (r.npcId === undefined || !hiddenNpcIds.has(r.npcId)) return r;
      // Issue #1904 review finding (reported 3x): masking the LABEL is not enough while
      // `npcId` survives the object spread — a stable id is exactly what lets a player
      // correlate this roll with a later reveal of the same NPC ("the creature that
      // rolled initiative back then IS this one"), reconstructing the identity the label
      // mask was supposed to withhold. Null it out alongside the label, same as the
      // roster-read mask (getWithCombatantsOrThrow: `{ ...c, npcId: null, name:
      // UNKNOWN_COMBATANT_LABEL }`) severs the identity link, not just the display name.
      const { npcId: _npcId, ...withoutNpcId } = r;
      return { ...withoutNpcId, label: `${UNKNOWN_COMBATANT_LABEL} · Initiative` };
    });
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
   * `idx_dice_rolls_campaign_id_desc`, and we only do work at all for campaigns that
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
