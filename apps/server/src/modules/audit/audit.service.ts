import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, isNull, lt, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { AuditPayload } from '@campfire/schema';
import type {
  AuditActorRole,
  AuditEntry,
  AuditLegalHold,
  AuditListPage,
  AuditPruneJob,
  AuditPrunePreview,
  AuditRetentionPolicy,
  AuditRetentionPolicyUpdate,
  AuditRetentionStatus,
} from '@campfire/schema';
import { getRequestId } from '../../common/request-context';
import { buildCursorListPage } from '../../common/cursor-pagination';
import { DB, resolveDataDir, type DrizzleDb } from '../../db/db.module';
import { auditLog, settings } from '../../db/schema';
import { nowIso } from '../../common/time';
import { BACKUP_CADENCE_KEY, type BackupCadenceState } from '../backup/backup-cadence';
import { clampAuditListLimit, decodeAuditCursor } from './audit-pagination';

/**
 * Either the top-level handle or a live transaction callback's `tx` (issue #1581).
 * Same alias as every other service that writes inside `db.transaction(...)` —
 * see e.g. `organized-play.service.ts` / `scheduling.service.ts` — restated here
 * rather than imported from one of them, since audit is a lower-level module
 * those services depend ON and must not depend back.
 */
type SyncDb = DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * #74: how long audit rows are retained before the background sweep prunes them.
 * Overridable via AUDIT_RETENTION_DAYS (0 or negative disables pruning entirely —
 * e.g. for operators who ship the log off-box and want to keep everything).
 * Default 365 days: long enough to answer "who changed this months ago", short
 * enough that a combat-heavy table doesn't grow the DB without bound.
 */
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;

/** How often the retention sweep runs. Daily is plenty — retention is coarse (days). */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUDIT_RETENTION_SETTINGS_KEY = 'audit.retention';
const AUDIT_LEGAL_HOLD_SETTINGS_KEY = 'audit.legalHold';
const AUDIT_LAST_PRUNE_JOB_SETTINGS_KEY = 'audit.lastPruneJob';
const ARCHIVE_PAGE_SIZE = 500;

/**
 * Internal page size when walking the full retained audit trail for campaign export
 * (#731). This is NOT a cap on how many rows are exported — we page until every row
 * in the snapshot is collected.
 */
export const EXPORT_AUDIT_PAGE_SIZE = 500;

/** #731: rows omitted from export vs snapshot — unit-tested for pruning/post-append semantics. */
export function computeCampaignAuditExportTruncated(
  total: number,
  exported: number,
  /** Rows with id > snapshotMaxId at the end of the export walk. */
  postSnapshotCount: number,
): number {
  const missingFromSnapshot = Math.max(0, total - exported);
  return missingFromSnapshot + Math.max(0, postSnapshotCount);
}

/** Metadata bundled with campaign exports so a partial audit slice never looks complete. */
export type CampaignAuditExportMeta = {
  /** Rows retained for this campaign with id <= snapshotMaxId at capture time. */
  total: number;
  /** Rows actually present in the export's `audit` array. */
  exported: number;
  /**
   * Rows omitted from this export relative to what the snapshot promised:
   * `(total - exported)` — rows at or below `cutoff.snapshotMaxId` that were not
   * collected (e.g. retention pruning during the walk), plus any rows appended after
   * the snapshot ceiling (`id > snapshotMaxId`, concurrent writes during export).
   */
  truncated: number;
  cutoff: {
    /** Monotonic autoincrement ceiling for this snapshot — rows with id > this are excluded. */
    snapshotMaxId: number;
    /** ISO timestamp when the snapshot ceiling was recorded. */
    capturedAt: string;
    /** createdAt of the oldest exported row (the trailing edge of included history). */
    oldestExportedCreatedAt: string | null;
  };
};

export function resolveRetentionDays(): number {
  const raw = process.env.AUDIT_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_AUDIT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_AUDIT_RETENTION_DAYS;
}

