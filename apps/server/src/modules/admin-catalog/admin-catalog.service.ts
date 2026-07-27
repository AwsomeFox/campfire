import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type {
  CampaignCatalogBulkItemResult,
  CampaignCatalogBulkRequest,
  CampaignCatalogBulkResult,
  CampaignCatalogEntry,
  CampaignCatalogPage,
  CampaignCatalogPrivacy,
  CampaignCatalogPrivacyPolicy,
  CampaignCatalogPrivacyPolicyUpdate,
  CampaignCatalogPrivacySetting,
  CampaignCatalogSort,
  CampaignExportRequest,
  CampaignExportRequestPage,
  CampaignExportRequestDecision,
} from '@campfire/schema';
import { CAMPAIGN_CATALOG_DEFAULT_LIMIT, CAMPAIGN_CATALOG_MAX_LIMIT } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  campaignExportRequests,
  campaignMembers,
  campaigns,
  rulePacks,
  users,
} from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { auditActor, auditActorRole, type RequestUser } from '../../common/user.types';
import { nowIso } from '../../common/time';
import { clampListLimit } from '../../common/cursor-pagination';
import {
  CATALOG_CAMPAIGN_COLUMNS,
  CATALOG_PRIVACY_DEFAULTS,
  CATALOG_PRIVACY_SETTINGS_KEY,
  effectiveVisibility,
  nameSortExpression,
  redactedCampaignName,
  searchPredicate,
} from './catalog-projection';

/** Parsed, validated query for a catalog page. Every field becomes a real SQL predicate. */
export type CatalogQuery = {
  limit?: number;
  offset?: number;
  sort?: CampaignCatalogSort;
  order?: 'asc' | 'desc';
  q?: string;
  status?: 'active' | 'paused' | 'completed';
  ruleSystem?: string;
  packageVersion?: string;
  moduleInstalled?: boolean;
  primaryDmUserId?: number;
  nextSessionAfter?: string;
  nextSessionBefore?: string;
  activityAfter?: string;
  activityBefore?: string;
  minStorageBytes?: number;
  overQuota?: boolean;
  trashed?: boolean;
};

/** Actor identity for audit rows, resolved once per request. */
type Actor = { actor: string; actorRole: ReturnType<typeof auditActorRole> };

const COMMITTED = 'committed';

/**
 * Server-admin campaign metadata catalog (issue #587).
 *
 * THE PREMISE
 * -----------
 * A coordinator overseeing dozens of tables currently has to JOIN a campaign — gaining
 * full content visibility — merely to find it or archive it. This service gives them a
 * way to locate and administer a campaign WITHOUT being able to read it. That trade is
 * only honest if the second half actually holds, so every read here goes through the
 * enumerated projection in catalog-projection.ts and no method on this class ever
 * touches quests, notes, comments, attachments' names or bytes, session-zero, or any
 * `dm_secret` column. `admin-catalog.isolation.e2e-spec.ts` asserts that empirically by
 * seeding markers into all of them and grepping every response.
 *
 * REAL SQL, NOT IN-MEMORY FILTERING
 * ---------------------------------
 * The issue names `campaigns.service.ts` `listForUser` — `SELECT *` over every campaign
 * followed by a `Set.has` in JS — as the thing to not repeat. So pagination, search,
 * every filter, and every sort key here are SQL predicates over indexed columns, and
 * `total` is a real `COUNT(*)` over the same WHERE. The per-campaign aggregates
 * (attachment bytes, member counts, next session, last activity) are correlated
 * subqueries served by indexes that already exist: `idx_attachments_campaign_state`,
 * `idx_scheduled_sessions_campaign_at`, `idx_campaign_members_campaign`,
 * `idx_audit_log_campaign`. The only per-page JS work is resolving the primary DM for
 * the <=100 rows actually returned, which is one extra query, not N+1.
 */
@Injectable()
export class AdminCatalogService {
  private readonly logger = new Logger(AdminCatalogService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly events: CampaignEventsService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------------- privacy policy

  /** The server-wide disclosure default, merged over CATALOG_PRIVACY_DEFAULTS. */
  async getPrivacyPolicy(): Promise<CampaignCatalogPrivacyPolicy> {
    const stored = await this.settings.getJson<unknown>(CATALOG_PRIVACY_SETTINGS_KEY);
    const raw = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : null;
    const names = raw?.names === 'visible' || raw?.names === 'redacted' ? raw.names : undefined;
    const descriptions =
      raw?.descriptions === 'visible' || raw?.descriptions === 'redacted' ? raw.descriptions : undefined;
    return {
      names: names ?? CATALOG_PRIVACY_DEFAULTS.names,
      descriptions: descriptions ?? CATALOG_PRIVACY_DEFAULTS.descriptions,
      source: names === undefined && descriptions === undefined ? 'default' : 'settings',
    };
  }

  async updatePrivacyPolicy(
    update: CampaignCatalogPrivacyPolicyUpdate,
    actor: Actor,
  ): Promise<CampaignCatalogPrivacyPolicy> {
    const current = await this.getPrivacyPolicy();
    // A PARTIAL UPDATE MATERIALISES THE WHOLE POLICY, DELIBERATELY.
    //
    // Sending only `names` also persists the current `descriptions`, which pins it to
    // whatever it resolves to today — including a value that came from
    // CATALOG_PRIVACY_DEFAULTS rather than from an operator. A later change to those
    // defaults will then not reach this server. That is the intended trade and it is
    // the safe direction for a disclosure setting: an operator who has deliberately
    // configured what admins may read about every campaign on the server should not
    // have half of that decision silently re-decided by a future release. Freezing
    // what they saw when they chose is the conservative behaviour; drifting is not.
    //
    // The consequence a reader needs to know is that `source: 'settings'` after any
    // update means "an operator has configured this", not "an operator chose each
    // field individually". The audit detail below records both resolved values, so
    // the trail says what was actually stored rather than what was sent.
    const next = {
      names: update.names ?? current.names,
      descriptions: update.descriptions ?? current.descriptions,
    };
    await this.settings.setJson(CATALOG_PRIVACY_SETTINGS_KEY, next);
    const policy = await this.getPrivacyPolicy();

    // THE POLICY HAS COMMITTED, AND THIS IS THE WORST PLACE IN THE MODULE TO LIE ABOUT
    // THAT.
    //
    // Every other post-commit audit failure here made an operator retry work that had
    // already landed: annoying, recoverable, visible on the second attempt. This one is
    // different because of the direction the failure points. Letting the audit write
    // throw returned a 500 while the server-wide disclosure policy had ALREADY changed,
    // so on a `redacted` -> `visible` update:
    //
    //   - campaign names and descriptions are now exposed to every operator,
    //   - the console still shows the old policy and reports that saving FAILED, and
    //   - no audit row records that any of it happened.
    //
    // Nobody retries a privacy change that "failed" and then goes checking whether it
    // silently applied anyway. So the truthful persisted policy is returned and the
    // audit failure is made loud rather than fatal: the defect was the gap between what
    // is stored and what the operator is shown, and closing that gap IS the fix.
    //
    // Server-scoped row (campaignId null): this changes what EVERY operator can see
    // about EVERY campaign, which is exactly the kind of act the server-admin trail
    // exists for — and therefore exactly the kind whose absence is an incident.
    try {
      await this.audit.log({
        actor: actor.actor,
        actorRole: actor.actorRole,
        action: 'campaign.catalog.privacy.update',
        entityType: 'settings',
        detail: `names=${policy.names}, descriptions=${policy.descriptions}`,
      });
    } catch (err) {
      this.logger.error(
        `server catalog privacy policy changed to names=${policy.names}, ` +
          `descriptions=${policy.descriptions}, but its audit row failed to write — the ` +
          `change IS in effect and is unrecorded`,
        err instanceof Error ? err.stack : String(err),
      );
    }
    return policy;
  }

  // ---------------------------------------------------------------- catalog reads

  /**
   * One page of the catalog.
   *
   * Browsing is a privileged read, so the listing itself is audited (issue bullet 5
   * says "audit catalog access and operations", not just operations) — with the exact
   * slice recorded, so a reviewer can reconstruct what the operator actually saw
   * rather than merely that they looked. Post-commit and best-effort in the house
   * sense: the audit write happens after the reads, outside any transaction.
   */
  async listCatalog(user: RequestUser, query: CatalogQuery): Promise<CampaignCatalogPage> {
    const policy = await this.getPrivacyPolicy();
    const limit = clampListLimit(query.limit, CAMPAIGN_CATALOG_DEFAULT_LIMIT, CAMPAIGN_CATALOG_MAX_LIMIT);
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const sort: CampaignCatalogSort = query.sort ?? 'activity';
    const order: 'asc' | 'desc' = query.order ?? (sort === 'name' ? 'asc' : 'desc');

    const where = this.buildWhere(query, policy);
    const orderBy = this.buildOrderBy(sort, order, policy);

    const rows = await this.db
      .select({
        ...CATALOG_CAMPAIGN_COLUMNS,
        packName: rulePacks.name,
        packVersion: rulePacks.version,
        storageBytes: this.storageBytesExpr(),
        attachmentCount: this.attachmentCountExpr(),
        memberCount: this.memberCountExpr(),
        dmCount: this.dmCountExpr(),
        nextSessionAt: this.nextSessionExpr(),
        lastActivityAt: this.lastActivityExpr(),
      })
      .from(campaigns)
      .leftJoin(rulePacks, eq(rulePacks.slug, campaigns.ruleSystem))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);

    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(campaigns)
      .leftJoin(rulePacks, eq(rulePacks.slug, campaigns.ruleSystem))
      .where(where);

    const dms = await this.resolvePrimaryDms(rows.map((r) => r.id));
    const items = rows.map((row) => this.toEntry(row, policy, dms.get(row.id) ?? null));

    await this.audit.log({
      actor: auditActor(user),
      actorRole: auditActorRole(user),
      action: 'campaign.catalog.list',
      entityType: 'campaign',
      detail:
        `returned=${items.length}, total=${total}, limit=${limit}, offset=${offset}, ` +
        `sort=${sort}:${order}, filters=${this.describeFilters(query)}`,
    });

    return { items, total: Number(total), hasMore: offset + items.length < Number(total), limit, offset, sort, order };
  }

