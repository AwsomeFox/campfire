import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AiExternalContentPolicy, InboxSweepEntityType, InboxSweepItemResult, InboxSweepJob, InboxSweepOutcome, InboxSweepResult, Role } from '@campfire/schema';
import {
  CharacterCreate,
  CharacterUpdate,
  LocationCreate,
  LocationUpdate,
  NpcCreate,
  NpcUpdate,
  QuestCreate,
  QuestUpdate,
} from '@campfire/schema';
import type { z } from 'zod';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignMembers, campaigns, inboxSweepItems, inboxSweepJobs, notes as notesTable } from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { NotesService } from '../notes/notes.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import type { AiProviderConfig } from '../ai-dm/providers';
import {
  INBOX_SWEEP_CLASSIFIER,
  InvalidInboxSweepClassificationError,
  NoProviderConfiguredError,
  type InboxSweepClassification,
  type InboxSweepClassifier,
  type InboxSweepContext,
} from './inbox-sweep-classifier';

const ENTITY_SCHEMAS: Record<InboxSweepEntityType, { create: z.ZodTypeAny; update: z.ZodTypeAny }> = {
  quest: { create: QuestCreate, update: QuestUpdate },
  npc: { create: NpcCreate, update: NpcUpdate },
  location: { create: LocationCreate, update: LocationUpdate },
  character: { create: CharacterCreate, update: CharacterUpdate },
};

const UNSUPPORTED_WRITE_REASON =
  'objective ticks, HP changes, and combat/initiative writes are not handled by the inbox sweep — resolve this item directly';

/**
 * better-sqlite3 throws a synchronous Error with `.code` set to SQLITE_CONSTRAINT_*
 * on a unique-index race. Concurrent sweeps can both miss the ledger row, classify the
 * same open note as skip/dismiss, and race the UNIQUE(campaign_id, note_id) insert —
 * recover via findLedger instead of letting that surface as a 500 (same local-helper
 * convention as encounters/members/rules/organized-play).
 */
function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  const message = err instanceof Error ? err.message : '';
  return /UNIQUE constraint failed/i.test(message);
}

class StaleInboxSweepItemError extends Error {
  constructor() {
    super('inbox item changed or was resolved before the proposal could be filed');
    this.name = 'StaleInboxSweepItemError';
  }
}

type InboxSweepEgress = 'external' | 'local';
type InboxSweepTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

interface ExternalAiGate {
  egress: InboxSweepEgress;
  policy: AiExternalContentPolicy;
  consentingMemberIds: ReadonlySet<string>;
}

interface JobRow {
  id: number;
  campaignId: number;
  status: string;
  itemsTotal: number;
  itemsProposed: number;
  itemsSkipped: number;
  itemsErrored: number;
  detail: string;
  createdBy: string;
  createdAt: string;
}

