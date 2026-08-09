import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type {
  CampaignCatalogBulkItemResult,
  CampaignCatalogBulkOperation,
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
import {
  CAMPAIGN_CATALOG_DEFAULT_LIMIT,
  CAMPAIGN_CATALOG_MAX_LIMIT,
  CAMPAIGN_CATALOG_NO_OP_REASON,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  campaignExportRequests,
  campaignMembers,
  campaigns,
  rulePacks,
  settings,
  users,
} from '../../db/schema';
import { clearDerivedEquippedActionsIn } from '../inventory/derived-action-cleanup';
import { AuditService, type AuditLogParams } from '../audit/audit.service';
import { auditBestEffort } from '../audit/audit-best-effort';
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
const RESERVED = 'reserved';

/**
 * The campaign columns every plan reads. Named so `PlanInput` can talk about it.
 */
type CampaignPlanRow = {
  id: number;
  /** Only ever used in a notification addressed to the incoming OWNER. Not a projection. */
  name: string;
  status: string;
  ruleSystem: string;
  storageQuotaBytes: number | null;
  publicInvitesEnabled: boolean;
  aiExternalContentPolicy: string;
  deletedAt: string | null;
  updatedAt: string;
};

type CampaignSeatRow = {
  id: number;
  userId: number;
  primaryOwner: boolean;
  role: string;
  updatedAt: string;
};

type CampaignExportRequestRow = {
  id: number;
  status: string;
  updatedAt: string;
};

/** The rule pack `update_module` would pin to — `null` when it is not installed here. */
type RulePackRow = { slug: string } | null;

/** The user `reassign_owner` would hand the campaign to — `null` when there is no such account. */
type TargetUserRow = { id: number; username: string; disabled: boolean } | null;

/**
 * The tables a bulk operation's plan is derived from.
 *
 * WHY THIS EXISTS AT ALL: the precondition that licenses Apply to skip re-showing the
 * plan has to cover every table the plan READS, not one convenient proxy for them.
 * `campaigns.updated_at` was that proxy, and it is wrong for two of the eight operations:
 *
 *  - `reassign_owner` plans from `campaign_members`. Nothing that writes a seat touches
 *    `campaigns.updated_at`, so a previewed A -> B handover still "matched" after a
 *    second operator had already made C the owner. Apply then replanned against the new
 *    seat table and demoted C — a write nobody previewed, waved through by a guard
 *    reporting "unchanged".
 *  - `request_export` plans from `campaign_export_requests`. A previewed *skip* ("already
 *    pending") became a real INSERT once the DM denied that pending request, for the same
 *    reason. A skip is a plan too, and this is exactly the class of silent upgrade the
 *    guard was added to stop.
 *
 * A guard that reports "unchanged" while the table it guards has changed is worse than no
 * guard, because Apply trusts it and stops asking the operator to look again.
 *
 * WHY DECLARED HERE RATHER THAN BUMPED AT EVERY WRITER: the alternative — advancing a
 * campaign version from every writer of every dependent table — needs writers outside
 * this module to participate, and its failure mode is silent (a new writer that forgets
 * simply reintroduces the bug, invisibly). This declaration is local and its failure mode
 * is a compile error: `PlanInput` hands each operation ONLY the rows it declares, so a
 * plan that reaches for an undeclared table does not typecheck, and `satisfies Record<…>`
 * makes a newly added operation with no declaration a compile error too.
 */
type CatalogDependency = 'campaign' | 'members' | 'exportRequests' | 'rulePack' | 'targetUser';

/** The rows each dependency contributes to a plan, and the shape a planner may read. */
type CatalogDependencyRows = {
  campaign: CampaignPlanRow;
  members: CampaignSeatRow[];
  exportRequests: CampaignExportRequestRow[];
  rulePack: RulePackRow;
  targetUser: TargetUserRow;
};

const OPERATION_DEPENDENCIES = {
  archive: ['campaign'],
  pause: ['campaign'],
  activate: ['campaign'],
  set_quota: ['campaign'],
  set_policy: ['campaign'],
  // `rule_packs` IS a dependency, and the argument for leaving it out was wrong twice
  // over. It said a pack's presence is server inventory that a concurrent catalog
  // operation cannot edit, and that re-planning against it could only turn a would_apply
  // into a skip. Both halves fail: packs are installed and removed by other admins on the
  // same server, and the dangerous direction is the REVERSE one. A preview that skipped
  // with "rule pack 'x' is not installed" becomes a real rule-system write the moment
  // somebody installs x — a skip promoted to a write, which is the precise failure this
  // guard exists to prevent, arriving through the table the guard was told to ignore.
  update_module: ['campaign', 'rulePack'],
  // `users` for the same reason: the plan reads `users.disabled`, so a target who is
  // disabled at preview (skipped) and re-enabled before Apply turns that skip into a live
  // ownership handover nobody previewed.
  reassign_owner: ['campaign', 'members', 'targetUser'],
  request_export: ['campaign', 'exportRequests'],
} as const satisfies Record<CampaignCatalogBulkOperation, readonly CatalogDependency[]>;

/**
 * The planner's whole view of the world, discriminated by operation so that
 * `switch (input.operation)` narrows the available rows to exactly the declared
 * dependencies — reading `input.members` from a case that did not declare `'members'` is
 * a type error, not a silently unguarded read.
 */
type PlanInput = {
  [Op in CampaignCatalogBulkOperation]: { operation: Op } & Pick<
    CatalogDependencyRows,
    (typeof OPERATION_DEPENDENCIES)[Op][number]
  >;
}[CampaignCatalogBulkOperation];

/** The transaction handle a plan writes through. It never opens its own. */
type CatalogTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * Anything the dependency reads can run against: the pooled handle for the first read,
 * the transaction handle for the revalidation inside the write.
 */
type CatalogReader = Pick<DrizzleDb, 'select'>;

/**
 * What a planner is allowed to reach besides its declared rows.
 *
 * Note what is ABSENT: any database handle. That absence is the mechanism — see
 * `planChange`.
 */
type PlanContext = {
  events: CampaignEventsService;
  notifications: NotificationsService;
};

/** A plan: what it would change, how to write it, and what to announce once it has. */
type CatalogPlan = {
  summary: { field: string; before: string; after: string };
  /**
   * Performs the change in the transaction it is HANDED. A plan that opened its own
   * transaction would commit outside the precondition check that licenses it.
   */
  apply: (tx: CatalogTx) => void;
  /**
   * Side effects that must happen AFTER the transaction commits — currently the
   * live-update events the owning services emit for the same writes. Kept off `apply()`
   * on purpose: emitting inside the transaction would announce a change that a rollback
   * then un-does.
   */
  afterCommit?: () => void;
};

/**
 * Raised when the state a plan was computed from moved before the write could commit.
 * Carries no reason of its own: the caller turns it into the same `skipped` verdict the
 * pre-transaction check produces, because it is the same condition caught later.
 */
class PlanWentStale extends Error {}

/**
 * Thrown by a plan's `apply()` when the write it guards turned out to be unnecessary —
 * the condition it would have skipped on became true between the plan and the write.
 * Reported as `skipped`, because the same condition must not produce two different
 * verdicts depending on whether it was hit sequentially or concurrently.
 */
class PlanBecameNoOp extends Error {}

/**
 * A bounded, order-independent digest of a row set, for the state version.
 *
 * Sorted because SQLite makes no ordering promise without an ORDER BY, and a version that
 * changed when the query planner changed its mind would force spurious re-previews.
 * Hashed because the version round-trips to the browser and back on every item of a
 * 200-campaign batch, and a campaign with hundreds of seats should not inflate it.
 */
function fingerprint(parts: string[]): string {
  return createHash('sha1').update(parts.sort().join('\n')).digest('hex');
}

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
    // ATOMIC READ-MERGE-WRITE. THE READ USES `tx`, AND THAT IS THE WHOLE POINT.
    //
    // This used to `await this.getPrivacyPolicy()`, merge in JS, then `await setJson`.
    // Two clients sending DISJOINT partial updates both read the same `current` before
    // either wrote, and each then replaced the WHOLE object — so a descriptions-only
    // update silently restored `names: visible` moments after another operator set it to
    // `redacted`. Last writer wins on a field they never mentioned.
    //
    // That is the worst-directed member of this module's post-commit family: the two
    // audit-failure defects told an operator a change had failed when it had landed;
    // this one silently UNDOES a privacy tightening that landed, and tells nobody. An
    // operator who redacts names and sees success has no reason to look again.
    //
    // Fixed by serialising rather than by demanding a complete policy. Requiring every
    // field would make the PUT more honest about being a replace, but it breaks existing
    // partial callers and pushes the merge onto clients who will each get it slightly
    // wrong — which is how this class of bug spreads rather than ends.
    //
    // `SettingsService` cannot join a caller's transaction (its methods are async over
    // their own handle, and `setJson` is itself a read-then-write), so the settings row
    // is touched directly here. Reading with `tx` INSIDE the synchronous better-sqlite3
    // transaction is what makes this atomic: an awaited read followed by a transactional
    // write would leave exactly the gap being closed — the mistake #1539 hit in
    // `updateSeries`. Nothing can interleave inside a sync transaction body, because
    // Node is single-threaded and there is no await in it.
    const policy = this.db.transaction((tx): CampaignCatalogPrivacyPolicy => {
      const rows = tx
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, CATALOG_PRIVACY_SETTINGS_KEY))
        .all();

      let stored: Record<string, unknown> | null = null;
      if (rows[0]) {
        try {
          const parsed: unknown = JSON.parse(rows[0].value);
          stored = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
          // A corrupt row reads as "no override", matching getPrivacyPolicy's tolerance.
          stored = null;
        }
      }
      const readField = (v: unknown) => (v === 'visible' || v === 'redacted' ? v : undefined);
      const currentNames = readField(stored?.names);
      const currentDescriptions = readField(stored?.descriptions);

      // A PARTIAL UPDATE STILL MATERIALISES THE WHOLE POLICY, DELIBERATELY — but now it
      // merges over the value read in this same transaction rather than one that may
      // already be stale. Sending only `names` also persists the current
      // `descriptions`, pinning it to today's value including one that came from
      // CATALOG_PRIVACY_DEFAULTS. That is the safe direction for a disclosure setting:
      // an operator who configured what admins may read should not have half of that
      // decision silently re-decided by a future release.
      const next = {
        names: update.names ?? currentNames ?? CATALOG_PRIVACY_DEFAULTS.names,
        descriptions: update.descriptions ?? currentDescriptions ?? CATALOG_PRIVACY_DEFAULTS.descriptions,
      };
      const json = JSON.stringify(next);
      if (rows[0]) {
        tx.update(settings).set({ value: json }).where(eq(settings.key, CATALOG_PRIVACY_SETTINGS_KEY)).run();
      } else {
        tx.insert(settings).values({ key: CATALOG_PRIVACY_SETTINGS_KEY, value: json }).run();
      }
      // Returned from inside the transaction: this is what THIS call committed. A later
      // writer may change it a moment afterwards, but reporting their value back to this
      // caller would be a different lie from the one just fixed.
      return { ...next, source: 'settings' };
    });

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
   * rather than merely that they looked.
   *
   * READS FAIL CLOSED. THAT IS THE OPPOSITE OF THE WRITE PATHS, AND DELIBERATELY SO.
   *
   * The audit write here is NOT guarded: if it throws, the request 500s and no catalog
   * data is returned. This endpoint refuses to serve metadata it cannot record having
   * served. (The docblock previously called this "best-effort", which the code has never
   * done — the comment was describing an intention the implementation contradicted.)
   *
   * The asymmetry with `bulk`/`applyOne`, which DO guard their audit writes, is the
   * point rather than an inconsistency:
   *
   *   - On a WRITE, the change has already committed by the time the audit row is
   *     attempted. Refusing at that point cannot un-happen it; it can only mislead an
   *     operator into retrying work that already landed. So the truthful outcome is
   *     returned and the audit failure is made loud.
   *   - On a READ, nothing has happened yet. Declining is still available, costs only a
   *     retry, and preserves the property the whole feature rests on: every disclosure
   *     of campaign metadata to a non-member is recorded. A silently unaudited read is
   *     precisely the "administrative label laundering content access" failure this
   *     module exists to prevent.
   *
   * Same rule applies to `getCatalogEntry` and `listExportRequests` below, including
   * BOTH rows of their double-writes. A partial double-write (server row committed,
   * campaign row failed) still 500s and returns nothing, so the trail can over-record a
   * disclosure that did not reach the operator but can never under-record one that did.
   * Over-recording is the safe residue; it cannot be eliminated without a
   * transaction-aware audit write, which is #1581.
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
        quotaUsageBytes: this.quotaUsageBytesExpr(),
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

  /**
   * One catalog row by id. Audited both server-scoped and campaign-scoped.
   *
   * Both audit writes are UNGUARDED, like `listCatalog` — a read this module cannot
   * record is a read it does not serve. See the fail-closed rationale there; the same
   * applies to each row of this double-write independently.
   */
  async getCatalogEntry(user: RequestUser, campaignId: number): Promise<CampaignCatalogEntry> {
    const policy = await this.getPrivacyPolicy();
    const rows = await this.db
      .select({
        ...CATALOG_CAMPAIGN_COLUMNS,
        packName: rulePacks.name,
        packVersion: rulePacks.version,
        storageBytes: this.storageBytesExpr(),
        quotaUsageBytes: this.quotaUsageBytesExpr(),
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
          stateVersion: '',
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
    // Deliberately best-effort too, same reasoning as the per-item write (#1581): every
    // campaign in the batch already committed independently, so a failure here must not
    // retroactively cast doubt on results that already happened.
    await auditBestEffort(
      this.audit,
      this.logger,
      {
        actor,
        actorRole,
        action: req.dryRun ? 'campaign.catalog.bulk.dryrun' : 'campaign.catalog.bulk',
        entityType: 'campaign',
        detail:
          `op=${req.operation}, requested=${result.requested}, applied=${result.applied}, ` +
          `wouldApply=${result.wouldApply}, skipped=${result.skipped}, failed=${result.failed}` +
          `, ${this.describeTargets(results)}` +
          (req.reason ? `, reason=${req.reason.slice(0, 300)}` : ''),
      },
      () =>
        `bulk ${req.operation} completed (applied=${result.applied}, skipped=${result.skipped}, ` +
        `failed=${result.failed}) but its summary audit row failed to write`,
    );

    return result;
  }


  /**
   * Which campaigns a batch actually touched, grouped by outcome.
   *
   * WHY COUNTS ALONE WERE NOT ENOUGH. `applyOne` returns before writing any per-campaign
   * audit row on a dry run, and returns early for skips and failures in a real run too.
   * So the only trace of those items was this summary — which recorded `requested=200`
   * and nothing about WHICH 200. An operator could probe the state and eligibility of
   * two hundred NAMED campaigns they cannot otherwise read, and the trail kept none of
   * the names.
   *
   * That is the same principle the read paths fail closed for: a dry run across named
   * campaigns is a privileged read wearing a different verb. It is also the one mode
   * where nothing else is written to notice the gap.
   *
   * Kept in the EXISTING summary row rather than as per-item records for non-applied
   * items, which would be a third audit shape and would multiply a 200-campaign dry run
   * into 200 rows. Real applies keep their per-campaign rows exactly as before, so there
   * are still only two shapes: one summary per batch, one row per campaign that changed.
   *
   * Truncation is DECLARED, never silent — a trail that quietly drops ids is worse than
   * one that admits it, because the reader cannot tell the difference from completeness.
   */
  private describeTargets(results: CampaignCatalogBulkItemResult[]): string {
    const byOutcome = new Map<string, number[]>();
    for (const r of results) {
      const list = byOutcome.get(r.outcome) ?? [];
      list.push(r.campaignId);
      byOutcome.set(r.outcome, list);
    }
    // Cap generously but finitely: 200 ids is the batch ceiling and fits comfortably,
    // yet the guard means a future ceiling raise cannot silently produce a monster row.
    const MAX_IDS = 200;
    const parts: string[] = [];
    for (const outcome of ['applied', 'would_apply', 'skipped', 'failed']) {
      const ids = byOutcome.get(outcome);
      if (!ids || ids.length === 0) continue;
      const shown = ids.slice(0, MAX_IDS);
      const suffix = ids.length > shown.length ? ` (+${ids.length - shown.length} more, truncated)` : '';
      parts.push(`${outcome}=[${shown.join(',')}]${suffix}`);
    }
    return parts.length > 0 ? parts.join(' ') : 'targets=[]';
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
    const skip = (reason: string, stateVersion = ''): CampaignCatalogBulkItemResult => ({
      campaignId,
      outcome: 'skipped',
      reason,
      field: '',
      before: '',
      after: '',
      stateVersion,
    });

    const loaded = this.readDependencies(this.db, campaignId, req);
    if (!loaded) return skip('campaign not found');
    const { input, stateVersion } = loaded;
    const row = input.campaign;

    // A trashed campaign is on its way out; lifecycle edits to it would resurrect
    // confusion rather than resolve it. Restoring is a separate, deliberate act.
    if (row.deletedAt) return skip('campaign is in the trash', stateVersion);

    // APPLY ONLY THE PLAN THAT WAS PREVIEWED.
    //
    // The client can tell when IT changed the request, but not when the CAMPAIGN moved
    // underneath it. Without this, a dry run that reported a completed campaign as
    // `skipped` ("already in the requested state") became a real archive if a DM
    // reactivated it before the operator clicked Apply — `planChange` simply replanned
    // from the new state and wrote a change nobody had seen or agreed to. On a console
    // whose verbs rewrite ownership and privacy across up to 200 campaigns at once,
    // "what you agreed to" and "what runs" have to be the same thing.
    //
    // The version covers EVERY table this operation's plan reads (see
    // OPERATION_DEPENDENCIES), not just `campaigns.updated_at` — a guard that watches a
    // proxy for the state it guards licenses exactly the silent replans it exists to
    // stop. Within each of those tables it is deliberately conservative: any write moves
    // it, so an unrelated edit also forces a re-preview. Refusing and asking to look
    // again is the honest failure; silently applying a different plan is the one being
    // removed.
    //
    // SKIPPED, not failed, and not fatal to the batch — a 200-campaign run that aborts
    // because one campaign moved is its own bad outcome. Absent preconditions (an API
    // client that never previewed) leave behaviour unchanged.
    const precondition = req.preconditions?.find((p) => p.campaignId === campaignId);
    if (precondition && precondition.stateVersion !== stateVersion) {
      return skip('campaign changed since the preview; run the dry run again', stateVersion);
    }

    const plan = planChange(input, req, actor, {
      events: this.events,
      notifications: this.notifications,
    });
    // Both carry the version too: a no-op or ineligible verdict is still a PLAN the
    // operator saw, and it must be pinnable — the reactivated-campaign case is precisely
    // a `skipped` verdict turning into a real write.
    if (plan === null) return skip(CAMPAIGN_CATALOG_NO_OP_REASON, stateVersion);
    if (typeof plan === 'string') return skip(plan, stateVersion);

    if (req.dryRun) {
      return { campaignId, outcome: 'would_apply', reason: '', ...plan.summary, stateVersion };
    }

    // THE CHECK RUNS INSIDE THE TRANSACTION IT GUARDS.
    //
    // Everything above — the dependency read, the eligibility decision, the before/after
    // the operator was shown — came from reads taken OUTSIDE this transaction. Comparing
    // versions out there narrows the window between decision and write; it does not close
    // it, and a precondition whose entire purpose is "Apply must not act on state nobody
    // has seen" is not allowed to be advisory. The concrete consequence: `reassign_owner`
    // demotes every current primary owner unconditionally, so an owner installed in that
    // window is silently replaced having never appeared in any preview.
    //
    // So the dependencies are re-read on `tx` and the version recomputed by the SAME
    // function that produced the original, and the write only happens if they still
    // agree. `plan.apply(tx)` writes through this handle rather than opening its own, so
    // there is no way to commit a plan whose preconditions were not just verified. On
    // better-sqlite3 the transaction is synchronous and serialised, so "still agree" here
    // means what it says.
    //
    // This is a CAS, and the failure is a SKIP for the same reason the pre-check's is: a
    // 200-campaign batch that aborts because one campaign moved is its own bad outcome.
    try {
      this.db.transaction((tx) => {
        const fresh = this.readDependencies(tx, campaignId, req);
        if (!fresh || fresh.stateVersion !== stateVersion) {
          throw new PlanWentStale();
        }
        plan.apply(tx);
      });
    } catch (err) {
      if (err instanceof PlanWentStale) {
        return skip('campaign changed while the change was being applied; run the dry run again', stateVersion);
      }
      // ONE CONDITION, ONE VERDICT. A duplicate `request_export` caught by the pre-check
      // reports `skipped`; before this, the same duplicate caught by the INSERT's own
      // `WHERE NOT EXISTS` (because it arrived concurrently) escaped as an exception and
      // reported `failed`. Identical situation, two different words for it, and only one
      // of them tells the operator "nothing to do here" rather than "retry this".
      if (err instanceof PlanBecameNoOp) return skip(err.message, stateVersion);
      throw err;
    }

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
    //
    // Deliberately still POST-COMMIT / best-effort, not moved onto AuditService#logInTx
    // (#1581): this is a bulk catalog operation (archive/pause/requota), not a consent
    // decision, and re-litigating an already-applied campaign-state change because the
    // audit subsystem hiccuped is a worse outcome than a loudly-logged missing row. See
    // `decideExportRequest` below for the sibling write #1581 DID move onto the
    // transactional path, and why that one is different.
    const auditNote =
      (await auditBestEffort(
        this.audit,
        this.logger,
        {
          actor: actor.actor,
          actorRole: actor.actorRole,
          action: `campaign.catalog.${req.operation}`,
          entityType: 'campaign',
          entityId: campaignId,
          campaignId,
          detail:
            `${plan.summary.field}: ${plan.summary.before} -> ${plan.summary.after}` +
            (req.reason ? ` (${req.reason.slice(0, 300)})` : ''),
        },
        () => `campaign.catalog.${req.operation} applied to campaign ${campaignId} but its audit row failed to write`,
      )) ?? '';

    return { campaignId, outcome: 'applied', reason: auditNote, ...plan.summary, stateVersion };
  }

  /**
   * Load exactly the rows this operation's plan is allowed to read, plus a state version
   * computed over exactly those tables.
   *
   * The declaration in OPERATION_DEPENDENCIES drives both halves, so the rows a planner
   * can see and the rows the precondition covers cannot drift apart: adding a dependency
   * to read it also adds it to the guard, and a planner cannot read one it did not
   * declare because the property is not on its `PlanInput` variant.
   *
   * SYNCHRONOUS, AND THAT IS THE POINT. This runs twice per applied item: once to build
   * the plan, and again INSIDE the write transaction to revalidate it. Both callers must
   * compute the identical fingerprint from the identical reads, so there is exactly one
   * implementation and it takes its handle as an argument — `this.db` for the first call,
   * the transaction handle for the second. Two functions that had to agree would be one
   * refactor away from disagreeing silently, which is the failure this whole mechanism is
   * about.
   */
  private readDependencies(
    db: CatalogReader,
    campaignId: number,
    req: CampaignCatalogBulkRequest,
  ): { input: PlanInput; stateVersion: string } | null {
    const [campaign] = db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        status: campaigns.status,
        ruleSystem: campaigns.ruleSystem,
        storageQuotaBytes: campaigns.storageQuotaBytes,
        publicInvitesEnabled: campaigns.publicInvitesEnabled,
        aiExternalContentPolicy: campaigns.aiExternalContentPolicy,
        deletedAt: campaigns.deletedAt,
        updatedAt: campaigns.updatedAt,
      })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1)
      .all();
    if (!campaign) return null;

    const dependencies: readonly CatalogDependency[] = OPERATION_DEPENDENCIES[req.operation];
    const rows: Partial<CatalogDependencyRows> = { campaign };
    // Fingerprints, in declaration order, so the version string is stable across runs.
    const parts: string[] = [];

    for (const dependency of dependencies) {
      switch (dependency) {
        case 'campaign':
          parts.push(`campaign=${campaign.updatedAt}`);
          break;
        case 'members': {
          const members = db
            .select({
              id: campaignMembers.id,
              userId: campaignMembers.userId,
              primaryOwner: campaignMembers.primaryOwner,
              role: campaignMembers.role,
              updatedAt: campaignMembers.updatedAt,
            })
            .from(campaignMembers)
            .where(eq(campaignMembers.campaignId, campaignId))
            .all();
          rows.members = members;
          // The SET of seats, not a max(updated_at): a seat that is DELETED changes who
          // owns the campaign without advancing any surviving row's timestamp, and that
          // is precisely a change the operator needs re-shown.
          parts.push(
            `members=${fingerprint(
              members.map((m) => `${m.id}:${m.userId}:${m.role}:${m.primaryOwner ? 1 : 0}:${m.updatedAt}`),
            )}`,
          );
          break;
        }
        case 'exportRequests': {
          const requests = db
            .select({
              id: campaignExportRequests.id,
              status: campaignExportRequests.status,
              updatedAt: campaignExportRequests.updatedAt,
            })
            .from(campaignExportRequests)
            .where(eq(campaignExportRequests.campaignId, campaignId))
            .all();
          rows.exportRequests = requests;
          // Status is in the fingerprint because a DM DECIDING the pending request is the
          // mutation that turns a previewed skip into a live insert.
          parts.push(`exports=${fingerprint(requests.map((r) => `${r.id}:${r.status}:${r.updatedAt}`))}`);
          break;
        }
        case 'rulePack': {
          // Keyed by the REQUESTED slug, not by the campaign: what the plan reads is
          // "is the pack this request names installed right now?", so that is what the
          // version has to pin. Absence is a value here, not a missing dependency.
          const slug = req.ruleSystem ?? '';
          const [pack] = db
            .select({ slug: rulePacks.slug })
            .from(rulePacks)
            .where(eq(rulePacks.slug, slug))
            .limit(1)
            .all();
          rows.rulePack = pack ?? null;
          parts.push(`pack=${slug}:${pack ? 1 : 0}`);
          break;
        }
        case 'targetUser': {
          const toUserId = req.toUserId ?? 0;
          const [target] = db
            .select({ id: users.id, username: users.username, disabled: users.disabled })
            .from(users)
            .where(eq(users.id, toUserId))
            .limit(1)
            .all();
          rows.targetUser = target ?? null;
          // `disabled` is in the fingerprint because the plan branches on it. A target
          // re-enabled between preview and Apply must invalidate the preview rather than
          // quietly upgrade a skip into an ownership handover.
          parts.push(`user=${toUserId}:${target ? 1 : 0}:${target?.disabled ? 1 : 0}`);
          break;
        }
        default: {
          // Exhaustiveness: a new CatalogDependency with no loader is a compile error.
          const never: never = dependency;
          throw new Error(`unhandled catalog dependency ${String(never)}`);
        }
      }
    }

    return {
      // The only cast in the mechanism, and it is discharged by the loop above: `rows`
      // has been populated for exactly `OPERATION_DEPENDENCIES[req.operation]`, which is
      // the key set `PlanInput`'s variant for that operation requires.
      input: { operation: req.operation, ...rows } as PlanInput,
      // Digested rather than concatenated: the wire field is capped at 64 characters and
      // the number of dependencies is not. Order is preserved (unlike `fingerprint`,
      // which sorts an unordered row set) because `parts` is built in declaration order.
      stateVersion: createHash('sha1').update(parts.join('|')).digest('hex'),
    };
  }

  /**
   * Decide what one operation would do to one campaign.
   *
   * Returns `null` for a no-op, a string for "skip with this reason", or a plan whose
   * `apply()` performs the whole change inside a single transaction.
   */

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
   *
   * Both rows below are UNGUARDED, like the other two read paths: a read this module
   * cannot record is a read it does not serve. See `listCatalog` for why reads fail
   * closed while writes are guarded. Note that the double-write doubles the number of
   * ways this read can 500 — that is accepted, because the alternative is a disclosure
   * of other people's justifications with no record that it happened.
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
   * server-admin trail and misattribute a routine act as a privileged read.
   *
   * PAGED, FOR THE REASON THE CROSS-CAMPAIGN LISTING IS. This returned a bare array cut
   * off at CAMPAIGN_CATALOG_MAX_LIMIT on the argument that one campaign's history is
   * naturally bounded — which is the same argument the admin listing made before it was
   * found to be silently dropping pending requests. "Rarely exceeds the cap" is not a
   * bound, and the row that falls off a DM's inbox is one nobody ever answers.
   *
   * PENDING FIRST, then newest-first. Ordering by id alone left the actionable rows to be
   * displaced by decided history once a campaign accumulated enough of it; page one is
   * now always the requests that are actually waiting on this DM.
   */
  async listExportRequestsForCampaign(
    campaignId: number,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<CampaignExportRequestPage> {
    const limit = clampListLimit(opts.limit, CAMPAIGN_CATALOG_DEFAULT_LIMIT, CAMPAIGN_CATALOG_MAX_LIMIT);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const where = eq(campaignExportRequests.campaignId, campaignId);

    const rows = await this.db
      .select()
      .from(campaignExportRequests)
      .where(where)
      .orderBy(sql`CASE WHEN ${campaignExportRequests.status} = 'pending' THEN 0 ELSE 1 END`, desc(campaignExportRequests.id))
      .limit(limit)
      .offset(offset);

    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(campaignExportRequests)
      .where(where);

    return {
      items: rows.map((r) => this.toExportRequest(r)),
      total: Number(total),
      hasMore: offset + rows.length < Number(total),
      limit,
      offset,
    };
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
    //
    // ATOMIC WITH ITS PRIMARY AUDIT ROW (#1581). This is exactly the case that issue names
    // as wanting the strict guarantee: "we decided it but there is no record" IS the
    // incident for a consent decision, more than for any other write in this file — a DM
    // who approved an export and is handed a 500 either approves again (refused with
    // "already decided") or concludes it did not happen, and both leave them wrong about
    // whether their campaign's data is now exportable. So unlike the bulk writes above,
    // if the audit insert throws here, the whole transaction rolls back: the decision
    // itself is undone, the DM sees a clean error, and retrying is safe (the same
    // status='pending' predicate protects it, exactly as a genuine concurrent decision
    // does below).
    const primaryEntry: AuditLogParams = {
      actor,
      actorRole: 'dm',
      action: `campaign.export_request.${decision.decision}`,
      entityType: 'campaign_export_request',
      entityId: requestId,
      campaignId,
      detail: `profile=${row.profile}, requestedBy=${row.requestedBy || 'server-admin'}`,
    };
    const [updated] = this.db.transaction((tx) => {
      const rows = tx
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
        .returning()
        .all();
      // Only write the audit row when the update actually matched a row — a lost race
      // (see below) changed nothing, and must not audit a decision that did not happen.
      if (rows.length > 0) this.audit.logInTx(tx, primaryEntry);
      return rows;
    });

    // Zero rows means another DM decided it in the gap. Returning success here would
    // hand this DM the OTHER DM's decision as though it were their own, so it is
    // surfaced. 409 rather than the 400 the pre-check raises: a sequential double-decide
    // is a malformed request, this is a genuine concurrent conflict, and someone reading
    // a contradictory trail later benefits from being able to tell them apart.
    if (!updated) {
      throw new ConflictException('Another DM decided this export request first');
    }

    // THE DECISION HAS COMMITTED (with its primary audit row, atomically — see above).
    // This second mirror is deliberately NOT part of that transaction: it is a
    // convenience duplicate in the server-admin trail (which excludes campaign rows) so
    // the operator who raised the request can find the answer without campaign access.
    // The primary row IS the record of consent; this one is an index onto it. Losing it
    // to a transient audit failure is a worse UX (operator has to search harder) but not
    // "we did it with no record" — the campaign-scoped row already IS that record — so it
    // stays on the best-effort, post-commit path rather than folding into the same
    // transaction and risking a healthy consent decision rolling back over a duplicate
    // convenience row.
    await auditBestEffort(
      this.audit,
      this.logger,
      {
        actor,
        actorRole: 'dm',
        action: `campaign.export_request.${decision.decision}`,
        entityType: 'campaign_export_request',
        entityId: requestId,
        detail: `campaign=${campaignId}, profile=${row.profile}`,
      },
      () =>
        `export request ${requestId} for campaign ${campaignId} was ${decision.decision}, ` +
        `but its server-admin audit mirror failed to write`,
    );

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

  /**
   * The bytes the QUOTA is measured against: committed plus reserved.
   *
   * Deliberately not `storageBytesExpr`. That column answers "how much is stored", which
   * is committed bytes and nothing else — an in-flight reservation is not stored content
   * and showing it there would overstate what the operator can actually go and look at.
   * But quota ENFORCEMENT in attachments.service.ts counts committed + reserved, so
   * deriving `overQuota` (and `?overQuota=true`) from committed alone reported "under
   * quota" for campaigns whose uploads were at that moment being rejected — the console
   * disagreed with the server about the one fact an operator opens it to check.
   *
   * The two definitions now match, and the difference between the flag and the column is
   * documented on the schema fields rather than left for a reader to infer.
   */
  private quotaUsageBytesExpr(): SQL<number> {
    return sql<number>`(SELECT COALESCE(SUM(a.size), 0) FROM attachments a
      WHERE a.campaign_id = ${campaigns.id} AND a.state IN (${COMMITTED}, ${RESERVED}))`;
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
        AND ${this.quotaUsageBytesExpr()} > ${campaigns.storageQuotaBytes})`;
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
      /** Committed + reserved, the sum upload enforcement uses. Drives `overQuota` only. */
      quotaUsageBytes: number;
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
      // Committed + reserved, matching what upload enforcement actually compares against
      // — see quotaUsageBytesExpr. `storageBytes` above stays committed-only.
      overQuota: row.storageQuotaBytes !== null && Number(row.quotaUsageBytes ?? 0) > row.storageQuotaBytes,
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

/**
 * Decide what one operation would do to one campaign.
 *
 * A MODULE-LEVEL FUNCTION, DELIBERATELY, AND IT TAKES NO DATABASE HANDLE. As a method it
 * had the service's db handle in scope, so reading a table the operation had not declared
 * was one line away — which is precisely how `rule_packs` and `users` came to control
 * plans while contributing nothing to `stateVersion`. A dependency declaration is only
 * load-bearing if there is no way around it, and a hand-kept list sitting next to an open
 * database handle has now been wrong twice. Here there is no way around it: `input` is
 * the only source of rows, and `ctx` carries the two services whose post-commit events
 * are needed and nothing that can query.
 *
 * `apply` RECEIVES the transaction rather than opening one, so the write lands in the
 * caller's transaction — the same one that revalidates the precondition. A plan cannot
 * commit outside the check that guards it.
 *
 * Returns `null` for a no-op, a string for "skip with this reason", or a plan.
 */
function planChange(
  input: PlanInput,
  req: CampaignCatalogBulkRequest,
  actor: Actor,
  ctx: PlanContext,
): null | string | CatalogPlan {
  const ts = nowIso();
  const row = input.campaign;
  const id = row.id;

  const statusChange = (next: 'active' | 'paused' | 'completed'): null | CatalogPlan => {
    if (row.status === next) return null;
    // THE PREVIEW MUST NAME EVERY WRITE, NOT JUST THE HEADLINE ONE.
    //
    // Moving out of `active` also closes public invites (see apply()). That mutation
    // is correct — it mirrors the DM-facing path in CampaignsService.update — but the
    // dry run reported only `status: active -> completed`, so an operator archiving a
    // campaign with live join links was never told those links would stop working and
    // would need a DM to deliberately re-enable them after reactivation. The behaviour
    // was right and its description was incomplete, which for a dry run is the same
    // defect: the preview is the only thing the operator consents to.
    //
    // Folded into `after` rather than a new field so it flows into the per-campaign
    // audit detail too — that row is built from this summary, and the trail should not
    // record less than the preview showed.
    const closesInvites = next !== 'active' && row.publicInvitesEnabled;
    return {
      summary: {
        field: 'status',
        before: row.status,
        after: closesInvites ? `${next} (closes public invites)` : next,
      },
      apply: (tx) => {
        {
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
        }
      },
    };
  };

  // Switching on `input.operation` rather than `req.operation` is what makes the
  // dependency declaration load-bearing: it narrows `input` to the variant carrying
  // exactly the declared rows, so a case can only read tables the guard also covers.
  switch (input.operation) {
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
        apply: (tx) => {
          {
            tx.update(campaigns).set({ storageQuotaBytes: next, updatedAt: ts }).where(eq(campaigns.id, id)).run();
          }
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
        apply: (tx) => {
          {
            tx.update(campaigns).set(set).where(eq(campaigns.id, id)).run();
          }
        },
      };
    }

    case 'update_module': {
      const next = req.ruleSystem ?? '';
      if (row.ruleSystem === next) return null;
      // Refuse to pin a campaign to a pack this server cannot serve. The operation
      // exists to FIX the "campaign points at a missing module" condition the catalog
      // surfaces; letting it create that condition would be perverse.
      //
      // Read through `input` because this branch DECIDES the plan: "not installed" is a
      // skip and "installed" is a write, so the pack's presence has to be pinned by the
      // precondition like any other input. As a direct query it was not, which meant
      // another admin installing the pack between preview and Apply flipped a shown
      // skip into an unshown rule-system change.
      if (!input.rulePack) return `rule pack '${next}' is not installed on this server`;
      return {
        summary: { field: 'ruleSystem', before: row.ruleSystem || 'unset', after: next },
        apply: (tx) => {
          {
            tx.update(campaigns).set({ ruleSystem: next, updatedAt: ts }).where(eq(campaigns.id, id)).run();
            // Issue #2097 review (chatgpt-codex-connector P1): a derived equipped action
            // encodes the rule system it was computed under, and the resolver rolls whatever
            // is stored against the campaign's CURRENT adapter — so every writer of
            // `campaigns.ruleSystem` has to invalidate them, not just CampaignsService. Same
            // transaction as the write, so the two can never disagree.
            clearDerivedEquippedActionsIn(tx, id, ts);
          }
        },
      };
    }

    case 'reassign_owner': {
      const toUserId = req.toUserId as number;
      // Also through `input`, and for the same reason as the rule pack: `disabled` is a
      // branch between a skip and a handover, so a target re-enabled after the preview
      // must invalidate that preview rather than silently qualify for it.
      const target = input.targetUser;
      if (!target) return `user ${toUserId} not found`;
      if (target.disabled) return `user ${toUserId} is disabled`;

      // The seat table arrives through `input`, which is also what the precondition
      // fingerprints. Re-reading it here would put the plan back on data the guard does
      // not cover — the exact split that let an Apply demote an owner installed after
      // the preview.
      const existing = input.members;
      const currentOwner = existing.find((m) => m.primaryOwner);
      if (currentOwner?.userId === toUserId) return null;

      // Only for the notification below, and only sent to the incoming OWNER — who by
      // the time it is delivered holds a dm seat on this campaign and may read far more
      // than its name. This is not a widening of the catalog's projection. It comes off
      // the already-declared campaign row rather than a second query, so this planner
      // reads nothing the guard does not cover.
      const campaignName = row.name;

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
        apply: (tx) => {
          {
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
          }
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
                ctx.events.emit({
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
                  void ctx.notifications.notifyUser(toUserId, id, null, {
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
      // Same rule as `reassign_owner`: the request table arrives through `input` so the
      // plan and the precondition see the same rows. A DM deciding the pending request
      // between preview and Apply now invalidates the preview instead of quietly
      // turning a shown `skipped` into an INSERT.
      const pending = input.exportRequests.find((r) => r.status === 'pending');
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
        apply: (tx) => {
          {
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
            // here. Throwing rolls this transaction back rather than reporting
            // `applied` for a row that was never written — and it throws the no-op
            // sentinel, so `applyOne` reports the SAME `skipped` verdict the sequential
            // pre-check produces for the identical condition. Reporting `failed` here
            // told an operator to retry an operation whose only correct outcome is to
            // do nothing.
            if (inserted.changes === 0) {
              throw new PlanBecameNoOp('an export request is already pending for this campaign');
            }
          }
        },
      };
    }

    default:
      return `unsupported operation`;
  }
}