  /** One catalog row by id. Audited both server-scoped and campaign-scoped. */
  async getCatalogEntry(user: RequestUser, campaignId: number): Promise<CampaignCatalogEntry> {
    const policy = await this.getPrivacyPolicy();
    const rows = await this.db
      .select({
        ...CATALOG_CAMPAIGN_COLUMNS,
        packName: rulePacks.name,
        packVersion: rulePacks.version,
        storageBytes: this.storageBytesExpr(),
        attachmentCount: this.attachmentCountExpr(),
        memberCount: this.memberCountExpr(),
        dmCount: this.dmCountExpr(),
        nextSessionAt: this.nextSessionExpr(),
        lastActivityAt: this.lastActivityExpr(),
      })
      .from(campaigns)
      .leftJoin(rulePacks, eq(rulePacks.slug, campaigns.ruleSystem))
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    if (rows.length === 0) throw new NotFoundException('Campaign not found');
    const dms = await this.resolvePrimaryDms([campaignId]);
    const entry = this.toEntry(rows[0], policy, dms.get(campaignId) ?? null);

    const actor = auditActor(user);
    const actorRole = auditActorRole(user);
    // Campaign-scoped: the campaign's own trail must show that an outsider looked at
    // it. Mirrors the moderation break-glass double-write (#601) — the server-admin
    // trail excludes campaign rows, so one row alone would be invisible to one of the
    // two audiences.
    await this.audit.log({
      actor,
      actorRole,
      action: 'campaign.catalog.read',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
      detail: `metadata-only; nameRedacted=${entry.nameRedacted}, descriptionRedacted=${entry.descriptionRedacted}`,
    });
    await this.audit.log({
      actor,
      actorRole,
      action: 'campaign.catalog.read',
      entityType: 'campaign',
      entityId: campaignId,
      detail: `campaign=${campaignId}, metadata-only`,
    });
    return entry;
  }

  // ---------------------------------------------------------------- bulk lifecycle

