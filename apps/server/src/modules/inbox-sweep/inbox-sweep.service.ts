import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { InboxSweepEntityType, InboxSweepItemResult, InboxSweepJob, InboxSweepOutcome, InboxSweepResult, Role } from '@campfire/schema';
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
import { inboxSweepItems, inboxSweepJobs } from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { NotesService } from '../notes/notes.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import {
  INBOX_SWEEP_CLASSIFIER,
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
 * moment an item's outcome is decided (proposed or skipped), BEFORE the corresponding
 * inbox item is resolved. A re-sweep sees that ledger row first and skips straight to
 * "resolve if not already resolved" — it never re-classifies or re-files a proposal for
 * a note it has already swept, even if the process crashed between filing the proposal
 * and resolving the note. `errored` outcomes are deliberately NOT written to the ledger,
 * so a transient failure (bad model JSON, provider error) is retried on the next sweep
 * rather than stuck forever.
 */
@Injectable()
export class InboxSweepService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly notes: NotesService,
    private readonly proposals: ProposalRecordsService,
    private readonly campaigns: CampaignsService,
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

    const existing =
      openItems.length === 0
        ? []
        : await this.db
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
      quests: summary.quests.map((q) => ({ id: q.id, name: q.title })),
      npcs: summary.npcs.map((n) => ({ id: n.id, name: n.name })),
      locations: summary.locations.map((l) => ({ id: l.id, name: l.name })),
      characters: summary.characters.map((c) => ({ id: c.id, name: c.name })),
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
        // the one crash window this design has to guard against: a proposal was filed
        // and the ledger row written, but the process died before `resolveInbox` ran.
        if (prior.outcome === 'proposed' && !item.resolved) {
          await this.tryResolve(item.id, user, role, prior.reason, prior.entityType as InboxSweepEntityType | null, prior.entityId);
        }
        results.push({
          noteId: item.id,
          outcome: prior.outcome as InboxSweepOutcome,
          entityType: (prior.entityType as InboxSweepEntityType | null) ?? null,
          entityId: prior.entityId,
          proposalId: prior.proposalId,
          reason: prior.reason,
        });
        if (prior.outcome === 'proposed') proposed++;
        else skipped++;
        continue;
      }

      let classification: InboxSweepClassification;
      try {
        classification = await this.classifier.classify({ noteId: item.id, body: item.body }, context);
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
        errored++;
        results.push({
          noteId: item.id,
          outcome: 'errored',
          entityType: null,
          entityId: null,
          proposalId: null,
          reason: `classification failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      const outcome = await this.applyClassification(campaignId, job.id, item.id, classification, user, role);
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
      await this.persistLedger(campaignId, jobId, noteId, 'skipped', null, null, null, reason);
      await this.tryResolve(noteId, user, role, reason, null, null);
      return { noteId, outcome: 'skipped', entityType: null, entityId: null, proposalId: null, reason };
    }

    if (classification.action === 'dismiss') {
      const reason = classification.reason || 'no canon change needed';
      await this.persistLedger(campaignId, jobId, noteId, 'skipped', null, null, null, reason);
      await this.tryResolve(noteId, user, role, reason, null, null);
      return { noteId, outcome: 'skipped', entityType: null, entityId: null, proposalId: null, reason };
    }

    // action is 'create' or 'update', entityType is one of the four supported types.
    const entityType = supportedEntityType as InboxSweepEntityType;
    const schemas = ENTITY_SCHEMAS[entityType];
    const targetId = classification.action === 'update' ? classification.targetId : null;
    if (classification.action === 'update' && targetId === null) {
      const reason = `model proposed an update to ${entityType} with no targetId`;
      return { noteId, outcome: 'errored', entityType: null, entityId: null, proposalId: null, reason };
    }

    let validated: Record<string, unknown>;
    try {
      const schema = classification.action === 'create' ? schemas.create : schemas.update;
      validated = schema.parse(classification.fields) as Record<string, unknown>;
    } catch (err) {
      const reason = `${entityType} ${classification.action} payload failed validation: ${err instanceof Error ? err.message : String(err)}`;
      return { noteId, outcome: 'errored', entityType: null, entityId: null, proposalId: null, reason };
    }

    try {
      const proposal = await this.proposals.create(campaignId, entityType, targetId, classification.action, validated, user, role);
      const reason = classification.reason || `filed as ${classification.action} proposal #${proposal.id}`;
      await this.persistLedger(campaignId, jobId, noteId, 'proposed', entityType, targetId, proposal.id, reason);
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
      const reason = `failed to file ${classification.action} proposal: ${err instanceof Error ? err.message : String(err)}`;
      return { noteId, outcome: 'errored', entityType: null, entityId: null, proposalId: null, reason };
    }
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
    } catch {
      // Already resolved with a different terminal payload, or some other transient
      // failure — the ledger row already recorded the outcome, so a later sweep (or the
      // DM resolving it by hand) is what happens next. Not fatal to this run.
    }
  }

  private async persistLedger(
    campaignId: number,
    jobId: number,
    noteId: number,
    outcome: 'proposed' | 'skipped',
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
