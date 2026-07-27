import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { DB, type DrizzleDb } from '../../db/db.module';
import { aiDriverGroundingClaims } from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import type { Role } from '@campfire/schema';
import { AuditService } from '../audit/audit.service';
import type { EvaluatedCitation, GroundingVerdict } from './driver-grounding';

/** One persisted claim + the server's verdict on it, as returned to API clients. */
export interface AiDriverGroundingClaimRecord {
  id: number;
  campaignId: number;
  turn: number;
  claimIndex: number;
  kind: string;
  claimText: string;
  status: 'supported' | 'unsupported' | 'corrected';
  reason: string;
  citations: EvaluatedCitation[];
  /** Provider NAME only (e.g. "openai") — never a key, base URL, or header. */
  provider: string;
  /** The model id actually served for the turn. */
  model: string;
  createdAt: string;
  correction: string | null;
  correctedBy: string | null;
  correctedAt: string | null;
}

/**
 * Rows kept per campaign. The review card only ever shows recent turns, and this table is a
 * review trail rather than canon, so an unbounded log would be pure cost on a long campaign.
 */
const MAX_ROWS_PER_CAMPAIGN = 500;

/** How many recent corrections are replayed into the system prompt (#577). */
const PROMPT_CORRECTION_LIMIT = 8;
/** Per-correction character cap in the prompt, so one long rebuttal can't crowd out context. */
const PROMPT_CORRECTION_CHARS = 300;

function toRecord(row: typeof aiDriverGroundingClaims.$inferSelect): AiDriverGroundingClaimRecord {
  let citations: EvaluatedCitation[] = [];
  try {
    const parsed: unknown = JSON.parse(row.citationsJson);
    if (Array.isArray(parsed)) citations = parsed as EvaluatedCitation[];
  } catch {
    // A corrupt payload must not 500 the review card; the verdict columns still carry the
    // decision, and the citation detail is presentational.
    citations = [];
  }
  return {
    id: row.id,
    campaignId: row.campaignId,
    turn: row.turn,
    claimIndex: row.claimIndex,
    kind: row.kind,
    claimText: row.claimText,
    status: row.status as AiDriverGroundingClaimRecord['status'],
    reason: row.reason,
    citations,
    provider: row.provider,
    model: row.model,
    createdAt: row.createdAt,
    correction: row.correction ?? null,
    correctedBy: row.correctedBy ?? null,
    correctedAt: row.correctedAt ?? null,
  };
}

/**
 * Persistence + human-correction loop for AI driver grounding verdicts (#577).
 *
 * Deliberately separate from AiDriverService: the verdict itself is computed by the pure
 * functions in driver-grounding.ts, and this service only stores the outcome, serves it back
 * with its provenance, and feeds a human's correction into subsequent turns. Keeping it out of
 * the turn loop keeps the driver's diff additive while #1442 / #1524 are in flight.
 */
