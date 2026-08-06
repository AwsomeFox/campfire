import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import type {
  CampaignAllowance,
  CampaignAllowanceReason,
  CampaignCreationPolicy,
  CampaignCreationRequest,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignCreationRequests, campaignMembers, campaigns, users } from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, auditActorRole, hasServerAdminPower, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';

type SyncDb = DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * Thrown by {@link CampaignGovernanceService.enforceTx} when the shared-instance
 * policy (issue #851) refuses a create/import/clone. Carries a stable `code` so
 * the web client can render a specific message (and so tests can assert on the
 * exact reason) instead of string-matching `message`.
 */
export class CampaignGovernanceDeniedError extends ForbiddenException {
  constructor(
    readonly code: CampaignAllowanceReason,
    message: string,
  ) {
    super({ code, message });
  }
}

/** Resolved once per create/import/clone call, before the atomic in-transaction check. */
export interface CampaignGovernanceContext {
  /** Dev-auth (header) principals bypass governance entirely — no real account to meter or gate. */
  bypass: boolean;
  policy: CampaignCreationPolicy;
  isServerAdmin: boolean;
  /** This caller's own User.canCreateCampaigns — irrelevant except under 'approved_organizers'. */
  canCreateCampaigns: boolean;
  /** Numeric users.id, or null for a synthetic/dev principal that owns no campaignMembers row. */
  userId: number | null;
  limits: {
    activePerUser: number | null;
    totalPerUser: number | null;
    activeServerWide: number | null;
    totalServerWide: number | null;
  };
  defaultStorageQuotaBytes: number | null;
}

@Injectable()
export class CampaignGovernanceService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Async prefetch (settings + this caller's own organizer flag) done BEFORE the
   * synchronous transaction create/importCampaign/clone open for their insert —
   * better-sqlite3 transaction callbacks must be plain sync functions, so nothing
   * here can run inside one. The count-based limit checks that DO need to be
   * race-free happen in {@link enforceTx} instead, using this context's numbers.
   */
  async resolveContext(user: RequestUser): Promise<CampaignGovernanceContext> {
    if (user.devRole) {
      // Mirrors the existing `if (!user.devRole)` carve-out in CampaignsService.create()
      // — synthetic dev:* principals never get a campaignMembers row, so they cannot be
      // metered against a per-user limit, and every e2e/dev-auth flow predates this policy.
      //
      // The POLICY and LIMITS are bypassed; the storage default is NOT (review). It is not an
      // authorization decision — it is what a brand-new campaign's `storageQuotaBytes` is
      // stamped with — so hard-coding it to null here meant a header-auth deployment silently
      // ignored the operator's configured default on every create, import and clone. The
      // bypass exists because there is no account to meter, which says nothing about storage.
      const devSettings = await this.settings.getAll();
      return {
        bypass: true,
        policy: 'everyone',
        isServerAdmin: hasServerAdminPower(user),
        canCreateCampaigns: true,
        userId: null,
        limits: { activePerUser: null, totalPerUser: null, activeServerWide: null, totalServerWide: null },
        defaultStorageQuotaBytes: devSettings.defaultCampaignStorageQuotaBytes ?? null,
      };
    }
    const all = await this.settings.getAll();
    const numericId = Number(user.id);
    const userId = Number.isInteger(numericId) ? numericId : null;
    // Fails CLOSED for a numeric principal whose row is gone (review). A stale session or a
    // token minted for a since-deleted account would otherwise be treated as an approved
    // organizer under `approved_organizers` — the policy answering "yes" for a user it cannot
    // find. A principal with no numeric id at all (a dev/synthetic actor) keeps the permissive
    // default, because there is no row to look up and no account to have been revoked.
    let canCreateCampaigns = true;
    if (userId != null) {
      const [row] = await this.db
        .select({ canCreateCampaigns: users.canCreateCampaigns })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      canCreateCampaigns = row ? row.canCreateCampaigns : false;
    }
    return {
      bypass: false,
      policy: all.campaignCreationPolicy,
      isServerAdmin: hasServerAdminPower(user),
      canCreateCampaigns,
      userId,
      limits: {
        activePerUser: all.maxActiveCampaignsPerUser,
        totalPerUser: all.maxTotalCampaignsPerUser,
        activeServerWide: all.maxActiveCampaignsServerWide,
        totalServerWide: all.maxTotalCampaignsServerWide,
      },
      defaultStorageQuotaBytes: all.defaultCampaignStorageQuotaBytes,
    };
  }

  /**
   * The authoritative, race-free check. MUST be called as the first statement inside
   * the SAME synchronous `db.transaction(...)` callback that inserts the new campaign
   * row (create/importCampaign/clone) — see the class doc above for why the count
   * queries below have to live in that transaction rather than in resolveContext.
   * Node is single-threaded and a better-sqlite3 transaction callback never yields,
   * so two concurrent callers in ONE process cannot both pass this check for the same
   * limit before either one's insert commits (issue #851 acceptance criterion:
   * concurrent creates/imports must not exceed a limit, and a denial must roll back
   * cleanly — throwing here, before any row is inserted, aborts the whole transaction).
   *
   * Single-process is not the whole story, and this doc used to stop there (review).
   * The counts below are reads, and drizzle's default `db.transaction(...)` is
   * BEGIN DEFERRED — the read takes a shared lock and the write lock is only acquired
   * at the insert. Two Campfire processes on the same SQLite file could therefore both
   * finish counting before either upgraded, and land two rows past the cap. So all three
   * call sites open their transaction with `{ behavior: 'immediate' }`, reserving the
   * writer slot BEFORE the counts are read. That is the same treatment AuthService.setup
   * and InvitesService.accept already give their read-then-write claims, and for the
   * same documented reason.
   *
   * Policy: 'admins_only'/'approved_organizers' NEVER exempt a real server admin —
   * hasServerAdminPower() is the same check AGENTS.md calls out (PAT adminEnabled
   * caps are authoritative, not the raw serverRole). Limits are NOT policy-exempt:
   * an admin's own campaigns still count toward — and are still capped by — the
   * per-user/server-wide ceilings, because the point of a limit is disk/sprawl
   * control, not a privilege boundary.
   */
  /**
   * The POLICY half of {@link enforceTx}, split out because it needs no database reads —
   * every input was already resolved by {@link resolveContext}.
   *
   * That matters for the ZIP import path (review). `enforceTx` runs inside the insert
   * transaction, which for an archive import happens only AFTER the whole zip has been
   * decompressed and every attachment staged to disk. A user the policy forbids from
   * importing at all could therefore repeatedly upload archives that expand to hundreds of
   * megabytes and are written to the uploads volume, purely to be handed a 403 and swept.
   * Calling this first, before a single byte is expanded, refuses them at the door.
   *
   * The LIMIT checks deliberately do NOT move: they count rows, and they are only race-free
   * because they run inside the synchronous transaction alongside the insert. `enforceTx`
   * remains the authoritative gate — this is an early refusal for the cases that can be
   * decided without counting anything, never a replacement for it.
   */
  assertPolicyAllowed(ctx: CampaignGovernanceContext): void {
    if (ctx.bypass) return;

    if (ctx.policy === 'admins_only' && !ctx.isServerAdmin) {
      throw new CampaignGovernanceDeniedError(
        'policy_admins_only',
        'Only a server admin may create or import a campaign on this server.',
      );
    }
    if (ctx.policy === 'approved_organizers' && !ctx.isServerAdmin && !ctx.canCreateCampaigns) {
      throw new CampaignGovernanceDeniedError(
        'policy_requires_approval',
        'Campaign creation is restricted to approved organizers on this server. Request access from a server admin.',
      );
    }
  }

  enforceTx(tx: SyncDb, ctx: CampaignGovernanceContext): void {
    if (ctx.bypass) return;

    this.assertPolicyAllowed(ctx);

    if (ctx.userId != null) {
      if (ctx.limits.activePerUser != null) {
        const used = this.countOwnedCampaigns(tx, ctx.userId, 'active');
        if (used >= ctx.limits.activePerUser) {
          throw new CampaignGovernanceDeniedError(
            'limit_active_per_user',
            `You already have ${used} active campaign(s); this server allows at most ${ctx.limits.activePerUser} per user.`,
          );
        }
      }
      if (ctx.limits.totalPerUser != null) {
        const used = this.countOwnedCampaigns(tx, ctx.userId, 'total');
        if (used >= ctx.limits.totalPerUser) {
          throw new CampaignGovernanceDeniedError(
            'limit_total_per_user',
            `You already own ${used} campaign(s); this server allows at most ${ctx.limits.totalPerUser} per user.`,
          );
        }
      }
    }
    if (ctx.limits.activeServerWide != null) {
      const used = this.countAllCampaigns(tx, 'active');
      if (used >= ctx.limits.activeServerWide) {
        throw new CampaignGovernanceDeniedError(
          'limit_active_server_wide',
          `This server already has ${used} active campaign(s), its configured limit.`,
        );
      }
    }
    if (ctx.limits.totalServerWide != null) {
      const used = this.countAllCampaigns(tx, 'total');
      if (used >= ctx.limits.totalServerWide) {
        throw new CampaignGovernanceDeniedError(
          'limit_total_server_wide',
          `This server already has ${used} campaign(s), its configured limit.`,
        );
      }
    }
  }

  /**
   * "active" = status='active' non-trashed campaigns owned (campaignMembers.primaryOwner)
   * by `userId`; "total" = every non-trashed campaign owned (active + paused + completed).
   * Callable with either the top-level db handle or a live transaction's `tx` — both
   * support the synchronous `.get()` drizzle uses under better-sqlite3.
   */
  private countOwnedCampaigns(db: SyncDb, userId: number, mode: 'active' | 'total'): number {
    const conditions = [
      eq(campaignMembers.userId, userId),
      eq(campaignMembers.primaryOwner, true),
      isNull(campaigns.deletedAt),
    ];
    if (mode === 'active') conditions.push(eq(campaigns.status, 'active'));
    const row = db
      .select({ n: count() })
      .from(campaignMembers)
      .innerJoin(campaigns, eq(campaigns.id, campaignMembers.campaignId))
      .where(and(...conditions))
      .get();
    return Number(row?.n ?? 0);
  }

  /** Server-wide equivalent of {@link countOwnedCampaigns}, with no owner filter. */
  private countAllCampaigns(db: SyncDb, mode: 'active' | 'total'): number {
    const conditions = [isNull(campaigns.deletedAt)];
    if (mode === 'active') conditions.push(eq(campaigns.status, 'active'));
    const row = db
      .select({ n: count() })
      .from(campaigns)
      .where(and(...conditions))
      .get();
    return Number(row?.n ?? 0);
  }

  /**
   * GET /campaigns/allowance — the caller's effective allowance, computed live so a
   * wizard/import button can show real numbers before committing to the flow. This
   * is a display aid ONLY; create/importCampaign/clone re-run {@link enforceTx}
   * regardless of what this reports (server-enforced, never client-trusted).
   */
  async getAllowance(user: RequestUser): Promise<CampaignAllowance> {
    const ctx = await this.resolveContext(user);
    const activePerUser = ctx.userId != null ? this.countOwnedCampaigns(this.db, ctx.userId, 'active') : 0;
    const totalPerUser = ctx.userId != null ? this.countOwnedCampaigns(this.db, ctx.userId, 'total') : 0;
    const activeServerWide = this.countAllCampaigns(this.db, 'active');
    const totalServerWide = this.countAllCampaigns(this.db, 'total');

    let canCreate = true;
    let reason: CampaignAllowanceReason = 'ok';
    if (!ctx.bypass) {
      if (ctx.policy === 'admins_only' && !ctx.isServerAdmin) {
        canCreate = false;
        reason = 'policy_admins_only';
      } else if (ctx.policy === 'approved_organizers' && !ctx.isServerAdmin && !ctx.canCreateCampaigns) {
        canCreate = false;
        reason = 'policy_requires_approval';
      } else if (ctx.limits.activePerUser != null && activePerUser >= ctx.limits.activePerUser) {
        canCreate = false;
        reason = 'limit_active_per_user';
      } else if (ctx.limits.totalPerUser != null && totalPerUser >= ctx.limits.totalPerUser) {
        canCreate = false;
        reason = 'limit_total_per_user';
      } else if (ctx.limits.activeServerWide != null && activeServerWide >= ctx.limits.activeServerWide) {
        canCreate = false;
        reason = 'limit_active_server_wide';
      } else if (ctx.limits.totalServerWide != null && totalServerWide >= ctx.limits.totalServerWide) {
        canCreate = false;
        reason = 'limit_total_server_wide';
      }
    }

    let hasPendingRequest = false;
    if (ctx.userId != null) {
      const [row] = await this.db
        .select({ id: campaignCreationRequests.id })
        .from(campaignCreationRequests)
        .where(and(eq(campaignCreationRequests.userId, ctx.userId), eq(campaignCreationRequests.status, 'pending')))
        .limit(1);
      hasPendingRequest = row != null;
    }

    return {
      policy: ctx.policy,
      canCreate,
      reason,
      activePerUser: { used: activePerUser, max: ctx.limits.activePerUser },
      totalPerUser: { used: totalPerUser, max: ctx.limits.totalPerUser },
      // Admin-only (review) — see the schema comment. The counts are still computed above
      // because `canCreate`/`reason` below depend on them; they are simply not returned to a
      // caller with no standing to see a server-wide aggregate.
      activeServerWide: ctx.isServerAdmin ? { used: activeServerWide, max: ctx.limits.activeServerWide } : null,
      totalServerWide: ctx.isServerAdmin ? { used: totalServerWide, max: ctx.limits.totalServerWide } : null,
      defaultStorageQuotaBytes: ctx.defaultStorageQuotaBytes,
      hasPendingRequest,
    };
  }

  // ---- the request/approval flow (issue #851) ----------------------------------

  /** Any authenticated real user may file ONE pending request at a time. */
  async createRequest(user: RequestUser, note?: string): Promise<CampaignCreationRequest> {
    const userId = Number(user.id);
    if (!Number.isInteger(userId)) {
      throw new BadRequestException('A synthetic/dev principal cannot file a campaign-creation request');
    }
    const ts = nowIso();
    // One transaction, like decide() (review). The check and the insert were two awaited
    // statements with an event-loop yield between them, so two requests filed at once both
    // passed the check and both landed — and approving one leaves its twins pending forever,
    // because decide() only touches the id it is given.
    //
    // A partial unique index on (user_id) WHERE status='pending' would be a second backstop,
    // but this server is one process against one SQLite file, where a synchronous transaction
    // already serializes the pair; it is not worth a third migration on a PR that already
    // carries two.
    const row = this.db.transaction((tx) => {
      const existing = tx
        .select({ id: campaignCreationRequests.id })
        .from(campaignCreationRequests)
        .where(and(eq(campaignCreationRequests.userId, userId), eq(campaignCreationRequests.status, 'pending')))
        .limit(1)
        .get();
      if (existing) {
        throw new ConflictException('You already have a pending campaign-creation request');
      }
      const inserted = tx
        .insert(campaignCreationRequests)
        .values({ userId, status: 'pending', note: note ?? '', requestedAt: ts })
        .returning()
        .get();
      // Audited INSIDE the transaction, like decide() (review). It used to be a bare
      // `await this.audit.log(...)` after the commit, and AuditService.log does not swallow
      // errors — so an audit-write failure rethrew as a 500 with the pending row already
      // committed. The duplicate guard above then answered every retry with 409, and the
      // pending queue is admin-only, so the user could neither see that their request had
      // landed nor file another one: permanently stuck, by a failure in record-keeping.
      //
      // logInTx rather than auditBestEffort because these two writes belong together. A
      // best-effort audit is right when the caller's outcome must survive a bookkeeping
      // failure (the denial audits do that — a 403 must not become a 500). Here the row IS
      // the outcome, and a request with no audit record is not worth keeping, so failing
      // both and letting the user retry cleanly is the better trade.
      this.audit.logInTx(tx, {
        actor: auditActor(user),
        // The requester's REAL role (review). A creation request is filed precisely by someone
        // with no dm authority — often a user the policy has restricted — so recording every one
        // as 'dm' misattributes exactly the distinction this field exists to preserve. decide()
        // in this same service already uses the helper.
        actorRole: auditActorRole(user),
        action: 'campaign_creation_request.create',
        entityType: 'campaign_creation_request',
        entityId: inserted.id,
        detail: note ? `note=${note}` : undefined,
      });
      return inserted;
    });
    const [who] = await this.db
      .select({ username: users.username, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return {
      id: row.id,
      userId,
      username: who?.username ?? '',
      displayName: who?.displayName ?? '',
      status: 'pending',
      note: row.note,
      requestedAt: row.requestedAt,
      decidedAt: null,
      decidedBy: null,
    };
  }

  /** Server-admin only (gated at the controller) — the actionable queue. */
  async listPendingRequests(): Promise<CampaignCreationRequest[]> {
    const rows = await this.db
      .select({
        id: campaignCreationRequests.id,
        userId: campaignCreationRequests.userId,
        username: users.username,
        displayName: users.displayName,
        status: campaignCreationRequests.status,
        note: campaignCreationRequests.note,
        requestedAt: campaignCreationRequests.requestedAt,
        decidedAt: campaignCreationRequests.decidedAt,
        decidedBy: campaignCreationRequests.decidedBy,
      })
      .from(campaignCreationRequests)
      .innerJoin(users, eq(users.id, campaignCreationRequests.userId))
      .where(eq(campaignCreationRequests.status, 'pending'))
      .orderBy(desc(campaignCreationRequests.id));
    return rows.map((r) => ({
      ...r,
      status: r.status as CampaignCreationRequest['status'],
      decidedAt: r.decidedAt ?? null,
      decidedBy: r.decidedBy ?? null,
    }));
  }

  /**
   * Server-admin only (gated at the controller). Approving flips the requester's
   * `users.canCreateCampaigns` to true in the SAME transaction as the decision row
   * (issue #851: "a safe request/approval flow" — the grant and its record commit
   * or fail together). Denying leaves the flag untouched.
   */
  async decide(id: number, decision: 'approved' | 'denied', actor: RequestUser, note?: string): Promise<CampaignCreationRequest> {
    const ts = nowIso();
    return this.db.transaction((tx) => {
      const existing = tx.select().from(campaignCreationRequests).where(eq(campaignCreationRequests.id, id)).limit(1).get();
      if (!existing) throw new NotFoundException(`Campaign creation request ${id} not found`);
      if (existing.status !== 'pending') {
        throw new ConflictException(`Request ${id} was already ${existing.status}`);
      }
      const decidedBy = auditActor(actor);
      tx.update(campaignCreationRequests)
        .set({ status: decision, decidedAt: ts, decidedBy })
        .where(eq(campaignCreationRequests.id, id))
        .run();
      if (decision === 'approved') {
        tx.update(users).set({ canCreateCampaigns: true, updatedAt: ts }).where(eq(users.id, existing.userId)).run();
      }
      const who = tx
        .select({ username: users.username, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, existing.userId))
        .get();
      this.audit.logInTx(tx, {
        actor: decidedBy,
        actorRole: auditActorRole(actor),
        action: decision === 'approved' ? 'campaign_creation_request.approve' : 'campaign_creation_request.deny',
        entityType: 'campaign_creation_request',
        entityId: id,
        detail: `user:${existing.userId}${note ? `, note=${note}` : ''}`,
      });
      return {
        id,
        userId: existing.userId,
        username: who?.username ?? '',
        displayName: who?.displayName ?? '',
        status: decision,
        note: existing.note,
        requestedAt: existing.requestedAt,
        decidedAt: ts,
        decidedBy,
      };
    });
  }
}