function envFlag(raw: string | undefined): boolean | null {
  if (raw == null || raw === '') return null;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function normalizeRetentionSettings(raw: unknown): AuditRetentionPolicyUpdate {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  const out: AuditRetentionPolicyUpdate = {};
  if (Number.isInteger(input.days)) out.days = input.days as number;
  if (typeof input.autoPruneEnabled === 'boolean') out.autoPruneEnabled = input.autoPruneEnabled;
  if (typeof input.requireArchiveBeforePrune === 'boolean') out.requireArchiveBeforePrune = input.requireArchiveBeforePrune;
  if (Number.isInteger(input.requireRecentBackupHours) && (input.requireRecentBackupHours as number) >= 0) {
    out.requireRecentBackupHours = input.requireRecentBackupHours as number;
  }
  return out;
}

function normalizeLegalHold(raw: unknown): AuditLegalHold {
  if (!raw || typeof raw !== 'object') return { global: false, campaignIds: [] };
  const input = raw as Record<string, unknown>;
  const ids = Array.isArray(input.campaignIds)
    ? Array.from(
        new Set(
          input.campaignIds
            .filter((id): id is number => Number.isInteger(id) && id > 0)
            .map((id) => Number(id)),
        ),
      ).sort((a, b) => a - b)
    : [];
  return { global: input.global === true, campaignIds: ids };
}

function archiveDir(): string {
  return process.env.AUDIT_ARCHIVE_DIR || process.env.BACKUP_DIR || path.join(resolveDataDir(), 'audit-archives');
}

function retentionDetail(policy: AuditRetentionPolicy): string {
  return [
    `days=${policy.days}`,
    `autoPruneEnabled=${policy.autoPruneEnabled}`,
    `requireArchiveBeforePrune=${policy.requireArchiveBeforePrune}`,
    `requireRecentBackupHours=${policy.requireRecentBackupHours}`,
  ].join(', ');
}

/** Shared by {@link AuditService.log} and {@link AuditService.logInTx} — one row shape, two write paths. */
export type AuditLogParams = {
  actor: string;
  actorRole: AuditActorRole;
  action: string;
  entityType?: string | null;
  entityId?: number | null;
  campaignId?: number | null;
  detail?: string;
  /**
   * Raw, typed forensic data. `detail` remains the compact human summary so
   * legacy readers and markdown exports stay useful without parsing JSON.
   */
  payload?: AuditPayload;
  /**
   * Overrides the ambient correlation id (#684). Pass `null` to write a row with NO
   * requestId — the deliberate de-correlation path for issue #599's anonymous safety
   * holds. `requestId` is a DM-queryable filter on the audit list, so an intentionally
   * unattributed row that still carries the correlation id of the request that produced
   * it is one join away from being attributed the moment any other row is ever written
   * under that same request. Omit the field entirely for normal rows.
   */
  requestId?: string | null;
};

/**
 * Decode the stored payload defensively. A malformed value must never make an
 * audit reader unavailable; it is treated as absent rather than guessed at.
 */
function parsePayload(raw: string | null): AuditPayload | null {
  if (!raw) return null;
  try {
    const parsed = AuditPayload.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Defensive public projection for any consumer of persisted audit rows.
 * Campaign-scoped consumers may receive the payload and detail only when their
 * authorization boundary has already established that disclosure is allowed.
 */
export function toAuditEntry(
  row: typeof auditLog.$inferSelect,
  { includePayload = true, includeDetail = true }: { includePayload?: boolean; includeDetail?: boolean } = {},
): AuditEntry {
  return {
    id: row.id,
    campaignId: row.campaignId,
    actor: row.actor,
    actorRole: row.actorRole as AuditActorRole,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    detail: includeDetail ? row.detail : '',
    payload: includePayload ? parsePayload(row.payloadJson) : null,
    requestId: row.requestId,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class AuditService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  /**
   * Disclose retention without deleting at boot. Daily auto-prune is opt-in via
   * AUDIT_AUTO_PRUNE=1 or persisted policy; the first sweep happens on the timer,
   * never during application startup.
   */
  async onApplicationBootstrap(): Promise<void> {
    const policy = await this.getRetentionPolicy();
    this.logger.log(
      `Audit retention policy: ${policy.days <= 0 ? 'keep forever' : `${policy.days} days`}; ` +
        `auto-prune ${policy.autoPruneEnabled ? 'enabled' : 'disabled'}; archive dir ${policy.archiveDir}`,
    );
    if (!policy.autoPruneEnabled || policy.days <= 0) return;
    const timer = setInterval(() => {
      void this.pruneExpiredJob({ actor: 'system:auto-prune' }).catch((err) => {
        this.logger.error(`Audit retention sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, PRUNE_INTERVAL_MS);
    timer.unref();
  }

  async getRetentionStatus(): Promise<AuditRetentionStatus> {
    const [policy, legalHold, lastJob] = await Promise.all([
      this.getRetentionPolicy(),
      this.getLegalHold(),
      this.getLastPruneJob(),
    ]);
    return { policy, legalHold, lastJob };
  }

  async getRetentionPolicy(): Promise<AuditRetentionPolicy> {
    const stored = normalizeRetentionSettings(await this.getJson<unknown>(AUDIT_RETENTION_SETTINGS_KEY));
    const envDaysRaw = process.env.AUDIT_RETENTION_DAYS;
    const envDaysSet = envDaysRaw !== undefined && envDaysRaw !== '';
    const days = envDaysSet ? resolveRetentionDays() : stored.days ?? DEFAULT_AUDIT_RETENTION_DAYS;
    const envAuto = envFlag(process.env.AUDIT_AUTO_PRUNE);
    return {
      days,
      defaultDays: DEFAULT_AUDIT_RETENTION_DAYS,
      autoPruneEnabled: envAuto ?? stored.autoPruneEnabled ?? false,
      requireArchiveBeforePrune: stored.requireArchiveBeforePrune ?? true,
      requireRecentBackupHours: stored.requireRecentBackupHours ?? 0,
      source: {
        days: envDaysSet ? 'env' : stored.days !== undefined ? 'settings' : 'default',
        autoPruneEnabled: envAuto !== null ? 'env' : stored.autoPruneEnabled !== undefined ? 'settings' : 'default',
      },
      archiveDir: archiveDir(),
    };
  }

  async updateRetentionPolicy(update: AuditRetentionPolicyUpdate, actor?: { actor: string; actorRole: AuditActorRole }): Promise<AuditRetentionPolicy> {
    const existing = normalizeRetentionSettings(await this.getJson<unknown>(AUDIT_RETENTION_SETTINGS_KEY));
    const next: AuditRetentionPolicyUpdate = { ...existing };
    if (update.days !== undefined) {
      if (!Number.isInteger(update.days)) throw new BadRequestException('days must be an integer');
      next.days = update.days;
    }
    if (update.autoPruneEnabled !== undefined) next.autoPruneEnabled = update.autoPruneEnabled;
    if (update.requireArchiveBeforePrune !== undefined) next.requireArchiveBeforePrune = update.requireArchiveBeforePrune;
    if (update.requireRecentBackupHours !== undefined) {
      if (!Number.isInteger(update.requireRecentBackupHours) || update.requireRecentBackupHours < 0) {
        throw new BadRequestException('requireRecentBackupHours must be a non-negative integer');
      }
      next.requireRecentBackupHours = update.requireRecentBackupHours;
    }
    await this.setJson(AUDIT_RETENTION_SETTINGS_KEY, next);
    const policy = await this.getRetentionPolicy();
    await this.log({
      actor: actor?.actor ?? 'system',
      actorRole: actor?.actorRole ?? 'admin',
      action: 'audit.retention.update',
      entityType: 'settings',
      detail: retentionDetail(policy),
    });
    return policy;
  }

  async getLegalHold(): Promise<AuditLegalHold> {
    return normalizeLegalHold(await this.getJson<unknown>(AUDIT_LEGAL_HOLD_SETTINGS_KEY));
  }

  async updateLegalHold(input: AuditLegalHold, actor?: { actor: string; actorRole: AuditActorRole }): Promise<AuditLegalHold> {
    const next = normalizeLegalHold(input);
    await this.setJson(AUDIT_LEGAL_HOLD_SETTINGS_KEY, next);
    await this.log({
      actor: actor?.actor ?? 'system',
      actorRole: actor?.actorRole ?? 'admin',
      action: 'audit.legal_hold.update',
      entityType: 'settings',
      detail: `global=${next.global}, campaignIds=${next.campaignIds.join(',') || 'none'}`,
    });
    return next;
  }

  async getLastPruneJob(): Promise<AuditPruneJob | null> {
    return this.getJson<AuditPruneJob>(AUDIT_LAST_PRUNE_JOB_SETTINGS_KEY);
  }

  async setRetentionHeaders(res: { setHeader(name: string, value: string): void }): Promise<void> {
    const policy = await this.getRetentionPolicy();
    res.setHeader('X-Audit-Retention-Days', policy.days <= 0 ? 'unlimited' : String(policy.days));
    res.setHeader('X-Audit-Auto-Prune', policy.autoPruneEnabled ? '1' : '0');
  }

  /** Turn `log()`/`logInTx()`'s params into the literal row both insert. One place, not two. */
  private buildRow(params: AuditLogParams): typeof auditLog.$inferInsert {
    return {
      campaignId: params.campaignId ?? null,
      actor: params.actor,
      actorRole: params.actorRole,
      action: params.action,
      entityType: params.entityType ?? null,
      entityId: params.entityId ?? null,
      detail: params.detail ?? '',
      payloadJson: params.payload ? JSON.stringify(params.payload) : null,
      requestId: params.requestId !== undefined ? params.requestId : (getRequestId() ?? null),
      createdAt: nowIso(),
    };
  }

  /**
   * Write an audit row through this service's OWN handle (issue #1581's "durable,
   * best-effort" path — the only one that existed before this issue). Commits
   * independently of whatever transaction the caller may itself be inside: if THIS
   * insert throws, nothing the caller already wrote is undone, and if the caller's own
   * transaction later aborts for an unrelated reason, this row survives anyway.
   *
   * That is the right guarantee for most callers (an audit subsystem outage must not
   * roll back a user's work), and is why this method's shape does not change here — see
   * {@link logInTx} for the opposite guarantee, and its doc comment for when to reach
   * for which.
   */
  async log(params: AuditLogParams): Promise<void> {
    await this.db.insert(auditLog).values(this.buildRow(params));
  }

  /**
   * Write an audit row INSIDE the caller's own transaction (issue #1581).
   *
   * Opposite guarantee from {@link log}: this row commits or rolls back WITH whatever
   * else `tx` does. Reach for it only when "the work happened but there is no record of
   * it" is itself the incident — consent decisions, privacy-policy changes, anything
   * where a silently-missing audit row is worse than the work not having happened at
   * all. For everything else (the common case), `log()`'s post-commit, best-effort
   * write is correct on purpose: an audit-subsystem hiccup must not undo a user's work,
   * and every existing caller keeps that behaviour unless it was deliberately moved
   * here — see the PR/commit for #1581 for exactly which ones were, and why.
   *
   * SYNCHRONOUS, and takes the caller's `tx`, on purpose: better-sqlite3 transaction
   * callbacks passed to `db.transaction(...)` must be plain synchronous functions (no
   * `await` inside — see every other `SyncDb` consumer in this codebase, e.g.
   * `organized-play.service.ts`'s `extendSeries`), so this cannot share `log()`'s async
   * body. Uses `.run()`, not `.then()`/`await`, so the insert executes and is checked
   * for a thrown error before the transaction's synchronous callback returns — the same
   * reason every other in-transaction write in this codebase uses `.run()`/`.all()`/`.get()`
   * rather than `await`.
   */
  logInTx(tx: SyncDb, params: AuditLogParams): void {
    tx.insert(auditLog).values(this.buildRow(params)).run();
  }

  /**
   * #161: a real delta channel for "what changed since last session". Beyond the
   * newest-first `limit`/`offset` window, an optional `filters` narrows the result:
   *   - `sinceId`  — only rows with id > sinceId (a monotonic autoincrement cursor:
   *                  read once, keep max(id), pass it back next time to fetch only
   *                  what's new — no client-side re-filtering of the whole log).
   *   - `sinceTs`  — only rows created strictly after this ISO timestamp (a wall-clock
   *                  cursor, e.g. a player's last-visit time; ISO-8601 sorts lexically).
   *   - `action`   — exact action match (e.g. 'npc.update').
   *   - `entityType` — exact entityType match (e.g. 'quest').
   * Still ordered newest-first so the freshest change is row 0; the caller takes the
   * first row's id as the next cursor. All filters compose (AND).
   */
  /** Count of retained audit rows for a campaign (all ids, or only id <= maxId when capped). */
  async countForCampaign(campaignId: number, maxId?: number): Promise<number> {
    const conditions = [eq(auditLog.campaignId, campaignId)];
    if (maxId != null) conditions.push(lte(auditLog.id, maxId));
    const [row] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(and(...conditions));
    return Number(row?.n ?? 0);
  }

  /** Rows for a campaign with id strictly greater than `minId` (post-snapshot appends). */
  async countForCampaignAbove(campaignId: number, minId: number): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(auditLog)
      .where(and(eq(auditLog.campaignId, campaignId), gt(auditLog.id, minId)));
    return Number(row?.value ?? 0);
  }


  /**
   * #731: export the full retained audit trail for a campaign from a stable snapshot.
   * Records the max(id) ceiling first, then keyset-pages every row with id <= that
   * ceiling (newest-first, same order as GET /audit). Rows inserted after the ceiling
   * are excluded from `entries` and counted in `meta.truncated` (with any snapshot
   * rows missed because of retention pruning during the walk).
   */
  async listForCampaignExport(campaignId: number, includePayload = true): Promise<{
    entries: Awaited<ReturnType<AuditService['listForCampaign']>>;
    meta: CampaignAuditExportMeta;
  }> {
    const capturedAt = nowIso();
    const [snapshotRow] = await this.db
      .select({
        maxId: sql<number>`coalesce(max(${auditLog.id}), 0)`,
        total: sql<number>`count(*)`,
      })
      .from(auditLog)
      .where(eq(auditLog.campaignId, campaignId));
    const snapshotMaxId = Number(snapshotRow?.maxId ?? 0);
    const total = snapshotMaxId === 0 ? 0 : Number(snapshotRow?.total ?? 0);

    type Row = Awaited<ReturnType<AuditService['listForCampaign']>>[number];
    const entries: Row[] = [];
    if (snapshotMaxId > 0) {
      let cursorBelow: number | undefined;
      while (true) {
        const pageConditions = [eq(auditLog.campaignId, campaignId), lte(auditLog.id, snapshotMaxId)];
        if (cursorBelow != null) pageConditions.push(lt(auditLog.id, cursorBelow));
        const page = await this.db
          .select()
          .from(auditLog)
          .where(and(...pageConditions))
          .orderBy(desc(auditLog.id))
          .limit(EXPORT_AUDIT_PAGE_SIZE);
        if (!page.length) break;
        entries.push(...page.map((row) => toAuditEntry(row, { includePayload })));
        if (page.length < EXPORT_AUDIT_PAGE_SIZE) break;
        cursorBelow = page[page.length - 1]!.id;
      }
    }

    const exported = entries.length;
    // Count post-snapshot appends directly so concurrent inserts between two
    // total-count queries cannot hide truncation (orchestrator review / #731).
    const postSnapshotCount = await this.countForCampaignAbove(campaignId, snapshotMaxId);
    const truncated = computeCampaignAuditExportTruncated(total, exported, postSnapshotCount);

    const oldest = entries.length ? entries[entries.length - 1]! : null;
    return {
      entries,
      meta: {
        total,
        exported,
        truncated,
        cutoff: {
          snapshotMaxId,
          capturedAt,
          oldestExportedCreatedAt: oldest?.createdAt ?? null,
        },
      },
    };
  }

  /**
   * Recompute `meta.truncated` after the rest of a campaign export payload is assembled,
   * so audit rows appended while other tables are being read are still disclosed (#731).
   */
  async finalizeCampaignExportMeta(
    campaignId: number,
    meta: CampaignAuditExportMeta,
  ): Promise<CampaignAuditExportMeta> {
    const postSnapshotCount = await this.countForCampaignAbove(campaignId, meta.cutoff.snapshotMaxId);
    return {
      ...meta,
      truncated: computeCampaignAuditExportTruncated(meta.total, meta.exported, postSnapshotCount),
    };
  }

  async listForCampaign(
    campaignId: number,
    limit = 100,
    offset = 0,
    filters: {
      sinceId?: number;
      sinceTs?: string;
      untilTs?: string;
      action?: string;
      entityType?: string;
      entityId?: number;
      actor?: string;
      requestId?: string;
    } = {},
  ) {
    const conditions = this.campaignAuditConditions(campaignId, filters);
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.id))
      .limit(limit)
      .offset(offset);
    return rows.map((row) => toAuditEntry(row));
  }

  /**
   * Cursor-paginated campaign audit list (issue #443). Newest-first by id; continue with
   * `cursor` from a previous `nextCursor`. All filters compose (AND).
   */
  async listForCampaignPage(
    campaignId: number,
    opts: {
      limit?: number;
      cursor?: string;
      sinceId?: number;
      sinceTs?: string;
      untilTs?: string;
      action?: string;
      entityType?: string;
      entityId?: number;
      actor?: string;
      requestId?: string;
    } = {},
  ): Promise<AuditListPage> {
    const limit = clampAuditListLimit(opts.limit);
    const cursor = decodeAuditCursor(opts.cursor);
    const baseConds = this.campaignAuditConditions(campaignId, opts);
    const pageConds = [...baseConds];
    if (cursor) pageConds.push(lt(auditLog.id, cursor.i));

    const [countRows, fetched] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(auditLog)
        .where(and(...baseConds)),
      this.db
        .select()
        .from(auditLog)
        .where(and(...pageConds))
        .orderBy(desc(auditLog.id))
        .limit(limit + 1),
    ]);

    const total = countRows[0]?.value ?? 0;
    return buildCursorListPage(fetched.map((row) => toAuditEntry(row)), limit, total, (last) => ({ v: 1, m: 'id', i: last.id })) as AuditListPage;
  }

  private campaignAuditConditions(
    campaignId: number,
    filters: {
      sinceId?: number;
      sinceTs?: string;
      untilTs?: string;
      action?: string;
      entityType?: string;
      entityId?: number;
      actor?: string;
      requestId?: string;
    },
  ): SQL[] {
    const conditions: SQL[] = [eq(auditLog.campaignId, campaignId)];
    if (filters.sinceId != null) conditions.push(gt(auditLog.id, filters.sinceId));
    if (filters.sinceTs != null && filters.sinceTs !== '') conditions.push(gt(auditLog.createdAt, filters.sinceTs));
    if (filters.untilTs != null && filters.untilTs !== '') conditions.push(lte(auditLog.createdAt, filters.untilTs));
    if (filters.action != null && filters.action !== '') conditions.push(eq(auditLog.action, filters.action));
    if (filters.entityType != null && filters.entityType !== '') conditions.push(eq(auditLog.entityType, filters.entityType));
    if (filters.entityId != null) conditions.push(eq(auditLog.entityId, filters.entityId));
    if (filters.actor != null && filters.actor !== '') conditions.push(eq(auditLog.actor, filters.actor));
    if (filters.requestId != null && filters.requestId !== '') conditions.push(eq(auditLog.requestId, filters.requestId));
    return conditions;
  }

  /**
   * #23: the server-wide admin trail — every row NOT tied to a campaign
   * (campaign_id IS NULL): user create/disable/delete, settings changes,
   * rule-pack installs, admin token mints. Server-admin only (see controller).
   */
  async listServerAdmin(limit = 100, offset = 0, requestId?: string) {
    if (requestId) {
      return this.searchByRequestId(requestId, limit, offset);
    }
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(isNull(auditLog.campaignId))
      .orderBy(desc(auditLog.id))
      .limit(limit)
      .offset(offset);
    return rows.map((row) => toAuditEntry(row));
  }

  /** Server-admin correlation search across every audit row (issue #684). */
  async searchByRequestId(requestId: string, limit = 100, offset = 0) {
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId))
      .orderBy(desc(auditLog.id))
      .limit(limit)
      .offset(offset);
    // Server-admin authority is not campaign membership. The request-id search
    // intentionally crosses campaign boundaries for operational correlation, so
    // it must not disclose a campaign row's structured (possibly DM-secret)
    // payload to an operator who has no campaign role.
    return rows.map((row) =>
      toAuditEntry(row, { includePayload: row.campaignId == null, includeDetail: row.campaignId == null }),
    );
  }

  /**
   * Dry-run the retention filter without deleting. Legal hold rows are counted
   * separately so an operator can see what would have been protected.
   */
  async previewPrune(retentionDays?: number): Promise<AuditPrunePreview> {
    const policy = await this.getRetentionPolicy();
    const days = retentionDays ?? policy.days;
    const cutoffIso = this.cutoffForRetention(days);
    if (cutoffIso === null) {
      return {
        cutoffIso: new Date(0).toISOString(),
        retentionDays: days,
        eligibleCount: 0,
        heldCount: 0,
        oldestEligibleAt: null,
        newestEligibleAt: null,
      };
    }
    const legalHold = await this.getLegalHold();
    const eligibleWhere = this.eligiblePruneWhere(cutoffIso, legalHold);
    const heldWhere = this.heldPruneWhere(cutoffIso, legalHold);
    const [eligibleRow] = await this.db
      .select({
        value: count(),
        oldest: sql<string | null>`min(${auditLog.createdAt})`,
        newest: sql<string | null>`max(${auditLog.createdAt})`,
      })
      .from(auditLog)
      .where(eligibleWhere);
    const [heldRow] = await this.db.select({ value: count() }).from(auditLog).where(heldWhere);
    return {
      cutoffIso,
      retentionDays: days,
      eligibleCount: Number(eligibleRow?.value ?? 0),
      heldCount: Number(heldRow?.value ?? 0),
      oldestEligibleAt: eligibleRow?.oldest ?? null,
      newestEligibleAt: eligibleRow?.newest ?? null,
    };
  }

  async pruneExpiredJob(opts: {
    retentionDays?: number;
    dryRun?: boolean;
    force?: boolean;
    actor?: string;
    actorRole?: AuditActorRole;
  } = {}): Promise<AuditPruneJob> {
    const policy = await this.getRetentionPolicy();
    const retentionDays = opts.retentionDays ?? policy.days;
    const preview = await this.previewPrune(retentionDays);
    const startedAt = nowIso();
    const jobBase: AuditPruneJob = {
      id: `audit-prune-${startedAt.replace(/[:.]/g, '-')}`,
      status: 'running',
      mode: opts.dryRun ? 'dryRun' : 'prune',
      startedAt,
      finishedAt: null,
      cutoffIso: preview.cutoffIso,
      retentionDays,
      eligibleCount: preview.eligibleCount,
      heldCount: preview.heldCount,
      archivedPath: null,
      archiveChecksum: null,
      deletedCount: 0,
      error: null,
      backupLastSuccessAt: await this.lastSuccessfulBackupAt(),
      actor: opts.actor ?? null,
    };
    await this.persistPruneJob(jobBase);

    try {
      if (opts.dryRun) {
        const finished = await this.finishPruneJob(jobBase, { status: 'succeeded' });
        await this.log({
          actor: opts.actor ?? 'system',
          actorRole: opts.actorRole ?? 'admin',
          action: 'audit.prune.preview',
          entityType: 'audit_log',
          detail: `cutoff=${preview.cutoffIso}, eligible=${preview.eligibleCount}, held=${preview.heldCount}`,
        });
        return finished;
      }

      const legalHold = await this.getLegalHold();
      if (legalHold.global) {
        throw new ConflictException('Global audit legal hold is enabled; pruning is blocked');
      }

      if (retentionDays <= 0) {
        return this.finishPruneJob(jobBase, { status: 'succeeded' });
      }

      if (policy.requireRecentBackupHours > 0 && !opts.force) {
        this.assertRecentBackup(jobBase.backupLastSuccessAt, policy.requireRecentBackupHours);
      }

      let archive: { path: string; checksum: string; rows: number } | null = null;
      if (policy.requireArchiveBeforePrune && preview.eligibleCount > 0) {
        archive = await this.archiveEligible(preview.cutoffIso, legalHold);
        if (archive.rows !== preview.eligibleCount) {
          const fresh = await this.previewPrune(retentionDays);
          throw new ConflictException(
            `Audit archive captured ${archive.rows} rows but ${fresh.eligibleCount} are currently eligible; re-run preview`,
          );
        }
      }

      const result = await this.db.delete(auditLog).where(this.eligiblePruneWhere(preview.cutoffIso, legalHold));
      const deletedCount = (result as unknown as { changes?: number }).changes ?? 0;
      const finished = await this.finishPruneJob(jobBase, {
        status: 'succeeded',
        archivedPath: archive?.path ?? null,
        archiveChecksum: archive?.checksum ?? null,
        deletedCount,
      });
      await this.log({
        actor: opts.actor ?? 'system',
        actorRole: opts.actorRole ?? 'admin',
        action: 'audit.prune',
        entityType: 'audit_log',
        detail:
          `cutoff=${preview.cutoffIso}, eligible=${preview.eligibleCount}, held=${preview.heldCount}, ` +
          `deleted=${deletedCount}, archive=${archive?.path ?? 'none'}`,
      });
      return finished;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.finishPruneJob(jobBase, { status: 'failed', error: message });
      try {
        await this.log({
          actor: opts.actor ?? 'system',
          actorRole: opts.actorRole ?? 'admin',
          action: 'audit.prune.failed',
          entityType: 'audit_log',
          detail: `cutoff=${preview.cutoffIso}, eligible=${preview.eligibleCount}, held=${preview.heldCount}, error=${message}`,
        });
      } catch {
        // Preserve the original prune failure; failed audit insertion is surfaced elsewhere.
      }
      throw err;
    }
  }

  /**
   * #74 compatibility entry point: explicit/manual pruning still exists, but it
   * now goes through the auditable job path instead of silent hard-delete.
   */
  async pruneExpired(retentionDays = resolveRetentionDays()): Promise<number> {
    const job = await this.pruneExpiredJob({ retentionDays, actor: 'system:manual-prune' });
    return job.deletedCount;
  }

  private async archiveEligible(cutoffIso: string, legalHold: AuditLegalHold): Promise<{ path: string; checksum: string; rows: number }> {
    const dir = archiveDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `audit-prune-${nowIso().replace(/[:.]/g, '-')}.jsonl`);
    const hash = createHash('sha256');
    let lastId = 0;
    let rows = 0;
    while (true) {
      const page = await this.db
        .select()
        .from(auditLog)
        .where(and(this.eligiblePruneWhere(cutoffIso, legalHold), gt(auditLog.id, lastId)))
        .orderBy(auditLog.id)
        .limit(ARCHIVE_PAGE_SIZE);
      if (page.length === 0) break;
      const chunk = page.map((row) => JSON.stringify(row)).join('\n') + '\n';
      fs.appendFileSync(filePath, chunk);
      hash.update(chunk);
      rows += page.length;
      lastId = page[page.length - 1]!.id;
      if (page.length < ARCHIVE_PAGE_SIZE) break;
    }
    return { path: filePath, checksum: hash.digest('hex'), rows };
  }

  private cutoffForRetention(retentionDays: number): string | null {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
    return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  }

  private eligiblePruneWhere(cutoffIso: string, legalHold: AuditLegalHold): SQL {
    const conditions: SQL[] = [lt(auditLog.createdAt, cutoffIso)];
    if (legalHold.global) {
      conditions.push(sql`0 = 1`);
    } else if (legalHold.campaignIds.length > 0) {
      conditions.push(or(isNull(auditLog.campaignId), notInArray(auditLog.campaignId, legalHold.campaignIds))!);
    }
    return and(...conditions)!;
  }

  private heldPruneWhere(cutoffIso: string, legalHold: AuditLegalHold): SQL {
    if (legalHold.global) return lt(auditLog.createdAt, cutoffIso);
    if (legalHold.campaignIds.length === 0) return sql`0 = 1`;
    return and(lt(auditLog.createdAt, cutoffIso), inArray(auditLog.campaignId, legalHold.campaignIds))!;
  }

  private async lastSuccessfulBackupAt(): Promise<string | null> {
    const cadence = await this.getJson<BackupCadenceState>(BACKUP_CADENCE_KEY);
    return cadence?.lastSuccessAt ?? null;
  }

  private assertRecentBackup(lastSuccessAt: string | null, requiredHours: number): void {
    if (!lastSuccessAt) {
      throw new ConflictException(`Audit prune requires a successful backup within ${requiredHours}h`);
    }
    const last = Date.parse(lastSuccessAt);
    if (Number.isNaN(last) || Date.now() - last > requiredHours * 60 * 60 * 1000) {
      throw new ConflictException(`Audit prune requires a successful backup within ${requiredHours}h`);
    }
  }

  private async finishPruneJob(
    job: AuditPruneJob,
    patch: Partial<Pick<AuditPruneJob, 'status' | 'archivedPath' | 'archiveChecksum' | 'deletedCount' | 'error'>>,
  ): Promise<AuditPruneJob> {
    const finished: AuditPruneJob = {
      ...job,
      ...patch,
      finishedAt: nowIso(),
      deletedCount: patch.deletedCount ?? job.deletedCount,
      archivedPath: patch.archivedPath ?? job.archivedPath,
      archiveChecksum: patch.archiveChecksum ?? job.archiveChecksum,
      error: patch.error ?? job.error,
      status: patch.status ?? job.status,
    };
    await this.persistPruneJob(finished);
    return finished;
  }

  private async persistPruneJob(job: AuditPruneJob): Promise<void> {
    await this.setJson(AUDIT_LAST_PRUNE_JOB_SETTINGS_KEY, job);
  }

  private async getJson<T>(key: string): Promise<T | null> {
    const rows = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].value) as T;
    } catch {
      return null;
    }
  }

  private async setJson(key: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    const existing = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    if (existing.length > 0) {
      await this.db.update(settings).set({ value: json }).where(eq(settings.key, key));
    } else {
      await this.db.insert(settings).values({ key, value: json });
    }
  }
}