  /**
   * Bulk lifecycle operations, with a dry run that defaults ON.
   *
   * ATOMICITY IS PER ITEM, DELIBERATELY. A single transaction around the whole batch
   * would mean one bad campaign rolls back 199 good ones; no transaction at all would
   * mean a half-applied batch plus a 500 and no record of where it stopped. So each
   * campaign is applied in its own transaction and reported individually, and the batch
   * as a whole always succeeds with a per-item verdict. (The route is a POST with no
   * `@HttpCode`, so that success status is Nest's default 201, which is what the e2e
   * specs assert — the point is that it is never a 500 that hides what applied.) The
   * operator learns exactly which items applied — that is what makes a partial outcome
   * recoverable instead of mysterious.
   *
   * A dry run performs the same reads and the same eligibility checks as the real run
   * and reports `would_apply` / `skipped` per item, so "nothing surprising here" is
   * something the operator can verify before typing `"dryRun": false`.
   */
  async bulk(user: RequestUser, req: CampaignCatalogBulkRequest): Promise<CampaignCatalogBulkResult> {
    this.validateBulkArgs(req);
    const actor = auditActor(user);
    const actorRole = auditActorRole(user);
    const results: CampaignCatalogBulkItemResult[] = [];

    // De-duplicate while preserving order: the same id twice in one batch would
    // otherwise produce two audit rows and a nonsensical "before → after" on the second.
    const ids = [...new Set(req.campaignIds)];

    for (const campaignId of ids) {
      try {
        results.push(await this.applyOne(campaignId, req, { actor, actorRole }));
      } catch (err) {
        // A single failing item never aborts the batch — see the method docblock.
        results.push({
          campaignId,
          outcome: 'failed',
          reason: err instanceof Error ? err.message.slice(0, 500) : 'unknown error',
          field: '',
          before: '',
          after: '',
        });
      }
    }

    const tally = (outcome: CampaignCatalogBulkItemResult['outcome']) =>
      results.filter((r) => r.outcome === outcome).length;
    const result: CampaignCatalogBulkResult = {
      operation: req.operation,
      dryRun: req.dryRun,
      requested: ids.length,
      wouldApply: tally('would_apply'),
      applied: tally('applied'),
      skipped: tally('skipped'),
      failed: tally('failed'),
      results,
    };

    // One server-scoped summary row for the batch itself. Dry runs are audited too:
    // enumerating which campaigns an operator is contemplating acting on is itself
    // worth a record, and it is cheap.
    //
    // Guarded for the same reason as the per-item write above. By the time this runs,
    // every campaign in the batch has already committed in its own transaction, and
    // `results` is the operator's ONLY record of which ones did. Letting a failure here
    // propagate would turn a fully-applied batch into a 500 with no body — the operator
    // then cannot tell what landed, and re-running is unsafe precisely because some of
    // it did. The summary is a convenience for the audit trail; the per-item verdicts
    // are the thing that must survive.
    try {
      await this.audit.log({
        actor,
        actorRole,
        action: req.dryRun ? 'campaign.catalog.bulk.dryrun' : 'campaign.catalog.bulk',
        entityType: 'campaign',
        detail:
          `op=${req.operation}, requested=${result.requested}, applied=${result.applied}, ` +
          `wouldApply=${result.wouldApply}, skipped=${result.skipped}, failed=${result.failed}` +
          (req.reason ? `, reason=${req.reason.slice(0, 300)}` : ''),
      });
    } catch (err) {
      this.logger.error(
        `bulk ${req.operation} completed (applied=${result.applied}, skipped=${result.skipped}, ` +
          `failed=${result.failed}) but its summary audit row failed to write`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    return result;
  }

  private validateBulkArgs(req: CampaignCatalogBulkRequest): void {
    switch (req.operation) {
      case 'reassign_owner':
        if (req.toUserId === undefined) throw new BadRequestException('`toUserId` is required for reassign_owner');
        break;
      case 'set_quota':
        if (req.storageQuotaBytes === undefined) {
          throw new BadRequestException('`storageQuotaBytes` is required for set_quota (use null to clear)');
        }
        break;
      case 'set_policy':
        if (req.publicInvitesEnabled === undefined && req.aiExternalContentPolicy === undefined) {
          throw new BadRequestException(
            '`publicInvitesEnabled` and/or `aiExternalContentPolicy` is required for set_policy',
          );
        }
        // THE CATALOG MAY CLOSE PUBLIC INVITES, NEVER OPEN THEM.
        //
        // `InvitesService.setPolicy` refuses to enable public invites unless the
        // campaign is active and untrashed, precisely so that a restore or unarchive
        // can never leave invite links live without a deliberate post-restore
        // reactivation. Writing `publicInvitesEnabled` straight to the column here
        // sidesteps that: arming the flag on a paused campaign is silent until someone
        // runs `activate`, whose status change deliberately preserves the flag — and
        // every retained link goes live in the same instant.
        //
        // Rather than copy that precondition into a second file (where it would drift
        // from the original), the catalog simply cannot express the state the invites
        // service would refuse. That is also the right product answer: opening a
        // campaign to public joiners is a capability GRANT, and this feature's premise
        // is that an operator gets lifecycle control over campaigns they cannot read,
        // not the power to hand out access to them. Closing invites is the containment
        // action an operator legitimately needs, and it stays available.
        //
        // Rejected here rather than skipped per item because the constraint does not
        // depend on any campaign: the request is malformed for every id in the batch,
        // so an API client should learn that from a 400, not by reading 200 skips.
        if (req.publicInvitesEnabled === true) {
          throw new BadRequestException(
            'set_policy can disable public invites but cannot enable them; a DM re-enables invites ' +
              'on an active campaign via PUT /campaigns/:id/invites/policy',
          );
        }
        break;
      case 'update_module':
        if (!req.ruleSystem) throw new BadRequestException('`ruleSystem` is required for update_module');
        break;
      case 'request_export':
        // A justification is not optional: the operator is asking a DM to hand over a
        // bundle containing every secret in their campaign. `reason` carries it.
        if (!req.reason || req.reason.trim().length < 10) {
          throw new BadRequestException('`reason` of at least 10 characters is required for request_export');
        }
        break;
      default:
        break;
    }
  }

  /** Apply (or dry-run) one campaign, in its own transaction. */
  private async applyOne(
    campaignId: number,
    req: CampaignCatalogBulkRequest,
    actor: Actor,
  ): Promise<CampaignCatalogBulkItemResult> {
    const skip = (reason: string): CampaignCatalogBulkItemResult => ({
      campaignId,
      outcome: 'skipped',
      reason,
      field: '',
      before: '',
      after: '',
    });

    const [row] = await this.db
      .select({
        id: campaigns.id,
        status: campaigns.status,
        ruleSystem: campaigns.ruleSystem,
        storageQuotaBytes: campaigns.storageQuotaBytes,
        publicInvitesEnabled: campaigns.publicInvitesEnabled,
        aiExternalContentPolicy: campaigns.aiExternalContentPolicy,
        deletedAt: campaigns.deletedAt,
      })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    if (!row) return skip('campaign not found');
    // A trashed campaign is on its way out; lifecycle edits to it would resurrect
    // confusion rather than resolve it. Restoring is a separate, deliberate act.
    if (row.deletedAt) return skip('campaign is in the trash');

    const plan = await this.planChange(row, req, actor);
    if (plan === null) return skip('already in the requested state');
    if (typeof plan === 'string') return skip(plan);

    if (req.dryRun) {
      return { campaignId, outcome: 'would_apply', reason: '', ...plan.summary };
    }

    plan.apply();

    // Live-update notifications for the write that just committed. Guarded for the same
    // reason the audit write below is: this runs AFTER the change is durable, so a
    // failing emit must not relabel committed work as `failed` and send an operator to
    // retry it. A missed event costs a stale browser until the next reload; a false
    // `failed` costs a double-applied lifecycle change.
    try {
      plan.afterCommit?.();
    } catch (err) {
      this.logger.error(
        `campaign.catalog.${req.operation} applied to campaign ${campaignId} but its ` +
          `post-commit notification failed`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    // THE WRITE HAS COMMITTED. Everything below is record-keeping, and record-keeping
    // must not be able to relabel a committed change as a failure. If this audit write
    // throws, the campaign really has been archived/paused/requoted — reporting the
    // item as `failed` would send the operator to retry an operation that already
    // happened, which for a non-idempotent op is how a batch gets applied twice.
    // So the outcome stays `applied` and the audit failure is carried in `reason`.
    let auditNote = '';
    try {
      await this.audit.log({
        actor: actor.actor,
        actorRole: actor.actorRole,
        action: `campaign.catalog.${req.operation}`,
        entityType: 'campaign',
        entityId: campaignId,
        campaignId,
        detail:
          `${plan.summary.field}: ${plan.summary.before} -> ${plan.summary.after}` +
          (req.reason ? ` (${req.reason.slice(0, 300)})` : ''),
      });
    } catch (err) {
      // Surfaced, never swallowed: an unaudited admin action is itself an incident.
      this.logger.error(
        `campaign.catalog.${req.operation} applied to campaign ${campaignId} but its audit row failed to write`,
        err instanceof Error ? err.stack : String(err),
      );
      auditNote = 'applied, but the audit row could not be written';
    }

    return { campaignId, outcome: 'applied', reason: auditNote, ...plan.summary };
  }

  /**
   * Decide what one operation would do to one campaign.
   *
   * Returns `null` for a no-op, a string for "skip with this reason", or a plan whose
   * `apply()` performs the whole change inside a single transaction.
   */
  private async planChange(
    row: {
      id: number;
      status: string;
      ruleSystem: string;
      storageQuotaBytes: number | null;
      publicInvitesEnabled: boolean;
      aiExternalContentPolicy: string;
    },
    req: CampaignCatalogBulkRequest,
    actor: Actor,
  ): Promise<
    | null
    | string
    | {
        summary: { field: string; before: string; after: string };
        apply: () => void;
        /**
         * Side effects that must happen AFTER the transaction commits — currently the
         * live-update events the owning services emit for the same writes. Kept off
         * `apply()` on purpose: emitting inside the transaction would announce a change
         * that a rollback then un-does.
         */
        afterCommit?: () => void;
      }
  > {
    const ts = nowIso();
    const id = row.id;

    const statusChange = (next: 'active' | 'paused' | 'completed') => {
      if (row.status === next) return null;
      return {
        summary: { field: 'status', before: row.status, after: next },
        apply: () => {
          this.db.transaction((tx) => {
            // Moving a campaign out of `active` also closes public invites, mirroring
            // the DM-facing update path in campaigns.service.ts — an archived campaign
            // that still accepts new joiners via a live link is the inconsistency that
            // migration 0059 exists to prevent. Both writes are in one transaction, so
            // the pair can never half-apply.
            tx.update(campaigns)
              .set({
                status: next,
                ...(next === 'active' ? {} : { publicInvitesEnabled: false }),
                updatedAt: ts,
              })
              .where(eq(campaigns.id, id))
              .run();
          });
        },
      };
    };

    switch (req.operation) {
      case 'archive':
        return statusChange('completed');
      case 'pause':
        return statusChange('paused');
      case 'activate':
        return statusChange('active');

      case 'set_quota': {
        const next = req.storageQuotaBytes ?? null;
        if ((row.storageQuotaBytes ?? null) === next) return null;
        return {
          summary: {
            field: 'storageQuotaBytes',
            before: row.storageQuotaBytes === null ? 'unset' : String(row.storageQuotaBytes),
            after: next === null ? 'unset' : String(next),
          },
          apply: () => {
            this.db.transaction((tx) => {
              tx.update(campaigns).set({ storageQuotaBytes: next, updatedAt: ts }).where(eq(campaigns.id, id)).run();
            });
          },
        };
      }

      case 'set_policy': {
        const changes: string[] = [];
        const set: Record<string, unknown> = { updatedAt: ts };
        if (req.publicInvitesEnabled !== undefined && req.publicInvitesEnabled !== row.publicInvitesEnabled) {
          set.publicInvitesEnabled = req.publicInvitesEnabled;
          changes.push(`publicInvitesEnabled=${row.publicInvitesEnabled}->${req.publicInvitesEnabled}`);
        }
        if (
          req.aiExternalContentPolicy !== undefined &&
          req.aiExternalContentPolicy !== row.aiExternalContentPolicy
        ) {
          set.aiExternalContentPolicy = req.aiExternalContentPolicy;
          changes.push(`aiExternalContentPolicy=${row.aiExternalContentPolicy}->${req.aiExternalContentPolicy}`);
        }
        if (changes.length === 0) return null;
        return {
          summary: { field: 'policy', before: '', after: changes.join(' ') },
          apply: () => {
            this.db.transaction((tx) => {
              tx.update(campaigns).set(set).where(eq(campaigns.id, id)).run();
            });
          },
        };
      }

      case 'update_module': {
        const next = req.ruleSystem ?? '';
        if (row.ruleSystem === next) return null;
        // Refuse to pin a campaign to a pack this server cannot serve. The operation
        // exists to FIX the "campaign points at a missing module" condition the catalog
        // surfaces; letting it create that condition would be perverse.
        const [pack] = await this.db
          .select({ slug: rulePacks.slug })
          .from(rulePacks)
          .where(eq(rulePacks.slug, next))
          .limit(1);
        if (!pack) return `rule pack '${next}' is not installed on this server`;
        return {
          summary: { field: 'ruleSystem', before: row.ruleSystem || 'unset', after: next },
          apply: () => {
            this.db.transaction((tx) => {
              tx.update(campaigns).set({ ruleSystem: next, updatedAt: ts }).where(eq(campaigns.id, id)).run();
            });
          },
        };
      }

      case 'reassign_owner': {
        const toUserId = req.toUserId as number;
        const [target] = await this.db
          .select({ id: users.id, username: users.username, disabled: users.disabled })
          .from(users)
          .where(eq(users.id, toUserId))
          .limit(1);
        if (!target) return `user ${toUserId} not found`;
        if (target.disabled) return `user ${toUserId} is disabled`;

        const existing = await this.db
          .select({
            id: campaignMembers.id,
            userId: campaignMembers.userId,
            primaryOwner: campaignMembers.primaryOwner,
            role: campaignMembers.role,
          })
          .from(campaignMembers)
          .where(eq(campaignMembers.campaignId, id));
        const currentOwner = existing.find((m) => m.primaryOwner);
        if (currentOwner?.userId === toUserId) return null;

        // Only for the notification below, and only sent to the incoming OWNER — who by
        // the time it is delivered holds a dm seat on this campaign and may read far more
        // than its name. This is not a widening of the catalog's projection.
        const [campaignRow] = await this.db
          .select({ name: campaigns.name })
          .from(campaigns)
          .where(eq(campaigns.id, id))
          .limit(1);
        const campaignName = campaignRow?.name ?? '';

        const existingSeat = existing.find((m) => m.userId === toUserId);
        // The seat id the event carries. Known up front when a seat already exists;
        // filled in from the INSERT when one does not, which is why it is a `let`.
        let eventMemberId = existingSeat?.id ?? 0;

        return {
          summary: {
            field: 'primaryOwner',
            before: currentOwner ? String(currentOwner.userId) : 'none',
            after: String(toUserId),
          },
          apply: () => {
            this.db.transaction((tx) => {
              // Demote the incumbent, then install the new owner — as one unit, so the
              // campaign is never left with two primary owners or none.
              tx.update(campaignMembers)
                .set({ primaryOwner: false, updatedAt: ts })
                .where(eq(campaignMembers.campaignId, id))
                .run();
              if (existingSeat) {
                tx.update(campaignMembers)
                  .set({ role: 'dm', primaryOwner: true, updatedAt: ts })
                  .where(eq(campaignMembers.id, existingSeat.id))
                  .run();
              } else {
                const inserted = tx
                  .insert(campaignMembers)
                  .values({
                    campaignId: id,
                    userId: toUserId,
                    role: 'dm',
                    primaryOwner: true,
                    createdAt: ts,
                    updatedAt: ts,
                  })
                  .returning({ id: campaignMembers.id })
                  .all();
                eventMemberId = inserted[0]?.id ?? 0;
              }
            });
          },
          // TELL THE NEW OWNER'S OPEN BROWSERS, THE WAY MembersService DOES.
          //
          // `MembersService.update` emits `membership.updated` on a role change so the
          // affected member's tabs invalidate their cached /me memberships immediately
          // (issue #437) — promote gains DM nav, demote drops forbidden controls. This
          // path writes the seat directly and emitted nothing, so a user promoted to
          // owner kept rendering player-only navigation and could not reach DM settings
          // until they happened to reload.
          //
          // Same sibling-pair root cause as the `set_policy` finding: the bulk path
          // writing a column that another service owns. There the state itself was
          // illegitimate, so the fix was to make it inexpressible; here the state is
          // perfectly legitimate and only the announcement was missing, so the fix is to
          // announce it.
          //
          // Emitted when the seat did not already carry `dm`, which covers both the
          // promotion of an existing player seat and a newly inserted one. An existing
          // dm seat merely gaining `primaryOwner` is deliberately silent — the member's
          // ROLE is unchanged, nothing in the cached /me differs, and MembersService is
          // equally quiet in that case.
          //
          // EVERY PROMOTED TARGET NEEDS THE ACCOUNT-WIDE SIGNAL, NOT JUST A NEW SEAT.
          //
          // The first version of this fix sent the account-wide notification only for a
          // newly INSERTED seat, reasoning that an existing member "already had the
          // campaign in their /me, so the SSE event reaches them". That conflates being
          // a MEMBER with being a LISTENER — which is the exact confusion the original
          // defect was built from, surviving inside the branch the fix declared safe.
          //
          // `CampaignEventsService.streamFor` filters by campaignId, and the client
          // subscribes only for the campaign it is currently VIEWING. A player promoted
          // to owner while looking at a different campaign (or at no campaign) has no
          // subscriber for this event either. Membership is necessary for the
          // subscription, not sufficient for it to be open.
          //
          // So both branches now signal. Self-suppression on reassign-to-self is
          // orthogonal and kept: `actor.actor` is `String(users.id)` for a real account,
          // matching the rule `notifyUser` applies when handed a RequestUser. Done here
          // because `planChange` carries the audit Actor rather than the RequestUser.
          //
          // KNOWN GAP, MEASURED NOT ASSUMED: this notification updates the notification
          // UI and does NOT by itself refresh AuthProvider's /me memberships. The only
          // client path that refreshes them is `useMembershipLiveSync`, which is driven
          // by the campaign SSE stream and therefore carries the same viewing
          // requirement. There is no account-wide push channel on the server at all —
          // the sole `@Sse()` endpoint is campaign-scoped and notifications are polled.
          // Closing that last step means teaching a shared auth/notification surface to
          // refresh `/me` when a membership-affecting notification arrives, which is a
          // change outside this module. Tracked separately; see the PR body.
          afterCommit:
            existingSeat?.role === 'dm'
              ? undefined
              : () => {
                  this.events.emit({
                    type: 'membership.updated',
                    campaignId: id,
                    userId: String(toUserId),
                    memberId: eventMemberId,
                    role: 'dm',
                  });
                  if (actor.actor !== String(toUserId)) {
                    // Best-effort inside NotificationsService, and awaited by nobody:
                    // `afterCommit` is sync by design (see the plan type) and a
                    // notification must never delay or fail a committed lifecycle change.
                    void this.notifications.notifyUser(toUserId, id, null, {
                      type: 'added_to_campaign',
                      title: `You were made the owner of ${campaignName || 'a campaign'}`,
                      entityType: 'campaign',
                      entityId: id,
                    });
                  }
                },
        };
      }

      case 'request_export': {
        const profile = req.exportProfile ?? 'backup';
        const [pending] = await this.db
          .select({ id: campaignExportRequests.id })
          .from(campaignExportRequests)
          .where(
            and(eq(campaignExportRequests.campaignId, id), eq(campaignExportRequests.status, 'pending')),
          )
          .limit(1);
        if (pending) return 'an export request is already pending for this campaign';
        // The column is documented as "numeric user id as text when the requester was a
        // real account; '' otherwise", so test for that directly rather than excluding
        // the one decorated prefix we happen to remember. `auditActor` returns a bare
        // `String(users.id)` for a real account, but `token:<name>` on the PAT path and
        // `dev:<name>` on the header-auth path — and only the first of those was being
        // filtered, so a dev-auth principal wrote `dev:alice` into a column every reader
        // is entitled to treat as an id. Any future actor shape is now excluded by
        // construction instead of by enumeration.
        const requestedByUserId = /^\d+$/.test(actor.actor) ? actor.actor : '';
        const justification = (req.reason ?? '').slice(0, 2000);
        return {
          summary: { field: 'exportRequest', before: 'none', after: `pending(${profile})` },
          apply: () => {
            this.db.transaction((tx) => {
              // THE INSERT CARRIES THE ONE-PENDING-REQUEST RULE, NOT JUST THE PRE-CHECK.
              //
              // The check above is a read with an await before this write, so two
              // concurrent `request_export` calls both saw no pending row and both got
              // here — leaving the campaign with duplicate pending asks and both batches
              // reporting `applied`. Same read-then-write race the decision path had,
              // one step earlier in the workflow.
              //
              // `INSERT … SELECT … WHERE NOT EXISTS` re-tests the rule inside the single
              // statement that performs the write, so SQLite evaluates it atomically and
              // no interleaving can slip between the test and the insert. Chosen over a
              // partial unique index because it needs no DDL and no migration ordinal:
              // the rule lives in the statement that enforces it, exactly as the
              // decision fix put it in the UPDATE predicate.
              const inserted = tx.run(sql`
                INSERT INTO campaign_export_requests
                  (campaign_id, requested_by, requested_by_user_id, profile, justification,
                   status, decision_note, created_at, updated_at)
                SELECT ${id}, ${actor.actor}, ${requestedByUserId}, ${profile}, ${justification},
                       'pending', '', ${ts}, ${ts}
                WHERE NOT EXISTS (
                  SELECT 1 FROM campaign_export_requests
                  WHERE campaign_id = ${id} AND status = 'pending'
                )
              `);

              // Zero rows means another request won the race between the pre-check and
              // here. Throwing rolls this transaction back and surfaces the item as
              // `failed` with this reason, rather than reporting `applied` for a row
              // that was never written.
              if (inserted.changes === 0) {
                throw new Error('an export request is already pending for this campaign');
              }
            });
          },
        };
      }

      default:
        return `unsupported operation`;
    }
  }

  // ---------------------------------------------------------------- export requests

  /**
   * Admin view of export requests. Status and timestamps only — never an artifact.
   *
   * PAGED, AND AUDITED. This previously returned a bare array capped at
   * CAMPAIGN_CATALOG_MAX_LIMIT with no offset and no total, so above that cap it
   * silently truncated: requests raised on other campaigns pushed older pending ones out
   * of the only listing that spans campaigns, and an operator could not enumerate the
   * queue without already knowing every affected campaign id — which is precisely what
   * the cross-campaign view exists to avoid. A pending approval nobody can see is an
   * approval that never happens.
   *
   * The audit row is not decoration either. This module's docblock makes "catalog
   * BROWSING is audited, not just mutations" an explicit guarantee, and this read
   * discloses requester justifications and DM decision notes — other people's stated
   * reasons, which is exactly the content that guarantee exists to cover. Every other
   * catalog read records one; this one did not.
   */
  async listExportRequests(
    user: RequestUser,
    opts: { campaignId?: number; limit?: number; offset?: number } = {},
  ): Promise<CampaignExportRequestPage> {
    const limit = clampListLimit(opts.limit, CAMPAIGN_CATALOG_DEFAULT_LIMIT, CAMPAIGN_CATALOG_MAX_LIMIT);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const where = opts.campaignId === undefined ? undefined : eq(campaignExportRequests.campaignId, opts.campaignId);

    const rows = await this.db
      .select()
      .from(campaignExportRequests)
      .where(where)
      .orderBy(desc(campaignExportRequests.id))
      .limit(limit)
      .offset(offset);

    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(campaignExportRequests)
      .where(where);

    const items = rows.map((r) => this.toExportRequest(r));
    const actor = auditActor(user);
    const actorRole = auditActorRole(user);
    const slice = `returned=${items.length}, total=${total}, limit=${limit}, offset=${offset}`;

    // THE SERVER-ADMIN ROW IS UNCONDITIONAL. THE CAMPAIGN ROW IS THE EXTRA ONE.
    //
    // This previously wrote a single row whose scope depended on the query string:
    // `campaignId: opts.campaignId ?? null`. `AuditService.listServerAdmin` returns only
    // rows WHERE campaign_id IS NULL, so the unfiltered read landed in the server-admin
    // trail and the FILTERED one vanished from it — exactly backwards, since reading the
    // export requests of one named campaign is the more targeted act, not the less
    // accountable one.
    //
    // Follows `getCatalogEntry`'s double-write (itself following the moderation
    // break-glass pattern in #601) rather than inventing a third convention: the
    // server-admin trail always records that an operator read this listing, and when the
    // read was scoped to a campaign that campaign's OWN trail additionally records that
    // an outsider looked at its export requests. Two audiences, two rows, neither able
    // to hide the act from the other.
    await this.audit.log({
      actor,
      actorRole,
      action: 'campaign.catalog.export_requests.list',
      entityType: 'campaign_export_request',
      detail: slice + (opts.campaignId === undefined ? ', scope=all-campaigns' : `, campaign=${opts.campaignId}`),
    });
    if (opts.campaignId !== undefined) {
      await this.audit.log({
        actor,
        actorRole,
        action: 'campaign.catalog.export_requests.list',
        entityType: 'campaign_export_request',
        campaignId: opts.campaignId,
        detail: slice,
      });
    }

    return {
      items,
      total: Number(total),
      hasMore: offset + items.length < Number(total),
      limit,
      offset,
    };
  }

  /**
   * The DM-facing inbox for one campaign.
   *
   * Deliberately NOT routed through `listExportRequests`: that method writes a
   * server-admin audit row, and a DM reading the asks addressed to their own campaign is
   * not an operator browsing the catalog. Recording it as one would put DMs in the
   * server-admin trail and misattribute a routine act as a privileged read. Bounded by a
   * single campaign's own history, so it needs no paging.
   */
  async listExportRequestsForCampaign(campaignId: number): Promise<CampaignExportRequest[]> {
    const rows = await this.db
      .select()
      .from(campaignExportRequests)
      .where(eq(campaignExportRequests.campaignId, campaignId))
      .orderBy(desc(campaignExportRequests.id))
      .limit(CAMPAIGN_CATALOG_MAX_LIMIT);
    return rows.map((r) => this.toExportRequest(r));
  }

  /**
   * A DM approves or denies an operator's export request.
   *
   * Approving grants NOTHING to the requester by itself — it records the DM's consent.
   * Producing the bundle remains the existing DM-gated `GET /campaigns/:id/export`
   * route, run by a DM. That separation is what stops "request export" from becoming a
   * one-call bypass of the entire catalog premise: a campaign export carries every
   * quest, note, session-zero line and dmSecret there is, and no admin route in this
   * module returns one.
   */
  async decideExportRequest(
    requestId: number,
    decision: CampaignExportRequestDecision,
    user: RequestUser,
    campaignId: number,
  ): Promise<CampaignExportRequest> {
    const [row] = await this.db
      .select()
      .from(campaignExportRequests)
      .where(eq(campaignExportRequests.id, requestId))
      .limit(1);
    if (!row) throw new NotFoundException('Export request not found');
    if (row.campaignId !== campaignId) throw new NotFoundException('Export request not found');
    if (row.status !== 'pending') {
      throw new BadRequestException(`Export request is already ${row.status}`);
    }

    const ts = nowIso();
    const actor = auditActor(user);
    // THE PREDICATE CARRIES THE PRECONDITION, NOT JUST THE ID.
    //
    // The status check above is a read, and there is an `await` between it and this
    // write. Two DMs deciding the same request concurrently both pass that check; if the
    // update matched on id alone, both would succeed, both would write audit rows, and
    // the LAST WRITE would silently decide whether consent was granted — behind an audit
    // trail that contradicts itself. Consent is exactly the wrong thing to settle by
    // write ordering.
    //
    // Re-stating `campaign_id` and `status = 'pending'` here makes the update unable to
    // match a row that has already been decided, so the loser changes nothing and is
    // told so. Same shape as the fix in #1039: a predicate that cannot match a stale
    // state, rather than a check that can go stale across an await.
    const [updated] = await this.db
      .update(campaignExportRequests)
      .set({
        status: decision.decision,
        decidedBy: actor,
        decidedAt: ts,
        decisionNote: decision.note.slice(0, 2000),
        updatedAt: ts,
      })
      .where(
        and(
          eq(campaignExportRequests.id, requestId),
          eq(campaignExportRequests.campaignId, campaignId),
          eq(campaignExportRequests.status, 'pending'),
        ),
      )
      .returning();

    // Zero rows means another DM decided it in the gap. Returning success here would
    // hand this DM the OTHER DM's decision as though it were their own, so it is
    // surfaced. 409 rather than the 400 the pre-check raises: a sequential double-decide
    // is a malformed request, this is a genuine concurrent conflict, and someone reading
    // a contradictory trail later benefits from being able to tell them apart.
    if (!updated) {
      throw new ConflictException('Another DM decided this export request first');
    }

    // THE DECISION HAS COMMITTED. Everything below is record-keeping, and record-keeping
    // must not be able to turn a recorded consent decision into a reported failure.
    //
    // Same shape as the bulk path's per-item write, and the consequence is sharper here
    // because this is CONSENT. A DM who approved an export and is handed a 500 either
    // approves again — and is refused with "already decided" — or concludes it did not
    // happen. Both leave them wrong about whether their campaign's data is now
    // exportable, which is the one thing this workflow exists to make unambiguous.
    //
    // Atomicity is not available without restructuring AuditService: `log()` writes
    // through its own db handle and cannot join a transaction opened here. So the
    // truthful decision state is returned and the audit failure is made loud rather than
    // fatal. The two mirrors are attempted independently so one failing cannot suppress
    // the other — a partial trail beats no trail when reconstructing who consented.
    const auditMirrors: Array<[string, Parameters<AuditService['log']>[0]]> = [
      [
        'campaign',
        {
          actor,
          actorRole: 'dm',
          action: `campaign.export_request.${decision.decision}`,
          entityType: 'campaign_export_request',
          entityId: requestId,
          campaignId,
          detail: `profile=${row.profile}, requestedBy=${row.requestedBy || 'server-admin'}`,
        },
      ],
      // Server-scoped mirror so the operator who asked can see the answer in the
      // server-admin trail, which excludes campaign rows.
      [
        'server-admin',
        {
          actor,
          actorRole: 'dm',
          action: `campaign.export_request.${decision.decision}`,
          entityType: 'campaign_export_request',
          entityId: requestId,
          detail: `campaign=${campaignId}, profile=${row.profile}`,
        },
      ],
    ];

    for (const [mirror, entry] of auditMirrors) {
      try {
        await this.audit.log(entry);
      } catch (err) {
        // Surfaced, never swallowed: an unaudited consent decision is itself an incident.
        this.logger.error(
          `export request ${requestId} for campaign ${campaignId} was ${decision.decision}, ` +
            `but its ${mirror} audit row failed to write`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return this.toExportRequest(updated);
  }

  // ---------------------------------------------------------------- per-campaign opt-out

  /** What a DM sees about their own campaign's catalog exposure. */
  async getCampaignPrivacy(campaignId: number): Promise<CampaignCatalogPrivacySetting> {
    const [row] = await this.db
      .select({ id: campaigns.id, catalogPrivacy: campaigns.catalogPrivacy })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    if (!row) throw new NotFoundException('Campaign not found');
    const policy = await this.getPrivacyPolicy();
    const privacy = this.normalizePrivacy(row.catalogPrivacy);
    return {
      campaignId,
      catalogPrivacy: privacy,
      serverDefault: policy,
      effective: effectiveVisibility(policy, privacy),
    };
  }

  /**
   * A DM sets their own campaign's opt-out.
   *
   * Reachable ONLY from the campaign-scoped, DM-gated route — deliberately not from any
   * admin bulk operation. An opt-out that the party it protects against can clear is
   * decorative, so `set_policy` in the bulk enum cannot touch this column, and there is
   * no admin route that writes it.
   */
  async setCampaignPrivacy(
    campaignId: number,
    next: CampaignCatalogPrivacy,
    user: RequestUser,
  ): Promise<CampaignCatalogPrivacySetting> {
    const ts = nowIso();
    const [row] = await this.db
      .update(campaigns)
      .set({ catalogPrivacy: next, updatedAt: ts })
      .where(eq(campaigns.id, campaignId))
      .returning({ id: campaigns.id, catalogPrivacy: campaigns.catalogPrivacy });
    if (!row) throw new NotFoundException('Campaign not found');

    // Same shape and same reasoning as `updatePrivacyPolicy`, one scope down. The write
    // above has committed, so throwing here would tell a DM their opt-out did not save
    // while it had — and on a `redacted` -> `inherit` change that means the campaign's
    // name and description are disclosed to operators again, with the settings card
    // still showing "withheld" and no audit row saying otherwise.
    //
    // The direction is what makes it urgent: a DM who believes their withholding failed
    // will not go back and verify that it silently succeeded in the opposite direction.
    try {
      await this.audit.log({
        actor: auditActor(user),
        actorRole: 'dm',
        action: 'campaign.catalog.privacy.set',
        entityType: 'campaign',
        entityId: campaignId,
        campaignId,
        detail: `catalogPrivacy=${next}`,
      });
    } catch (err) {
      this.logger.error(
        `campaign ${campaignId} catalog privacy changed to ${next} but its audit row ` +
          `failed to write — the change IS in effect and is unrecorded`,
        err instanceof Error ? err.stack : String(err),
      );
    }
    // Re-read rather than echo: what the DM is shown must be what is stored.
    return this.getCampaignPrivacy(campaignId);
  }

  // ---------------------------------------------------------------- internals

  private normalizePrivacy(raw: string | null | undefined): CampaignCatalogPrivacy {
    return raw === 'redacted' ? 'redacted' : 'inherit';
  }

  /** Committed attachment bytes. Bytes only — never a filename, never a mime type. */
  private storageBytesExpr(): SQL<number> {
    return sql<number>`(SELECT COALESCE(SUM(a.size), 0) FROM attachments a
      WHERE a.campaign_id = ${campaigns.id} AND a.state = ${COMMITTED})`;
  }

  private attachmentCountExpr(): SQL<number> {
    return sql<number>`(SELECT COUNT(*) FROM attachments a
      WHERE a.campaign_id = ${campaigns.id} AND a.state = ${COMMITTED})`;
  }

  private memberCountExpr(): SQL<number> {
    return sql<number>`(SELECT COUNT(*) FROM campaign_members m WHERE m.campaign_id = ${campaigns.id})`;
  }

  private dmCountExpr(): SQL<number> {
    return sql<number>`(SELECT COUNT(*) FROM campaign_members m
      WHERE m.campaign_id = ${campaigns.id} AND m.role = 'dm')`;
  }

  /**
   * Earliest still-scheduled FUTURE session. A timestamp and nothing else — the
   * scheduled_sessions row also carries title, location and notes, all of which are
   * campaign content and none of which are read here.
   */
  private nextSessionExpr(): SQL<string | null> {
    return sql<string | null>`(SELECT MIN(s.scheduled_at) FROM scheduled_sessions s
      WHERE s.campaign_id = ${campaigns.id} AND s.status = 'scheduled' AND s.scheduled_at >= ${nowIso()})`;
  }

  /**
   * Freshest of the campaign row's own updated_at and its newest audit entry. Audit
   * TIMESTAMPS only — never an action, entity, actor or detail, all of which describe
   * what happened inside the campaign. ISO-8601 sorts lexically, so SQLite's two-arg
   * scalar max() is the right comparison.
   *
   * WHAT COUNTS AS ACTIVITY: writes, not reads.
   *
   * Every campaign-scoped audit row used to count, which made this an observer effect —
   * opening a dormant campaign's single-entry view wrote `campaign.catalog.read` against
   * that campaign and bumped its `lastActivityAt`, floating it to the top of the default
   * `activity` sort and into `activityAfter` filters. Self-reinforcing (the campaigns you
   * looked at look active, so they stay in front of you) and asymmetric (the LIST read is
   * server-scoped and never did this, only the per-entry read did). "Recently active"
   * drifted toward meaning "recently administered" rather than "recently played", which
   * is close to the inverse of what an operator hunting dormant tables needs.
   *
   * So catalog READS are excluded and everything else is kept. Administrative WRITES —
   * `campaign.catalog.archive`/`pause`/`activate`/`set_quota`/`set_policy`/
   * `update_module`, the export-request decisions, the DM's own privacy opt-out — all
   * still count, because those genuinely changed the campaign and an operator triaging it
   * should see that. So does every audit row written by every other module, which is the
   * real signal this column exists to surface.
   *
   * The exclusion is an explicit list rather than a `LIKE` pattern on purpose: a pattern
   * such as `%.list` or `%.read` would silently swallow a future WRITE action that
   * happened to be named that way, and this rule is one whose failure is invisible —
   * nobody notices a timestamp that is quietly too old. Adding a catalog read action
   * means adding it here, in the same commit, or the observer effect comes back.
   *
   * Both entries are campaign-scoped reads written by this module; `campaign.catalog.list`
   * and `moderation.admin.list` are server-scoped (campaign_id NULL) and so were never
   * part of this subquery in the first place.
   */
  private lastActivityExpr(): SQL<string | null> {
    return sql<string | null>`MAX(${campaigns.updatedAt},
      COALESCE((SELECT MAX(al.created_at) FROM audit_log al
        WHERE al.campaign_id = ${campaigns.id}
          AND al.action NOT IN ('campaign.catalog.read', 'campaign.catalog.export_requests.list')), ''))`;
  }

  private buildWhere(query: CatalogQuery, policy: CampaignCatalogPrivacyPolicy): SQL | undefined {
    const clauses: SQL[] = [];

    // Trashed campaigns are excluded unless explicitly requested — the catalog is an
    // operational view of live tables, and a purge queue is a different job.
    clauses.push(query.trashed ? isNotNull(campaigns.deletedAt) : isNull(campaigns.deletedAt));

    if (query.status) clauses.push(eq(campaigns.status, query.status));
    if (query.ruleSystem !== undefined) clauses.push(eq(campaigns.ruleSystem, query.ruleSystem));
    if (query.packageVersion !== undefined) clauses.push(eq(rulePacks.version, query.packageVersion));
    if (query.moduleInstalled !== undefined) {
      clauses.push(
        query.moduleInstalled
          ? sql`${rulePacks.slug} IS NOT NULL`
          : sql`(${campaigns.ruleSystem} <> '' AND ${rulePacks.slug} IS NULL)`,
      );
    }
    if (query.primaryDmUserId !== undefined) {
      // THE FILTER MUST ASK THE SAME QUESTION THE PROJECTION ANSWERS.
      //
      // This used to be `EXISTS (… m.user_id = ? AND m.role = 'dm')`, i.e. "is this user
      // ANY dm on the campaign". But `resolvePrimaryDms` picks exactly ONE seat per
      // campaign to fill the `primaryDm` column. So filtering by a secondary DM returned
      // rows whose displayed primary DM was somebody else — one parameter name answering
      // two different questions, agreeing only on single-DM campaigns.
      //
      // Comparing against the selected seat rather than testing membership leaves one
      // definition of "primary DM" instead of two that drift. The ordering here is the
      // SAME rule `resolvePrimaryDms` applies (is_primary_owner first, then oldest seat); if
      // either changes both must, and the e2e regression pins their agreement rather than
      // trusting this comment to keep them in step.
      // The INNER JOIN on `users` is not decoration. `resolvePrimaryDms` joins users to
      // build the column, so a dm seat whose user row is missing produces NO primaryDm
      // at all. Without the same join here, such a campaign matched the filter while
      // displaying a null primary DM — the two definitions disagreeing on a real case
      // rather than a hypothetical one. Mirroring the join makes "no user row" mean the
      // same thing on both sides.
      clauses.push(
        sql`(SELECT m.user_id FROM campaign_members m
          INNER JOIN users u ON u.id = m.user_id
          WHERE m.campaign_id = ${campaigns.id} AND m.role = 'dm'
          ORDER BY m.is_primary_owner DESC, m.id ASC
          LIMIT 1) = ${query.primaryDmUserId}`,
      );
    }
    // NULL-EXCLUDING ON PURPOSE, AND ASYMMETRICALLY SO. `nextSessionExpr()` is NULL for a
    // campaign with nothing scheduled ahead of now, and SQL comparisons against NULL do
    // not match — so EITHER bound drops every unscheduled campaign.
    //
    // For `nextSessionAfter` ("scheduled after X") that is plainly right. For
    // `nextSessionBefore` it is the defensible reading but not the only one: an operator
    // asking "whose next session is before Friday" is often really asking "what needs
    // attention soon", and campaigns with NOTHING scheduled are arguably the most
    // attention-worthy rows of all — yet they are precisely what this excludes.
    //
    // Kept excluding because the parameter names a bound on a DATE, and inventing a
    // convention where a missing date sorts as "urgent" would make the two bounds
    // asymmetric in a way no operator could predict from the names. "Campaigns with no
    // next session" is a genuinely different query and deserves its own explicit filter
    // rather than being smuggled in as a side effect of a date range.
    if (query.nextSessionAfter) clauses.push(gte(this.nextSessionExpr(), query.nextSessionAfter));
    if (query.nextSessionBefore) clauses.push(lte(this.nextSessionExpr(), query.nextSessionBefore));
    if (query.activityAfter) clauses.push(gte(this.lastActivityExpr(), query.activityAfter));
    if (query.activityBefore) clauses.push(lte(this.lastActivityExpr(), query.activityBefore));
    if (query.minStorageBytes !== undefined) clauses.push(gte(this.storageBytesExpr(), query.minStorageBytes));
    if (query.overQuota !== undefined) {
      const over = sql`(${campaigns.storageQuotaBytes} IS NOT NULL
        AND ${this.storageBytesExpr()} > ${campaigns.storageQuotaBytes})`;
      clauses.push(query.overQuota ? over : sql`NOT ${over}`);
    }

    const search = searchPredicate(query.q, policy);
    if (search) clauses.push(search);

    return clauses.length === 0 ? undefined : and(...clauses);
  }

  private buildOrderBy(
    sort: CampaignCatalogSort,
    order: 'asc' | 'desc',
    policy: CampaignCatalogPrivacyPolicy,
  ): SQL[] {
    const dir = order === 'asc' ? asc : desc;
    // `campaigns.id` is appended to every sort as a tiebreaker: without it, rows with
    // equal aggregates (storage bytes, identical timestamps) have no defined order and
    // OFFSET paging can repeat or skip them between pages.
    const tiebreak = asc(campaigns.id);
    switch (sort) {
      case 'name':
        return [dir(nameSortExpression(policy.names === 'visible')), tiebreak];
      case 'status':
        return [dir(campaigns.status), tiebreak];
      case 'storage':
        return [dir(this.storageBytesExpr()), tiebreak];
      case 'nextSession':
        return [dir(this.nextSessionExpr()), tiebreak];
      case 'created':
        return [dir(campaigns.createdAt), tiebreak];
      case 'id':
        return [dir(campaigns.id)];
      case 'activity':
      default:
        return [dir(this.lastActivityExpr()), tiebreak];
    }
  }

  /**
   * Primary DM per campaign for the rows on this page — ONE query, not N+1.
   * Prefers the seat flagged `is_primary_owner`; falls back to the lowest-id dm seat so
   * an operator always has somebody to contact.
   */
  private async resolvePrimaryDms(
    campaignIds: number[],
  ): Promise<Map<number, { userId: number; displayName: string; username: string; primaryOwner: boolean }>> {
    const out = new Map<number, { userId: number; displayName: string; username: string; primaryOwner: boolean }>();
    if (campaignIds.length === 0) return out;

    const rows = await this.db
      .select({
        campaignId: campaignMembers.campaignId,
        userId: campaignMembers.userId,
        primaryOwner: campaignMembers.primaryOwner,
        seatId: campaignMembers.id,
        username: users.username,
        displayName: users.displayName,
      })
      .from(campaignMembers)
      .innerJoin(users, eq(users.id, campaignMembers.userId))
      .where(and(inArray(campaignMembers.campaignId, campaignIds), eq(campaignMembers.role, 'dm')))
      .orderBy(desc(campaignMembers.primaryOwner), asc(campaignMembers.id));

    for (const row of rows) {
      if (out.has(row.campaignId)) continue; // ordering above already put the best first
      out.set(row.campaignId, {
        userId: row.userId,
        displayName: row.displayName,
        username: row.username,
        primaryOwner: row.primaryOwner,
      });
    }
    return out;
  }

  /** Map one projected row + policy into the wire shape, applying redaction. */
  private toEntry(
    row: {
      id: number;
      name: string;
      description: string;
      status: string;
      catalogPrivacy: string;
      ruleSystem: string;
      sessionCount: number;
      storageQuotaBytes: number | null;
      publicInvitesEnabled: boolean;
      aiExternalContentPolicy: string;
      deletedAt: string | null;
      createdAt: string;
      updatedAt: string;
      packName: string | null;
      packVersion: string | null;
      storageBytes: number;
      attachmentCount: number;
      memberCount: number;
      dmCount: number;
      nextSessionAt: string | null;
      lastActivityAt: string | null;
    },
    policy: CampaignCatalogPrivacyPolicy,
    dm: { userId: number; displayName: string; username: string; primaryOwner: boolean } | null,
  ): CampaignCatalogEntry {
    const privacy = this.normalizePrivacy(row.catalogPrivacy);
    const visibility = effectiveVisibility(policy, privacy);
    const nameRedacted = visibility.names === 'redacted';
    const descriptionRedacted = visibility.descriptions === 'redacted';
    const storageBytes = Number(row.storageBytes ?? 0);
    const status = (['active', 'paused', 'completed'] as const).includes(row.status as 'active')
      ? (row.status as 'active' | 'paused' | 'completed')
      : 'active';

    return {
      id: row.id,
      name: nameRedacted ? redactedCampaignName(row.id) : row.name,
      nameRedacted,
      // A redacted description gets NO placeholder: unlike a name, nothing operational
      // depends on having a stand-in, so the honest answer is to send nothing.
      description: descriptionRedacted ? '' : row.description,
      descriptionRedacted,
      catalogPrivacy: privacy,
      status,
      archived: status !== 'active',
      trashed: row.deletedAt !== null,
      module: {
        slug: row.ruleSystem,
        name: row.packName ?? '',
        version: row.packVersion ?? '',
        installed: row.packName !== null,
      },
      primaryDm: dm
        ? {
            userId: dm.userId,
            displayName: dm.displayName,
            username: dm.username,
            primaryOwner: dm.primaryOwner,
          }
        : null,
      memberCount: Number(row.memberCount ?? 0),
      dmCount: Number(row.dmCount ?? 0),
      sessionCount: row.sessionCount,
      nextSessionAt: row.nextSessionAt ?? null,
      lastActivityAt: row.lastActivityAt || null,
      storageBytes,
      attachmentCount: Number(row.attachmentCount ?? 0),
      storageQuotaBytes: row.storageQuotaBytes,
      overQuota: row.storageQuotaBytes !== null && storageBytes > row.storageQuotaBytes,
      publicInvitesEnabled: row.publicInvitesEnabled,
      aiExternalContentPolicy: row.aiExternalContentPolicy === 'disabled' ? 'disabled' : 'member_consent',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toExportRequest(row: typeof campaignExportRequests.$inferSelect): CampaignExportRequest {
    const status = (['pending', 'approved', 'denied', 'cancelled'] as const).includes(row.status as 'pending')
      ? (row.status as CampaignExportRequest['status'])
      : 'pending';
    return {
      id: row.id,
      campaignId: row.campaignId,
      requestedBy: row.requestedBy,
      requestedByUserId: row.requestedByUserId,
      profile: row.profile,
      justification: row.justification,
      status,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
      decisionNote: row.decisionNote,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Compact, reviewable rendering of the filters that produced an audited page. */
  private describeFilters(query: CatalogQuery): string {
    const parts: string[] = [];
    if (query.q) parts.push(`q=${query.q.slice(0, 80)}`);
    if (query.status) parts.push(`status=${query.status}`);
    if (query.ruleSystem !== undefined) parts.push(`ruleSystem=${query.ruleSystem}`);
    if (query.packageVersion !== undefined) parts.push(`version=${query.packageVersion}`);
    if (query.moduleInstalled !== undefined) parts.push(`moduleInstalled=${query.moduleInstalled}`);
    if (query.primaryDmUserId !== undefined) parts.push(`dm=${query.primaryDmUserId}`);
    if (query.nextSessionAfter) parts.push(`nextSessionAfter=${query.nextSessionAfter}`);
    if (query.nextSessionBefore) parts.push(`nextSessionBefore=${query.nextSessionBefore}`);
    if (query.activityAfter) parts.push(`activityAfter=${query.activityAfter}`);
    if (query.activityBefore) parts.push(`activityBefore=${query.activityBefore}`);
    if (query.minStorageBytes !== undefined) parts.push(`minStorageBytes=${query.minStorageBytes}`);
    if (query.overQuota !== undefined) parts.push(`overQuota=${query.overQuota}`);
    if (query.trashed) parts.push('trashed=true');
    return parts.length === 0 ? 'none' : parts.join(' ');
  }
}