@Injectable()
export class DriverGroundingService {
  private readonly logger = new Logger(DriverGroundingService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  /**
   * Persist one turn's verdict. Best-effort by contract: the narration has already been
   * broadcast by the time this runs, so a storage failure must never turn a completed turn
   * into an error — it is logged and the turn stands (with the verdict still on the SSE
   * event and the turn result).
   */
  async recordVerdict(
    campaignId: number,
    turn: number,
    verdict: GroundingVerdict,
  ): Promise<AiDriverGroundingClaimRecord[]> {
    if (verdict.claims.length === 0) return [];
    const createdAt = nowIso();
    const values = verdict.claims.map((claim) => ({
      campaignId,
      turn,
      claimIndex: claim.index,
      kind: claim.kind,
      claimText: claim.text,
      status: claim.status,
      reason: claim.reason,
      citationsJson: JSON.stringify(claim.citations),
      provider: verdict.provider,
      model: verdict.model,
      createdAt,
      correction: null,
      correctedBy: null,
      correctedAt: null,
    }));
    try {
      const rows = await this.db.insert(aiDriverGroundingClaims).values(values).returning();
      await this.prune(campaignId);
      return rows.map(toRecord);
    } catch (err) {
      this.logger.warn(
        `Failed to persist grounding verdict for campaign ${campaignId} turn ${turn}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  /** Recent claims for a campaign, newest first. */
  async listForCampaign(campaignId: number, limit = 50): Promise<AiDriverGroundingClaimRecord[]> {
    const rows = await this.db
      .select()
      .from(aiDriverGroundingClaims)
      .where(eq(aiDriverGroundingClaims.campaignId, campaignId))
      .orderBy(desc(aiDriverGroundingClaims.id))
      .limit(Math.max(1, Math.min(limit, 200)));
    return rows.map(toRecord);
  }

  /**
   * Record a human's correction of a claim.
   *
   * The claim row is NOT rewritten out of existence: the original text, verdict, and provenance
   * stay, and the correction is layered on top. That keeps the record of what the AI actually
   * said (which is the thing the table may need to argue about later) while making the human's
   * ruling the one that carries forward.
   */
  async correct(
    campaignId: number,
    claimId: number,
    user: RequestUser,
    role: Role,
    correction: string,
  ): Promise<AiDriverGroundingClaimRecord> {
    const text = correction.trim();
    if (!text) throw new BadRequestException('A correction must not be empty.');
    const [row] = await this.db
      .select()
      .from(aiDriverGroundingClaims)
      .where(and(eq(aiDriverGroundingClaims.id, claimId), eq(aiDriverGroundingClaims.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new NotFoundException(`No AI grounding claim ${claimId} in campaign ${campaignId}.`);

    const correctedAt = nowIso();
    const [updated] = await this.db
      .update(aiDriverGroundingClaims)
      .set({ status: 'corrected', correction: text, correctedBy: user.id, correctedAt })
      .where(eq(aiDriverGroundingClaims.id, claimId))
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'ai-dm.driver.grounding.corrected',
      entityType: 'ai-dm',
      campaignId,
      detail: `corrected claim ${claimId} (was ${row.status}/${row.reason}) by ${user.id}`,
    });
    return toRecord(updated ?? row);
  }

  /**
   * Recent human corrections, rendered for the driver system prompt (#577).
   *
   * This is the other half of the loop: flagging a claim as unverified is only useful if the
   * model stops repeating it. A correction is stated as table-authoritative and outranks
   * anything the model believes, including its own earlier narration.
   */
  async correctionsForPrompt(campaignId: number): Promise<string[]> {
    try {
      const rows = await this.db
        .select()
        .from(aiDriverGroundingClaims)
        .where(and(eq(aiDriverGroundingClaims.campaignId, campaignId), isNotNull(aiDriverGroundingClaims.correction)))
        .orderBy(desc(aiDriverGroundingClaims.id))
        .limit(PROMPT_CORRECTION_LIMIT);
      // Oldest-first reads more naturally as a running list of table rulings.
      return rows
        .slice()
        .reverse()
        .map((row) => {
          const claim = row.claimText.trim().slice(0, PROMPT_CORRECTION_CHARS) || '(claim text unavailable)';
          const fix = (row.correction ?? '').trim().slice(0, PROMPT_CORRECTION_CHARS);
          // Phrased as "the table's ruling is" rather than "corrected this to" so the same line
          // reads correctly whether the human overruled the claim or upheld it — a DM who types
          // "that was right, you just cited it badly" must not produce a nonsense prompt line.
          return `- You claimed: “${claim}” — the table's ruling is: “${fix}”`;
        });
    } catch (err) {
      // Context assembly is best-effort everywhere else in the driver; a failed read here must
      // not abort the turn.
      this.logger.warn(
        `Failed to load grounding corrections for campaign ${campaignId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  /** Trim a campaign's review trail to {@link MAX_ROWS_PER_CAMPAIGN} most recent rows. */
  private async prune(campaignId: number): Promise<void> {
    try {
      const [cutoff] = await this.db
        .select({ id: aiDriverGroundingClaims.id })
        .from(aiDriverGroundingClaims)
        .where(eq(aiDriverGroundingClaims.campaignId, campaignId))
        .orderBy(desc(aiDriverGroundingClaims.id))
        .limit(1)
        .offset(MAX_ROWS_PER_CAMPAIGN - 1);
      if (!cutoff) return;
      await this.db
        .delete(aiDriverGroundingClaims)
        .where(and(eq(aiDriverGroundingClaims.campaignId, campaignId), lt(aiDriverGroundingClaims.id, cutoff.id)));
    } catch (err) {
      this.logger.warn(
        `Failed to prune grounding claims for campaign ${campaignId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
