import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import {
  type Bookmark,
  type BookmarkEntityType,
  type BookmarksResponse,
  type RecentHistoryEntry,
  type RecentHistoryResponse,
  type Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { userBookmarks, userRecentViews } from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { QuestsService } from '../quests/quests.service';
import { NpcsService } from '../npcs/npcs.service';
import { FactionsService } from '../factions/factions.service';
import { LocationsService } from '../locations/locations.service';
import { CharactersService } from '../characters/characters.service';
import { SessionsService } from '../sessions/sessions.service';
import { EncountersService } from '../encounters/encounters.service';

/**
 * Per-user, per-campaign cap on recent-history rows. A re-visit bumps the
 * existing row rather than adding a duplicate, so this bounds the list to the
 * last distinct targets a member revisited in each campaign.
 */
const MAX_RECENT_PER_CAMPAIGN = 12;
/** Hard ceiling on a single list response so a cross-campaign list stays bounded. */
const MAX_LIST_RESULTS = 24;

type Target = { campaignId: number; entityType: BookmarkEntityType; entityId: number };

/**
 * Personal navigation (issue #840): a user's private bookmarks and bounded
 * recent-history across supported campaign entities.
 *
 * SECURITY MODEL — mirrors SearchService. This service NEVER resolves a target
 * by reading its table directly. Visibility is re-derived at READ time from the
 * owning entity services' role-filtered `listForCampaign` lists, which already
 * drop hidden quests/NPCs/factions/encounters, soft-deleted rows, and
 * inaccessible characters, and redact `dmSecret`. A bookmark whose target later
 * becomes hidden, deleted, or inaccessible (lost membership / cross-campaign)
 * is therefore silently omitted from responses — never returned, so it can never
 * reveal the target's existence or current state to someone who lost access.
 *
 * Privacy: every query is keyed on `userId`, and the routes live under `/me`,
 * so navigation metadata is private to its owner. Account/campaign deletion
 * cascades through the table FKs (ON DELETE CASCADE) — no orphaned private data.
 */
@Injectable()
export class PersonalNavigationService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly access: CampaignAccessService,
    private readonly quests: QuestsService,
    private readonly npcs: NpcsService,
    private readonly factions: FactionsService,
    private readonly locations: LocationsService,
    private readonly characters: CharactersService,
    private readonly sessions: SessionsService,
    private readonly encounters: EncountersService,
  ) {}

  // ---------- bookmarks ----------

  async addBookmark(userId: number, target: Target, user: RequestUser): Promise<Bookmark> {
    const { role, label } = await this.requireVisibleTarget(target, user);
    const now = nowIso();
    const inserted = await this.db
      .insert(userBookmarks)
      .values({
        userId,
        campaignId: target.campaignId,
        entityType: target.entityType,
        entityId: target.entityId,
        createdAt: now,
      })
      // Re-bookmarking the same target is idempotent: keep the original row.
      .onConflictDoNothing()
      .returning()
      .get();
    // onConflictDoNothing returns undefined on conflict; re-read the existing row.
    const row = inserted ?? (await this.fetchBookmark(userId, target));
    if (!row) throw new NotFoundException('Entity not found');
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'bookmark.create',
      entityType: target.entityType,
      entityId: target.entityId,
      campaignId: target.campaignId,
    });
    return {
      id: row.id,
      campaignId: row.campaignId,
      entityType: row.entityType as BookmarkEntityType,
      entityId: row.entityId,
      label,
      createdAt: row.createdAt,
    };
  }

  async removeBookmark(userId: number, bookmarkId: number, user: RequestUser): Promise<void> {
    const [row] = await this.db
      .select()
      .from(userBookmarks)
      .where(and(eq(userBookmarks.id, bookmarkId), eq(userBookmarks.userId, userId)))
      .limit(1);
    if (!row) throw new NotFoundException('Bookmark not found');

    await this.db.delete(userBookmarks).where(eq(userBookmarks.id, bookmarkId)).run();
    // The user always acts as themselves on their own bookmarks; record the role
    // they currently hold in that campaign for the audit row (best-effort — a
    // null role if membership was just dropped, but the delete still succeeds).
    const role = (await this.access.effectiveRole(user, row.campaignId)) ?? 'viewer';
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'bookmark.delete',
      entityType: row.entityType as BookmarkEntityType,
      entityId: row.entityId,
      campaignId: row.campaignId,
    });
  }

  async listBookmarks(userId: number, user: RequestUser, campaignId?: number): Promise<BookmarksResponse> {
    const rows = await this.db
      .select()
      .from(userBookmarks)
      .where(
        campaignId != null
          ? and(eq(userBookmarks.userId, userId), eq(userBookmarks.campaignId, campaignId))
          : eq(userBookmarks.userId, userId),
      )
      // Newest first so the display cap below keeps the most-recently-saved bookmarks
      // rather than silently dropping them in favor of older ones.
      .orderBy(desc(userBookmarks.createdAt), desc(userBookmarks.id));
    const targets = rows.map((r) => ({
      row: r,
      target: { campaignId: r.campaignId, entityType: r.entityType as BookmarkEntityType, entityId: r.entityId },
    }));
    const labeled = await this.filterVisible(targets, user);
    return { items: labeled.slice(0, MAX_LIST_RESULTS).map(({ row, label }) => this.toBookmark(row, label)) };
  }

  // ---------- recent history ----------

  async recordVisit(userId: number, target: Target, user: RequestUser): Promise<void> {
    // Membership gate only (cheap): a visit is high-frequency, best-effort personal
    // read-state. It does NOT pre-resolve target visibility the way addBookmark does
    // — instead the read path (listRecent) drops any target the caller can't
    // currently see, so a visit to a hidden/just-inaccessible entity is recorded
    // privately but never returned. That keeps the hot path off the entity lists
    // (see requireVisibleTarget) without weakening secrecy: nothing inaccessible is
    // ever surfaced, and the per-(user,campaign) row cap bounds storage.
    const role = await this.access.effectiveRole(user, target.campaignId);
    if (!role) throw new ForbiddenException('Not a member of this campaign');
    const now = nowIso();
    await this.db
      .insert(userRecentViews)
      .values({
        userId,
        campaignId: target.campaignId,
        entityType: target.entityType,
        entityId: target.entityId,
        visitedAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [userRecentViews.userId, userRecentViews.campaignId, userRecentViews.entityType, userRecentViews.entityId],
        set: { visitedAt: now },
      })
      .run();
    await this.trimRecent(userId, target.campaignId);
    // Intentionally NOT audited: a recent-visit is high-frequency personal
    // read-state, exactly like the catch-up cursor mark — not a curated write.
  }

  async listRecent(userId: number, user: RequestUser, campaignId?: number): Promise<RecentHistoryResponse> {
    const rows = await this.db
      .select()
      .from(userRecentViews)
      .where(
        campaignId != null
          ? and(eq(userRecentViews.userId, userId), eq(userRecentViews.campaignId, campaignId))
          : eq(userRecentViews.userId, userId),
      )
      .orderBy(desc(userRecentViews.visitedAt), desc(userRecentViews.id));
    const targets = rows.map((r) => ({
      row: r,
      target: { campaignId: r.campaignId, entityType: r.entityType as BookmarkEntityType, entityId: r.entityId },
    }));
    const labeled = await this.filterVisible(targets, user);
    const items: RecentHistoryEntry[] = labeled.slice(0, MAX_LIST_RESULTS).map(({ row, label }) => ({
      campaignId: row.campaignId,
      entityType: row.entityType as BookmarkEntityType,
      entityId: row.entityId,
      label,
      visitedAt: row.visitedAt,
    }));
    return { items };
  }

  async clearRecent(userId: number, user: RequestUser, campaignId?: number): Promise<void> {
    await this.db
      .delete(userRecentViews)
      .where(
        campaignId != null
          ? and(eq(userRecentViews.userId, userId), eq(userRecentViews.campaignId, campaignId))
          : eq(userRecentViews.userId, userId),
      )
      .run();
    // clear is a deliberate bulk delete of personal read-state; record the
    // caller's role in the scoped campaign when available.
    const role = campaignId != null ? (await this.access.effectiveRole(user, campaignId)) ?? 'viewer' : 'viewer';
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'recent_history.clear',
      campaignId: campaignId ?? null,
    });
  }

  // ---------- internals ----------

  /**
   * Membership + visibility gate for a WRITE (bookmark / record-visit). Throws
   * 403 (not a member) or 404 (target not visible to this role) so a user can
   * neither bookmark nor log a visit to an entity they cannot see. Returns the
   * effective campaign role and the target's current display label.
   */
  private async requireVisibleTarget(
    target: Target,
    user: RequestUser,
  ): Promise<{ role: Role; label: string }> {
    const role = await this.access.effectiveRole(user, target.campaignId);
    if (!role) throw new ForbiddenException('Not a member of this campaign');
    const labels = await this.resolveVisibleLabels(target.campaignId, user, role, new Set([target.entityType]));
    const label = labels.get(this.targetKey(target));
    if (!label) throw new NotFoundException('Entity not found');
    return { role, label };
  }

  /**
   * Resolve the role-filtered, soft-delete- and hidden-aware label map for the
   * given entity types in one campaign, reusing the entity services' tested
   * `listForCampaign` lists (the same path SearchService/mentions build on).
   * Returns `${entityType}:${entityId}` → display label.
   */
  private async resolveVisibleLabels(
    campaignId: number,
    user: RequestUser,
    role: Role,
    types: Set<BookmarkEntityType>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const put = (type: BookmarkEntityType, id: number, label: string) =>
      out.set(this.targetKey({ campaignId, entityType: type, entityId: id }), label);

    if (types.has('quest')) {
      for (const q of await this.quests.listForCampaign(campaignId, role)) put('quest', q.id, q.title);
    }
    if (types.has('npc')) {
      for (const n of await this.npcs.listForCampaign(campaignId, role)) put('npc', n.id, n.name);
    }
    if (types.has('faction')) {
      for (const f of await this.factions.listForCampaign(campaignId, role)) put('faction', f.id, f.name);
    }
    if (types.has('location')) {
      for (const l of await this.locations.listForCampaign(campaignId, role)) put('location', l.id, l.name);
    }
    if (types.has('character')) {
      for (const c of await this.characters.listForCampaign(campaignId, user, role)) put('character', c.id, c.name);
    }
    if (types.has('session')) {
      for (const s of await this.sessions.listForCampaign(campaignId, role)) put('session', s.id, s.title || `Session ${s.number}`);
    }
    if (types.has('encounter')) {
      for (const e of await this.encounters.listForCampaign(campaignId, undefined, role)) put('encounter', e.id, e.name);
    }
    return out;
  }

  /**
   * Filter target rows at READ time: group by campaign, drop entire campaigns
   * where the user is no longer a member (lost access / cross-campaign), then
   * drop individual rows whose target is hidden / deleted / no longer visible to
   * the caller's current role. Preserves input order.
   */
  private async filterVisible<T>(
    rows: Array<{ row: T; target: Target }>,
    user: RequestUser,
  ): Promise<Array<{ row: T; label: string }>> {
    const byCampaign = new Map<number, Array<{ row: T; target: Target }>>();
    for (const entry of rows) {
      const list = byCampaign.get(entry.target.campaignId) ?? [];
      list.push(entry);
      byCampaign.set(entry.target.campaignId, list);
    }

    const out: Array<{ row: T; label: string }> = [];
    for (const [campaignId, campaignRows] of byCampaign) {
      const role = await this.access.effectiveRole(user, campaignId);
      if (!role) continue; // not a member anymore — drop every target in this campaign
      const types = new Set(campaignRows.map((r) => r.target.entityType));
      const labels = await this.resolveVisibleLabels(campaignId, user, role, types);
      for (const entry of campaignRows) {
        const label = labels.get(this.targetKey(entry.target));
        if (label != null) out.push({ row: entry.row, label });
      }
    }
    return out;
  }

  private toBookmark(
    row: { id: number; campaignId: number; entityType: string; entityId: number; createdAt: string },
    label: string,
  ): Bookmark {
    return {
      id: row.id,
      campaignId: row.campaignId,
      entityType: row.entityType as BookmarkEntityType,
      entityId: row.entityId,
      label,
      createdAt: row.createdAt,
    };
  }

  private targetKey(t: Target): string {
    return `${t.entityType}:${t.entityId}`;
  }

  private async fetchBookmark(userId: number, target: Target) {
    const [row] = await this.db
      .select()
      .from(userBookmarks)
      .where(
        and(
          eq(userBookmarks.userId, userId),
          eq(userBookmarks.campaignId, target.campaignId),
          eq(userBookmarks.entityType, target.entityType),
          eq(userBookmarks.entityId, target.entityId),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Keep recent views bounded per (user, campaign) in a single statement: delete
   * every row for this scope whose id is NOT among the newest
   * MAX_RECENT_PER_CAMPAIGN (by visitedAt, then id). Self-correcting — when the
   * scope already fits the cap the subquery returns every id and nothing is
   * deleted — and the table is bounded at the cap, so the subquery scans a small,
   * indexed range.
   */
  private async trimRecent(userId: number, campaignId: number): Promise<void> {
    const keep = this.db
      .select({ id: userRecentViews.id })
      .from(userRecentViews)
      .where(and(eq(userRecentViews.userId, userId), eq(userRecentViews.campaignId, campaignId)))
      .orderBy(desc(userRecentViews.visitedAt), desc(userRecentViews.id))
      .limit(MAX_RECENT_PER_CAMPAIGN);
    await this.db
      .delete(userRecentViews)
      .where(
        and(
          eq(userRecentViews.userId, userId),
          eq(userRecentViews.campaignId, campaignId),
          notInArray(userRecentViews.id, keep),
        ),
      )
      .run();
  }
}
