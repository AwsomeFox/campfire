import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  Note,
  Role,
  ScribeConfig,
  ScribeConfigUpdate,
  ScribeJob,
  ScribeJobStatus,
  ScribeRunResult,
  ScribeTrigger,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { aiDmSeats, aiScribeConfigs, aiScribeJobs, campaigns, proposals, scheduledSessions } from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { NotesService } from '../notes/notes.service';
import { EncountersService } from '../encounters/encounters.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import { AiDmService } from '../ai-dm/ai-dm.service';
import { createAiProvider, type AiProvider } from '../ai-dm/providers';
import { AI_DM_PROVIDER, type AiDmProvider } from '../ai-dm/ai-dm.provider';
import { buildRecapDraft, type RecapDraftSource } from '../sessions/sessions.service';
import { SupportPreferencesService } from '../session-zero/support-preferences.service';

type ScribeConfigUpdateInput = z.infer<typeof ScribeConfigUpdate>;

/**
 * The synthetic actor a sweep-triggered (post-session / cron) run files its proposal
 * under. Its id is non-numeric so it is never itself a notification recipient, which
 * means `proposalRecords.create`'s "notify every DM except the actor" fan-out reaches
 * ALL dm-role members — the point of an automatic run is to ping the humans.
 */
const SCRIBE_SYSTEM_USER: RequestUser = {
  id: 'system:scribe',
  name: 'AI Scribe',
  serverRole: 'admin',
  devRole: 'dm',
};

/** Default scribe config for a campaign that has never configured one (never persisted). */
function defaultConfig(campaignId: number): ScribeConfig {
  const ts = nowIso();
  return { campaignId, postSession: false, cron: false, budgetPerRun: 2000, createdAt: ts, updatedAt: ts };
}

