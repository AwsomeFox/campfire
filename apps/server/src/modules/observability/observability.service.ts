import { Inject, Injectable } from '@nestjs/common';
import { desc, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { AdminMetrics } from '@campfire/schema';
import { APP_COMMIT, APP_VERSION } from '../../common/build-metadata';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  apiTokens,
  attachments,
  auditLog,
  campaigns,
  characters,
  encounters,
  locations,
  notes,
  npcs,
  quests,
  ruleEntries,
  rulePacks,
  sessions,
  userSessions,
  users,
} from '../../db/schema';


// How many recent audit rows the dashboard shows. Kept small — this is a
// glanceable "recent activity" strip, not the full audit trail (that lives in
// the audit module and is read per-campaign there).
const RECENT_ACTIVITY_LIMIT = 15;

/**
 * Admin observability (issue #22). Computes a cheap server-wide operational
 * snapshot for the admin dashboard: entity counts, on-disk DB size, uptime,
 * version, and a short recent-activity strip.
 *
 * Every query here is O(1)-ish for SQLite: COUNT(*) hits the table's rowid
 * index, and DB size comes from PRAGMA page_count/page_size (metadata, no scan).
 * The recent-activity read is a plain ORDER BY ... LIMIT on audit_log — it does
 * NOT go through the audit module (issue #23/#74 owns that); it only reads the
 * table, never writes or alters audit internals.
 */
@Injectable()
export class ObservabilityService {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  async getMetrics(): Promise<z.infer<typeof AdminMetrics>> {
    const nowMs = Date.now();
    const uptimeSeconds = process.uptime();

    const [
      usersCount,
      campaignsCount,
      charactersCount,
      npcsCount,
      locationsCount,
      questsCount,
      sessionsCount,
      notesCount,
      encountersCount,
      attachmentsCount,
      apiTokensCount,
      rulePacksCount,
      ruleEntriesCount,
      activeSessions,
    ] = await Promise.all([
      this.countRows(users),
      this.countRows(campaigns),
      this.countRows(characters),
      this.countRows(npcs),
      this.countRows(locations),
      this.countRows(quests),
      this.countRows(sessions),
      this.countRows(notes),
      this.countRows(encounters),
      this.countRows(attachments),
      this.countRows(apiTokens),
      this.countRows(rulePacks),
      this.countRows(ruleEntries),
      this.countActiveSessions(new Date(nowMs).toISOString()),
    ]);

    const database = this.databaseSize();
    const recentActivity = await this.recentActivity();

    return {
      version: APP_VERSION,
      ...(APP_COMMIT ? { commit: APP_COMMIT } : {}),
      now: new Date(nowMs).toISOString(),
      startedAt: new Date(nowMs - Math.round(uptimeSeconds * 1000)).toISOString(),
      uptimeSeconds,
      activeSessions,
      counts: {
        users: usersCount,
        campaigns: campaignsCount,
        characters: charactersCount,
        npcs: npcsCount,
        locations: locationsCount,
        quests: questsCount,
        sessions: sessionsCount,
        notes: notesCount,
        encounters: encountersCount,
        attachments: attachmentsCount,
        apiTokens: apiTokensCount,
        rulePacks: rulePacksCount,
        ruleEntries: ruleEntriesCount,
      },
      database,
      recentActivity,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async countRows(table: any): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)` }).from(table);
    return Number(row?.n ?? 0);
  }

  private async countActiveSessions(nowIso: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(userSessions)
      .where(sql`${userSessions.expiresAt} > ${nowIso}`);
    return Number(row?.n ?? 0);
  }

  private databaseSize(): z.infer<typeof AdminMetrics>['database'] {
    // PRAGMA reads are metadata lookups — no table scan. Reported through
    // drizzle's raw get() so we don't need to reach for the underlying handle.
    const pageCountRow = this.db.get<{ page_count: number }>(sql`PRAGMA page_count`);
    const pageSizeRow = this.db.get<{ page_size: number }>(sql`PRAGMA page_size`);
    const pageCount = Number(pageCountRow?.page_count ?? 0);
    const pageSize = Number(pageSizeRow?.page_size ?? 0);
    return { pageCount, pageSize, sizeBytes: pageCount * pageSize };
  }

  private async recentActivity(): Promise<z.infer<typeof AdminMetrics>['recentActivity']> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(RECENT_ACTIVITY_LIMIT);
    return rows.map((r) => ({
      id: r.id,
      campaignId: r.campaignId ?? null,
      // audit_log.actorRole is a free-text column; the AuditEntry contract types
      // it as AuditActorRole (dm/player/viewer + the 'admin' sentinel — issue #526,
      // so an admin's privileged action isn't misread as a low-priv viewer's).
      // Coerce defensively so a stray value can never make the whole snapshot fail
      // to parse.
      actorRole: (['dm', 'player', 'viewer', 'admin'].includes(r.actorRole)
        ? r.actorRole
        : 'viewer') as 'dm' | 'player' | 'viewer' | 'admin',
      actor: r.actor,
      action: r.action,
      entityType: r.entityType ?? null,
      entityId: r.entityId ?? null,
      detail: r.detail,
      createdAt: r.createdAt,
    }));
  }
}