function jobToDomain(row: JobRow): InboxSweepJob {
  return {
    id: row.id,
    campaignId: row.campaignId,
    status: row.status as InboxSweepJob['status'],
    itemsTotal: row.itemsTotal,
    itemsProposed: row.itemsProposed,
    itemsSkipped: row.itemsSkipped,
    itemsErrored: row.itemsErrored,
    detail: row.detail,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * Inbox sweep orchestration (issue #1644) — the foundation slice of #1306.
 *
 * Reads a campaign's OPEN inbox items, infers create/update/dismiss per capture, files
 * PENDING PROPOSALS ONLY via `ProposalRecordsService.create` (never a direct canon
 * write), and resolves swept items. Intentionally exposes a single `sweep()` method
 * with no controller-specific shape, so a future MCP tool (#1645) can call the exact
 * same path instead of reimplementing it — the parity-without-duplication requirement
 * called out on that issue.
 *
 * AUTHORIZATION: this service does NOT itself check role — the caller (REST controller
 * today, MCP tool later) must gate with `CampaignAccessService.requireRole(user,
 * campaignId, 'dm')` BEFORE calling `sweep()`. That call also enforces the
 * archived-campaign read-only gate (issue's requirement #5), since `requireRole`
 * asserts writability by default. #1450 was a critical hole behind an auth check that
 * looked right from the route name alone — the actual guard here is `requireRole`,
 * never `requireMember({write:true})` (which only asserts the CAMPAIGN is writable, not
 * that the caller holds DM authority).
 *
 * DM-SECRET SAFETY: the campaign-context bootstrap below calls `CampaignsService.summary`
 * with role `'dm'` explicitly (not the caller's role, which is already asserted dm by
 * the guard above) so hidden quests/NPCs and unexplored locations ARE visible to the
 * classifier — the sweep needs to be able to update them. Nothing from that summary
 * reaches a non-DM: the whole flow is dm-gated end to end, and results only ever
 * contain entity ids/types/reasons, never dmSecret text.
 *
 * IDEMPOTENCY: a UNIQUE(campaign_id, note_id) row in `inbox_sweep_items` is written the
 * moment an item's terminal outcome is decided (proposed, skipped, or an unusable
 * classifier error), BEFORE the corresponding
 * inbox item is resolved. A re-sweep sees that ledger row first and skips straight to
 * "resolve if not already resolved" — it never re-classifies or re-files a proposal for
 * a note it has already swept, even if the process crashed between filing the proposal
 * and resolving the note. Consent-withheld and no-provider outcomes deliberately remain
 * unledgered/open because a later consent or provider configuration change can make the
 * item sweepable without manual intervention.
 */
@Injectable()
export class InboxSweepService {
  private readonly logger = new Logger(InboxSweepService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly notes: NotesService,
    private readonly proposals: ProposalRecordsService,
    private readonly campaigns: CampaignsService,
    private readonly providerConfig: AiProviderConfigService,
    @Inject(INBOX_SWEEP_CLASSIFIER) private readonly classifier: InboxSweepClassifier,
  ) {}

  async sweep(campaignId: number, user: RequestUser, role: Role): Promise<InboxSweepResult> {
    const openItems = await this.notes.listAllInbox(campaignId, false);

    if (openItems.length === 0) {
      const job = await this.insertJob(campaignId, user, 'succeeded', {
        itemsTotal: 0,
        itemsProposed: 0,
        itemsSkipped: 0,
        itemsErrored: 0,
        detail: 'no open inbox items',
      });
      return { job: jobToDomain(job), items: [] };
    }

    const existing = await this.db
      .select()
      .from(inboxSweepItems)
      .where(
        and(
          eq(inboxSweepItems.campaignId, campaignId),
          inArray(
            inboxSweepItems.noteId,
            openItems.map((n) => n.id),
          ),
        ),
      );
    const existingByNote = new Map(existing.map((r) => [r.noteId, r]));

    const summary = await this.campaigns.summary(campaignId, 'dm');
    const context: InboxSweepContext = {
      campaignId,
      quests: (summary?.quests ?? []).map((q) => ({ id: q.id, name: q.title })),
      npcs: (summary?.npcs ?? []).map((n) => ({ id: n.id, name: n.name })),
      locations: (summary?.locations ?? []).map((l) => ({ id: l.id, name: l.name })),
      characters: (summary?.characters ?? []).map((c) => ({ id: c.id, name: c.name })),
    };
    const results: InboxSweepItemResult[] = [];
    let proposed = 0;
    let skipped = 0;
    let errored = 0;

    // Placeholder job row so ledger rows have a valid job_id from the start; totals are
    // corrected with a single UPDATE once the loop below finishes (best-effort auditable
    // record, same shape as ScribeService's `record()` — see scribe.service.ts).
    const job = await this.insertJob(campaignId, user, 'succeeded', {
      itemsTotal: openItems.length,
      itemsProposed: 0,
      itemsSkipped: 0,
      itemsErrored: 0,
      detail: 'sweep in progress',
    });

    for (const item of openItems) {
      const prior = existingByNote.get(item.id);
      if (prior) {
        // Already swept in an earlier run — never re-classify or re-propose. Self-heal
        // the crash window where a terminal ledger row was written but the inbox close
        // did not complete.
        if (!item.resolved) {
          const link = this.resolveLinkForPrior(prior);
          await this.tryResolve(item.id, user, role, prior.reason, link.entityType, link.entityId);
        }
        results.push(this.resultFromLedger(item.id, prior));
        if (prior.outcome === 'proposed') proposed++;
        else if (prior.outcome === 'errored') errored++;
        else skipped++;
        continue;
      }

      const { config } = await this.providerConfig.resolveEffectiveConfigWithEndpointScope(campaignId);
      const externalAiGate = await this.externalAiGate(campaignId, config);
      const withheldReason = this.externalAiWithheldReason(item, externalAiGate);
      if (withheldReason) {
        errored++;
        results.push({
          noteId: item.id,
          outcome: 'errored',
          entityType: null,
          entityId: null,
          proposalId: null,
          reason: withheldReason,
        });
        continue;
      }

      let classification: InboxSweepClassification;
      try {
        classification = await this.classifier.classify({ noteId: item.id, body: item.body }, context, config);
      } catch (err) {
        if (err instanceof NoProviderConfiguredError) {
          // No point classifying the remaining items either — abort the whole run with a
          // job-level 'disabled' status, same shape as ScribeService's disabled path.
          const disabledJob = await this.updateJob(job.id, {
            status: 'disabled',
            itemsTotal: openItems.length,
            itemsProposed: proposed,
            itemsSkipped: skipped,
            itemsErrored: errored,
            detail: 'no AI provider configured for this campaign',
          });
          return { job: jobToDomain(disabledJob), items: results };
        }
        const reason = `classification failed: ${err instanceof Error ? err.message : String(err)}`;
        if (err instanceof InvalidInboxSweepClassificationError) {
          const outcome = await this.recordError(campaignId, job.id, item.id, reason, user, role);
          results.push(outcome);
          if (outcome.outcome === 'proposed') proposed++;
          else if (outcome.outcome === 'errored') errored++;
          else skipped++;
        } else {
          errored++;
          results.push({
            noteId: item.id,
            outcome: 'errored',
            entityType: null,
            entityId: null,
            proposalId: null,
            reason,
          });
        }
        continue;
      }

      const outcome = await this.applyClassification(
        campaignId,
        job.id,
        item.id,
        item.body,
        item.updatedAt,
        classification,
        user,
        role,
      );
      results.push(outcome);
      if (outcome.outcome === 'proposed') proposed++;
      else if (outcome.outcome === 'errored') errored++;
      else skipped++;
    }

    const finalJob = await this.updateJob(job.id, {
      status: 'succeeded',
      itemsTotal: openItems.length,
      itemsProposed: proposed,
      itemsSkipped: skipped,
      itemsErrored: errored,
      detail: `swept ${openItems.length} item(s): ${proposed} proposed, ${skipped} skipped, ${errored} errored`,
    });
    return { job: jobToDomain(finalJob), items: results };
  }

  private async applyClassification(
    campaignId: number,
    jobId: number,
    noteId: number,
    originalBody: string,
    originalUpdatedAt: string,
    classification: InboxSweepClassification,
    user: RequestUser,
    role: Role,
  ): Promise<InboxSweepItemResult> {
    const supportedEntityType =
      classification.entityType != null && classification.entityType in ENTITY_SCHEMAS ? classification.entityType : null;

    if (classification.action === 'unsupported' || (classification.action !== 'dismiss' && !supportedEntityType)) {
      const reason =
        classification.action === 'unsupported'
          ? classification.reason || UNSUPPORTED_WRITE_REASON
          : `entity type "${classification.entityType ?? 'unknown'}" is not supported by the inbox sweep`;
      return this.recordSkip(campaignId, jobId, noteId, reason, user, role);
    }

    if (classification.action === 'dismiss') {
      const reason = classification.reason || 'no canon change needed';
      return this.recordSkip(campaignId, jobId, noteId, reason, user, role);
    }

    // action is 'create' or 'update', entityType is one of the four supported types.
    const entityType = supportedEntityType as InboxSweepEntityType;
    const schemas = ENTITY_SCHEMAS[entityType];
    const targetId = classification.action === 'update' ? classification.targetId : null;
    if (classification.action === 'update' && targetId === null) {
      const reason = `model proposed an update to ${entityType} with no targetId`;
      return this.recordError(campaignId, jobId, noteId, reason, user, role);
    }

    let validated: Record<string, unknown>;
    try {
      const schema = classification.action === 'create' ? schemas.create : schemas.update;
      validated = schema.parse(classification.fields) as Record<string, unknown>;
    } catch (err) {
      const reason = `${entityType} ${classification.action} payload failed validation: ${err instanceof Error ? err.message : String(err)}`;
      return this.recordError(campaignId, jobId, noteId, reason, user, role);
    }

    try {
      const { proposal, result: reason } = await this.proposals.createWithTransaction(
        campaignId,
        entityType,
        targetId,
        classification.action,
        validated,
        user,
        role,
        (tx, proposalRow) => {
          this.assertInboxItemStillCurrent(tx, noteId, originalBody, originalUpdatedAt);
          const reason = classification.reason || `filed as ${classification.action} proposal #${proposalRow.id}`;
          const ts = nowIso();
          tx.insert(inboxSweepItems)
            .values({
              campaignId,
              noteId,
              jobId,
              outcome: 'proposed',
              entityType,
              entityId: targetId,
              proposalId: proposalRow.id,
              reason,
              createdAt: ts,
              updatedAt: ts,
            })
            .run();
          return reason;
        },
      );
      await this.tryResolve(
        noteId,
        user,
        role,
        `filed as ${classification.action} proposal #${proposal.id}: ${reason}`,
        classification.action === 'update' ? entityType : null,
        classification.action === 'update' ? targetId : null,
      );
      return { noteId, outcome: 'proposed', entityType, entityId: targetId, proposalId: proposal.id, reason };
    } catch (err) {
      if (err instanceof StaleInboxSweepItemError) {
        return {
          noteId,
          outcome: 'errored',
          entityType: null,
          entityId: null,
          proposalId: null,
          reason: `${err.message}; re-run the sweep if it is still open`,
        };
      }
      const concurrent = await this.findLedger(campaignId, noteId);
      if (concurrent) {
        const link = this.resolveLinkForPrior(concurrent);
        await this.tryResolve(noteId, user, role, concurrent.reason, link.entityType, link.entityId);
        return this.resultFromLedger(noteId, concurrent);
      }
      const reason = `failed to file ${classification.action} proposal: ${err instanceof Error ? err.message : String(err)}`;
      return { noteId, outcome: 'errored', entityType: null, entityId: null, proposalId: null, reason };
    }
  }

  /**
   * Persist a skipped ledger row + resolve the inbox item. Concurrent sweeps can race
   * the UNIQUE(campaign_id, note_id) insert on the skip/dismiss path the same way the
   * create/update path races proposal+ledger — recover from the winner's row instead of
   * letting the constraint error abort the whole job.
   */
  private async recordSkip(
    campaignId: number,
    jobId: number,
    noteId: number,
    reason: string,
    user: RequestUser,
    role: Role,
  ): Promise<InboxSweepItemResult> {
    try {
      await this.persistLedger(campaignId, jobId, noteId, 'skipped', null, null, null, reason);
    } catch (err) {
      const concurrent = await this.findLedger(campaignId, noteId);
      if (concurrent) {
        const link = this.resolveLinkForPrior(concurrent);
        await this.tryResolve(noteId, user, role, concurrent.reason, link.entityType, link.entityId);
        return this.resultFromLedger(noteId, concurrent);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (!isUniqueConstraintError(err)) {
        this.logger.warn(`Failed to persist skip ledger for inbox item ${noteId}: ${message}`);
      }
      // Same graceful-degradation contract as the create/update path: a single item's
      // ledger-write failure must never abort the whole sweep loop and strand every
      // remaining item without a result. With no ledger row, this item can be retried on
      // a later sweep if it was not resolved by hand.
      return {
        noteId,
        outcome: 'errored',
        entityType: null,
        entityId: null,
        proposalId: null,
        reason: `failed to record skip: ${message}`,
      };
    }
    await this.tryResolve(noteId, user, role, reason, null, null);
    return { noteId, outcome: 'skipped', entityType: null, entityId: null, proposalId: null, reason };
  }

  /**
   * Persist a terminal classifier error and resolve the inbox item so deterministic bad
   * model output (invalid payload, missing target, unparsable response) does not hot-loop
   * on every sweep. Consent/provider-configuration gates do not use this helper because
   * those conditions can become sweepable later without editing the inbox item.
   */
  private async recordError(
    campaignId: number,
    jobId: number,
    noteId: number,
    reason: string,
    user: RequestUser,
    role: Role,
  ): Promise<InboxSweepItemResult> {
    try {
      await this.persistLedger(campaignId, jobId, noteId, 'errored', null, null, null, reason);
    } catch (err) {
      const concurrent = await this.findLedger(campaignId, noteId);
      if (concurrent) {
        const link = this.resolveLinkForPrior(concurrent);
        await this.tryResolve(noteId, user, role, concurrent.reason, link.entityType, link.entityId);
        return this.resultFromLedger(noteId, concurrent);
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to persist error ledger for inbox item ${noteId}: ${message}`);
      return {
        noteId,
        outcome: 'errored',
        entityType: null,
        entityId: null,
        proposalId: null,
        reason: `failed to record error: ${message}`,
      };
    }

    await this.tryResolve(noteId, user, role, reason, null, null);
    return { noteId, outcome: 'errored', entityType: null, entityId: null, proposalId: null, reason };
  }

  /** Best-effort: the ledger row above is what makes a re-sweep idempotent, not this. */
  private async tryResolve(
    noteId: number,
    user: RequestUser,
    role: Role,
    resolvedNote: string,
    entityType: InboxSweepEntityType | null,
    entityId: number | null,
  ): Promise<void> {
    try {
      await this.notes.resolveInbox(
        noteId,
        {
          resolvedNote: resolvedNote.slice(0, 1000),
          entityType,
          entityId,
        },
        user,
        role,
      );
    } catch (err) {
      // Already resolved with a different terminal payload, or some other transient
      // failure — the ledger row already recorded the outcome, so a later sweep (or the
      // DM resolving it by hand) is what happens next. Not fatal to this run.
      this.logger.warn(
        `Failed to resolve inbox item ${noteId} after sweep decision: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private resolveLinkForPrior(row: typeof inboxSweepItems.$inferSelect): {
    entityType: InboxSweepEntityType | null;
    entityId: number | null;
  } {
    if (row.entityId == null) return { entityType: null, entityId: null };
    return { entityType: (row.entityType as InboxSweepEntityType | null) ?? null, entityId: row.entityId };
  }

  private resultFromLedger(noteId: number, row: typeof inboxSweepItems.$inferSelect): InboxSweepItemResult {
    return {
      noteId,
      outcome: row.outcome as InboxSweepOutcome,
      entityType: (row.entityType as InboxSweepEntityType | null) ?? null,
      entityId: row.entityId,
      proposalId: row.proposalId,
      reason: row.reason || 'previously swept',
    };
  }

  private async findLedger(campaignId: number, noteId: number): Promise<typeof inboxSweepItems.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(inboxSweepItems)
      .where(and(eq(inboxSweepItems.campaignId, campaignId), eq(inboxSweepItems.noteId, noteId)))
      .limit(1);
    return row ?? null;
  }

  private assertInboxItemStillCurrent(
    tx: InboxSweepTx,
    noteId: number,
    originalBody: string,
    originalUpdatedAt: string,
  ): void {
    const current = tx
      .select({ id: notesTable.id })
      .from(notesTable)
      .where(
        and(
          eq(notesTable.id, noteId),
          eq(notesTable.kind, 'inbox'),
          eq(notesTable.resolved, false),
          eq(notesTable.body, originalBody),
          eq(notesTable.updatedAt, originalUpdatedAt),
          isNull(notesTable.deletedAt),
          isNull(notesTable.quarantinedAt),
        ),
      )
      .limit(1)
      .get();
    if (!current) throw new StaleInboxSweepItemError();
  }

  private operatorDeclaredLocalEndpoint(): boolean {
    const raw = process.env.AI_PROVIDER_ENDPOINT_IS_LOCAL?.trim().toLowerCase();
    return raw === '1' || raw === 'true';
  }

  private resolveEgress(config: AiProviderConfig | null): InboxSweepEgress {
    if (!config) return 'local';
    return this.operatorDeclaredLocalEndpoint() ? 'local' : 'external';
  }

  private async aiContentPolicy(campaignId: number): Promise<AiExternalContentPolicy> {
    const [row] = await this.db
      .select({ aiExternalContentPolicy: campaigns.aiExternalContentPolicy })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    return (row?.aiExternalContentPolicy ?? 'member_consent') as AiExternalContentPolicy;
  }

  private async consentingMemberIds(campaignId: number): Promise<Set<string>> {
    const rows = await this.db
      .select({ userId: campaignMembers.userId })
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.aiExternalUseConsent, true)));
    return new Set(rows.map((row) => String(row.userId)));
  }

  private async externalAiGate(campaignId: number, config: AiProviderConfig | null): Promise<ExternalAiGate> {
    const egress = this.resolveEgress(config);
    const policy = await this.aiContentPolicy(campaignId);
    const consentingMemberIds =
      egress === 'external' && policy === 'member_consent'
        ? await this.consentingMemberIds(campaignId)
        : new Set<string>();
    return { egress, policy, consentingMemberIds };
  }

  private externalAiWithheldReason(
    item: { authorUserId: string | null },
    gate: ExternalAiGate,
  ): string | null {
    if (gate.egress !== 'external') return null;
    if (gate.policy === 'disabled') {
      return "withheld because this campaign's AI content policy disallows external use of member-authored inbox captures";
    }
    const authorUserId = item.authorUserId ?? '';
    if (authorUserId && gate.consentingMemberIds.has(authorUserId)) return null;
    return 'withheld pending author consent for external AI use';
  }

  private async persistLedger(
    campaignId: number,
    jobId: number,
    noteId: number,
    outcome: InboxSweepOutcome,
    entityType: InboxSweepEntityType | null,
    entityId: number | null,
    proposalId: number | null,
    reason: string,
  ): Promise<void> {
    const ts = nowIso();
    await this.db.insert(inboxSweepItems).values({
      campaignId,
      noteId,
      jobId,
      outcome,
      entityType,
      entityId,
      proposalId,
      reason,
      createdAt: ts,
      updatedAt: ts,
    });
  }

  private async insertJob(
    campaignId: number,
    user: RequestUser,
    status: 'succeeded' | 'disabled',
    counts: { itemsTotal: number; itemsProposed: number; itemsSkipped: number; itemsErrored: number; detail: string },
  ): Promise<JobRow> {
    const [row] = await this.db
      .insert(inboxSweepJobs)
      .values({
        campaignId,
        status,
        itemsTotal: counts.itemsTotal,
        itemsProposed: counts.itemsProposed,
        itemsSkipped: counts.itemsSkipped,
        itemsErrored: counts.itemsErrored,
        detail: counts.detail,
        createdBy: auditActor(user),
        createdAt: nowIso(),
      })
      .returning();
    return row as JobRow;
  }

  private async updateJob(
    jobId: number,
    patch: { status: 'succeeded' | 'disabled'; itemsTotal: number; itemsProposed: number; itemsSkipped: number; itemsErrored: number; detail: string },
  ): Promise<JobRow> {
    const [row] = await this.db
      .update(inboxSweepJobs)
      .set({
        status: patch.status,
        itemsTotal: patch.itemsTotal,
        itemsProposed: patch.itemsProposed,
        itemsSkipped: patch.itemsSkipped,
        itemsErrored: patch.itemsErrored,
        detail: patch.detail,
      })
      .where(eq(inboxSweepJobs.id, jobId))
      .returning();
    return row as JobRow;
  }
}