function configToDomain(row: typeof aiScribeConfigs.$inferSelect): ScribeConfig {
  return {
    campaignId: row.campaignId,
    postSession: row.postSession,
    cron: row.cron,
    budgetPerRun: row.budgetPerRun,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function jobToDomain(row: typeof aiScribeJobs.$inferSelect): ScribeJob {
  return {
    id: row.id,
    campaignId: row.campaignId,
    trigger: row.trigger as ScribeTrigger,
    status: row.status as ScribeJobStatus,
    proposalId: row.proposalId ?? null,
    proposalCount: row.proposalCount,
    tokensUsed: row.tokensUsed,
    provider: row.provider,
    detail: row.detail,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * Automatic / scheduled AI scribe (issue #316).
 *
 * A server-side job that DRAFTS a session recap from a campaign's own material
 * (the resolved scribe-inbox threads + the encounters that were run — the SAME
 * source `draft_session_recap` assembles) and has the configured provider WRITE
 * the prose, then files it ALWAYS as a PROPOSAL for the DM to approve. Nothing is
 * ever written to canon unreviewed — the co-DM discipline of the whole AI program.
 *
 * Governance reuses the AI-DM seat's (issue #28): the run is gated on the
 * server-wide `experimentalAiDm` flag AND the per-campaign seat being enabled, and
 * its token cost is metered against the seat's budget (a hard cap — a run that would
 * exhaust it is refused). The provider comes from the encrypted per-campaign/server
 * config (#310 `resolveEffectiveConfig` -> #309 `createAiProvider`); when none is
 * configured it falls back to the injected `AI_DM_PROVIDER` seam (the shipped no-op,
 * or whatever an operator/eval-harness bound there).
 *
 * Triggers:
 *   - on-demand  : `POST /campaigns/:id/scribe/run` or the `run_scribe` MCP tool.
 *   - post-session / cron : the periodic `sweep()` (opt-in per campaign, off by
 *     default) drafts after a scheduled game night's end time passes.
 *
 * Idempotent: a re-run over unchanged material (same source hash), or while a prior
 * scribe recap proposal is still pending review, is a no-op that returns the existing
 * proposal — a sweep firing every hour never stacks duplicate recaps.
 */
@Injectable()
export class ScribeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScribeService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notes: NotesService,
    private readonly encounters: EncountersService,
    private readonly proposalRecords: ProposalRecordsService,
    private readonly providerConfig: AiProviderConfigService,
    private readonly aiDm: AiDmService,
    private readonly supportPreferences: SupportPreferencesService,
    @Inject(AI_DM_PROVIDER) private readonly fallbackProvider: AiDmProvider,
  ) {}

  /**
   * Start the periodic post-session/cron sweep — ONLY when an operator opts in via
   * `SCRIBE_SWEEP_INTERVAL_MS` (a positive integer, ms). Off by default: automatic
   * recaps are a deliberate opt-in, and leaving the timer unset keeps tests and a
   * plain self-host free of any background generation. The timer is `.unref()`d so
   * it never keeps Node alive, and `sweep()` is public so it can be driven directly.
   */
  onApplicationBootstrap(): void {
    const raw = process.env.SCRIBE_SWEEP_INTERVAL_MS;
    const ms = raw ? Number(raw) : NaN;
    if (!Number.isFinite(ms) || ms <= 0) return;
    const timer = setInterval(() => {
      void this.sweep().catch((err) => this.logger.warn(`scribe sweep failed: ${err instanceof Error ? err.message : err}`));
    }, ms);
    timer.unref();
  }

  // ── config ────────────────────────────────────────────────────────────────

  async getConfig(campaignId: number): Promise<ScribeConfig> {
    const [row] = await this.db.select().from(aiScribeConfigs).where(eq(aiScribeConfigs.campaignId, campaignId)).limit(1);
    return row ? configToDomain(row) : defaultConfig(campaignId);
  }

  /** Upsert the per-campaign scribe config (dm only, gated at the controller). Omitted fields unchanged. */
  async putConfig(campaignId: number, input: ScribeConfigUpdateInput, user: RequestUser): Promise<ScribeConfig> {
    const ts = nowIso();
    const [existing] = await this.db.select().from(aiScribeConfigs).where(eq(aiScribeConfigs.campaignId, campaignId)).limit(1);
    if (!existing) {
      const base = defaultConfig(campaignId);
      await this.db.insert(aiScribeConfigs).values({
        campaignId,
        postSession: input.postSession ?? base.postSession,
        cron: input.cron ?? base.cron,
        budgetPerRun: input.budgetPerRun ?? base.budgetPerRun,
        createdAt: ts,
        updatedAt: ts,
      });
    } else {
      await this.db
        .update(aiScribeConfigs)
        .set({
          ...(input.postSession !== undefined ? { postSession: input.postSession } : {}),
          ...(input.cron !== undefined ? { cron: input.cron } : {}),
          ...(input.budgetPerRun !== undefined ? { budgetPerRun: input.budgetPerRun } : {}),
          updatedAt: ts,
        })
        .where(eq(aiScribeConfigs.campaignId, campaignId));
    }
    const changed = Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined);
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'scribe.configure',
      entityType: 'ai-dm',
      campaignId,
      detail: changed.join(', ') || 'no-op',
    });
    return this.getConfig(campaignId);
  }

  async listJobs(campaignId: number, limit = 50): Promise<ScribeJob[]> {
    const rows = await this.db
      .select()
      .from(aiScribeJobs)
      .where(eq(aiScribeJobs.campaignId, campaignId))
      .orderBy(desc(aiScribeJobs.id))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map(jobToDomain);
  }

  // ── source assembly (reuses draft_session_recap's material) ─────────────────

  /**
   * Assemble a recap's source material — the resolved scribe-inbox threads and the
   * encounters that were run — the SAME structured source `draft_session_recap`
   * hands a connected agent (issue #62). The scribe then has the provider write the
   * prose from it. `null` when there's nothing to recap.
   */
  async assembleSource(campaignId: number): Promise<RecapDraftSource | null> {
    const resolvedInbox = await this.notes.listInbox(campaignId, true);
    const encounterList = await this.encounters.listForCampaign(campaignId);
    const encounters = await Promise.all(encounterList.map((e) => this.encounters.getWithCombatantsOrThrow(e.id)));
    const source: RecapDraftSource = {
      resolvedInbox: resolvedInbox.map((n: Note) => ({ body: n.body, resolvedNote: n.resolvedNote, entityName: n.entityName })),
      encounters: encounters.map((e) => ({ name: e.name, status: e.status, combatants: e.combatants })),
    };
    const fought = source.encounters.filter((e) => e.status === 'running' || e.status === 'ended');
    if (fought.length === 0 && source.resolvedInbox.length === 0) return null;
    return source;
  }

  // ── the run engine ──────────────────────────────────────────────────────────

  /**
   * Execute one scribe run for a campaign: assemble source -> provider writes the
   * recap -> file it as a PROPOSAL -> ping the DM -> record the job. Always records a
   * job row (even for a no-op) so runs are auditable and idempotent. `user` is the
   * proposal's proposer + audit actor; a sweep passes the synthetic system actor.
   */
  async run(
    campaignId: number,
    trigger: ScribeTrigger,
    user: RequestUser,
    opts: { dryRun?: boolean } = {},
  ): Promise<ScribeRunResult> {
    const dryRun = opts.dryRun ?? false;

    // 1. Gate on the experimental flag + the seat being enabled (same governance as a turn).
    const all = await this.settings.getAll();
    if (!all.experimentalAiDm) return this.record(campaignId, trigger, user, 'disabled', { detail: 'experimentalAiDm off' });
    const [seat] = await this.db.select().from(aiDmSeats).where(eq(aiDmSeats.campaignId, campaignId)).limit(1);
    if (!seat || !seat.enabled) {
      return this.record(campaignId, trigger, user, 'disabled', { detail: 'AI DM seat not enabled' });
    }

    // 2. Assemble the source. Nothing to recap -> no_material.
    const source = await this.assembleSource(campaignId);
    if (!source) return this.record(campaignId, trigger, user, 'no_material', { detail: 'no inbox/encounter material' });
    const draft = buildRecapDraft(source);
    const sourceHash = createHash('sha256').update(JSON.stringify(source)).digest('hex');

    // 3. Idempotency: never stack recap proposals. If a prior scribe run's proposal is
    //    still PENDING review, or a prior run already drafted THIS exact source, skip.
    const priorSucceeded = await this.db
      .select()
      .from(aiScribeJobs)
      .where(and(eq(aiScribeJobs.campaignId, campaignId), eq(aiScribeJobs.status, 'succeeded')))
      .orderBy(desc(aiScribeJobs.id));
    for (const prior of priorSucceeded) {
      if (prior.proposalId === null) continue;
      const [prop] = await this.db.select().from(proposals).where(eq(proposals.id, prior.proposalId)).limit(1);
      if (!prop) continue;
      if (prop.status === 'pending') {
        return this.record(campaignId, trigger, user, 'skipped', {
          detail: 'a scribe recap proposal is already pending review',
          proposalId: prior.proposalId,
          sourceHash,
        });
      }
      if (prior.sourceHash === sourceHash) {
        return this.record(campaignId, trigger, user, 'skipped', {
          detail: 'identical source already drafted',
          proposalId: prior.proposalId,
          sourceHash,
        });
      }
    }

    // 4. Budget: the seat's token budget is a hard cap.
    const remaining = seat.tokenBudget - seat.tokensUsed;
    if (remaining <= 0) {
      return this.record(campaignId, trigger, user, 'over_budget', {
        detail: `budget exhausted (${seat.tokensUsed}/${seat.tokenBudget})`,
        sourceHash,
      });
    }
    // Server-wide admin token cap (#384/#315): the scribe spends provider tokens, so it must
    // respect the global ceiling too. Recorded as over_budget (not thrown) so a periodic sweep
    // degrades gracefully rather than crashing when the server cap is hit.
    try {
      await this.aiDm.assertWithinServerTokenCap();
    } catch (err) {
      return this.record(campaignId, trigger, user, 'over_budget', {
        detail: err instanceof Error ? err.message : 'server-wide AI token cap reached',
        sourceHash,
      });
    }

    // 5. Resolve the provider (configured #310 -> #309 factory; else the injected seam).
    const config = await this.providerConfig.resolveEffectiveConfig(campaignId);
    const budgetPerRun = (await this.getConfig(campaignId)).budgetPerRun;
    const maxTokens = Math.min(budgetPerRun, remaining);

    let text: string;
    let tokensUsed: number;
    let providerName: string;
    try {
      // Read consent at provider-call time (never from a persisted job/source
      // snapshot) so revocation immediately removes a preference from future runs.
      const aiSupports = await this.supportPreferences.listForAi(campaignId);
      const supportGuidance = aiSupports.length > 0
        ? `\n\nParticipant-authorized practical supports (apply respectfully; do not infer diagnoses):\n${JSON.stringify(aiSupports)}`
        : '';
      const system =
        (seat.instructions ? `${seat.instructions}\n\n` : '') +
        'You are the campaign scribe. Write a concise, in-voice session recap from the source material below. ' +
        'Return only the finished recap prose (markdown allowed); do not include the raw source-notes appendix.' +
        supportGuidance;
      if (config) {
        const provider: AiProvider = createAiProvider({ ...config, params: { ...config.params, maxTokens } });
        const result = await provider.generate({
          system,
          messages: [{ role: 'user', content: draft }],
          model: config.model,
          maxTokens,
        });
        text = result.text;
        tokensUsed = result.usage.totalTokens;
        providerName = provider.name;
      } else {
        const result = await this.fallbackProvider.generate({
          campaignId,
          kind: 'recap',
          prompt: draft,
          instructions: system,
          model: seat.model,
          maxTokens,
        });
        text = result.narration;
        tokensUsed = result.tokensUsed;
        providerName = this.fallbackProvider.name;
      }
    } catch (err) {
      return this.record(campaignId, trigger, user, 'failed', {
        detail: `provider error: ${err instanceof Error ? err.message : String(err)}`,
        sourceHash,
      });
    }

    tokensUsed = Math.max(0, Math.floor(tokensUsed));
    if (!text.trim()) {
      return this.record(campaignId, trigger, user, 'failed', { detail: 'provider returned empty recap', sourceHash, tokensUsed, provider: providerName });
    }

    // 6. Meter the cost against the seat budget atomically (AiDmService.meterTurn's
    //    #272 in-SQL clamp + turnCount/lastTurnAt for #1055). On failure, still record a job.
    try {
      await this.aiDm.meterTurn(campaignId, tokensUsed, {
        actor: auditActor(user),
        action: 'scribe.meter',
        detail: `${trigger} metering (+${tokensUsed} tokens)`,
      });
    } catch (err) {
      return this.record(campaignId, trigger, user, 'failed', {
        detail: `metering error: ${err instanceof Error ? err.message : String(err)}`,
        sourceHash,
        tokensUsed,
        provider: providerName,
      });
    }

    // 7. Dry run: preview only — metered (a real call was made) but nothing filed.
    if (dryRun) {
      const job = await this.record(campaignId, trigger, user, 'succeeded', {
        detail: 'dry-run preview (no proposal filed)',
        sourceHash,
        tokensUsed,
        provider: providerName,
      });
      return { ...job, preview: text };
    }

    // 8. File the recap as a session-create PROPOSAL (never a direct canon write). This
    //    auto-notifies the DM(s) that a proposal awaits review (proposalRecords.create).
    const title = source.encounters.find((e) => e.status === 'running' || e.status === 'ended')?.name
      ? `Recap: ${source.encounters.find((e) => e.status === 'running' || e.status === 'ended')!.name}`
      : 'Session recap (AI draft)';
    // Attribute the recap to the AI scribe, not the human who triggered it (#383). An on-demand
    // run passes the triggering DM as `user`; without this the proposal's proposer/proposerUserId
    // would be that DM's name + id — affirmatively misattributing an AI-written recap to a human in
    // the review queue and audit-facing proposer field, and excluding it from the AI-drafts filter.
    // The `ai-dm:` prefix matches the same badge/filter the co-DM path uses.
    const proposal = await this.proposalRecords.create(
      campaignId,
      'session',
      null,
      'create',
      { recap: text, title },
      user,
      'dm' as Role,
      { proposer: `AI Scribe (${providerName})`, proposerUserId: `ai-dm:${campaignId}`, proposerToken: null },
    );

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'scribe.run',
      entityType: 'ai-dm',
      campaignId,
      detail: `${trigger} via ${providerName} -> proposal #${proposal.id} (+${tokensUsed} tokens)`,
    });

    const job = await this.record(campaignId, trigger, user, 'succeeded', {
      detail: `drafted recap proposal #${proposal.id}`,
      sourceHash,
      proposalId: proposal.id,
      proposalCount: 1,
      tokensUsed,
      provider: providerName,
    });
    return { ...job, proposalIds: [proposal.id] };
  }

  // ── post-session / cron sweep ────────────────────────────────────────────────

  /**
   * One sweep pass (called by the opt-in interval; public so it can be driven
   * directly / in tests). For every campaign whose scribe config opts into
   * `postSession` (and whose most recent scheduled game night has already ended) or
   * `cron`, run the scribe. `run()` is idempotent, so a sweep never duplicates a
   * recap. Returns the runs it performed.
   */
  async sweep(now: Date = new Date()): Promise<ScribeRunResult[]> {
    const configs = await this.db.select().from(aiScribeConfigs);
    const results: ScribeRunResult[] = [];
    for (const cfg of configs) {
      const trigger: ScribeTrigger | null = cfg.postSession && (await this.hasEndedSession(cfg.campaignId, now))
        ? 'post_session'
        : cfg.cron
          ? 'cron'
          : null;
      if (!trigger) continue;
      try {
        results.push(await this.run(cfg.campaignId, trigger, SCRIBE_SYSTEM_USER));
      } catch (err) {
        this.logger.warn(`scribe run for campaign ${cfg.campaignId} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return results;
  }

  /** True when the campaign has at least one scheduled session whose end time is in the past. */
  private async hasEndedSession(campaignId: number, now: Date): Promise<boolean> {
    const rows = await this.db.select().from(scheduledSessions).where(eq(scheduledSessions.campaignId, campaignId));
    return rows.some((r) => {
      const start = Date.parse(r.scheduledAt);
      if (!Number.isFinite(start)) return false;
      return start + (r.durationMinutes ?? 0) * 60_000 <= now.getTime();
    });
  }

  // ── job recording ────────────────────────────────────────────────────────────

  /** Insert a job row and return the ScribeRunResult wrapping it. */
  private async record(
    campaignId: number,
    trigger: ScribeTrigger,
    user: RequestUser,
    status: ScribeJobStatus,
    extra: { detail?: string; sourceHash?: string; proposalId?: number; proposalCount?: number; tokensUsed?: number; provider?: string } = {},
  ): Promise<ScribeRunResult> {
    const [row] = await this.db
      .insert(aiScribeJobs)
      .values({
        campaignId,
        trigger,
        status,
        sourceHash: extra.sourceHash ?? null,
        proposalId: extra.proposalId ?? null,
        proposalCount: extra.proposalCount ?? 0,
        tokensUsed: extra.tokensUsed ?? 0,
        provider: extra.provider ?? '',
        detail: extra.detail ?? '',
        createdBy: auditActor(user),
        createdAt: nowIso(),
      })
      .returning();
    const job = jobToDomain(row);
    return {
      job,
      proposalIds: extra.proposalId ? [extra.proposalId] : [],
      dryRun: false,
      preview: null,
    };
  }

  /** True when the campaign exists — used by the controller to 404 cleanly. */
  async campaignExists(campaignId: number): Promise<boolean> {
    const [row] = await this.db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    return !!row;
  }
}
