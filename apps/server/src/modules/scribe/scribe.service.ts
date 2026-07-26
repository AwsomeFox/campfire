import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  AiExternalContentPolicy,
  AiGenerationProvenance,
  Note,
  NarrationLanguage,
  Role,
  ScribeConfig,
  ScribeConfigUpdate,
  ScribeJob,
  ScribeJobStatus,
  ScribeRunResult,
  ScribeSourcePreview,
  ScribeSourceStats,
  ScribeTrigger,
} from '@campfire/schema';
import { AI_EXTERNAL_PROVIDER_PRIVACY, buildNarrationLanguageContract, resolveNarrationLanguage } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  aiDmSeats,
  aiScribeConfigs,
  aiScribeJobs,
  campaignMembers,
  campaigns,
  encounters,
  proposals,
  scheduledSessions,
  sessions,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { NotesService } from '../notes/notes.service';
import { EncountersService } from '../encounters/encounters.service';
import { RollsService, DEFAULT_DICE_ROLLS_RETENTION } from '../rolls/rolls.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import { AiDmService } from '../ai-dm/ai-dm.service';
import { createAiProvider, type AiProvider } from '../ai-dm/providers';
import { AI_DM_PROVIDER, type AiDmProvider } from '../ai-dm/ai-dm.provider';
import { buildRecapDraft, type RecapDraftSource } from '../sessions/sessions.service';
import { SupportPreferencesService } from '../session-zero/support-preferences.service';
import {
  filterSourceByScope,
  isSessionScope,
  postSessionScope,
  sourceStatsFrom,
  estimatePromptTokens,
  type ScribeCursorScope,
  type ScribeSessionScope,
  type ScribeSourceScope,
} from './scribe-scope';
import { filterSourceForExternalAiConsent, type ScribeConsentSummary } from './scribe-consent';

type ScribeConfigUpdateInput = z.infer<typeof ScribeConfigUpdate>;

const SCRIBE_PROMPT_VERSION = 'scribe-recap-v2';

type ScribeAssembly = {
  source: RecapDraftSource | null;
  consent: ScribeConsentSummary;
};

type RunOpts = {
  dryRun?: boolean;
  narrationLanguage?: NarrationLanguage;
  force?: boolean;
  scheduledSessionId?: number;
  scope?: ScribeSourceScope;
};

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
  return {
    campaignId,
    postSession: false,
    cron: false,
    budgetPerRun: 2000,
    sourceCursorAt: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

function configToDomain(row: typeof aiScribeConfigs.$inferSelect): ScribeConfig {
  return {
    campaignId: row.campaignId,
    postSession: row.postSession,
    cron: row.cron,
    budgetPerRun: row.budgetPerRun,
    sourceCursorAt: row.sourceCursorAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseSourceStats(raw: string | null | undefined): ScribeSourceStats | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScribeSourceStats;
  } catch {
    return null;
  }
}

function parseGenerationProvenance(raw: string | null | undefined): AiGenerationProvenance | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AiGenerationProvenance;
  } catch {
    return null;
  }
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
    sourceHash: row.sourceHash ?? null,
    scheduledSessionId: row.scheduledSessionId ?? null,
    sourceStats: parseSourceStats(row.sourceStats),
    generationProvenance: parseGenerationProvenance(row.generationProvenance),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * Automatic / scheduled AI scribe (issue #316), session-scoped post-session runs (#499).
 *
 * A server-side job that DRAFTS a session recap from a campaign's own material
 * (the resolved scribe-inbox threads + the encounters that were run — the SAME
 * source `draft_session_recap` assembles) and has the configured provider WRITE
 * the prose, then files it ALWAYS as a PROPOSAL for the DM to approve. Nothing is
 * ever written to canon unreviewed — the co-DM discipline of the whole AI program.
 *
 * Post-session runs bind to exactly one ended scheduled game night and assemble only
 * material from that session's time window. Cron runs use a durable source cursor.
 * Idempotent per scheduled session + source hash; `force` bypasses for explicit reruns.
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
    private readonly rolls: RollsService,
    private readonly proposalRecords: ProposalRecordsService,
    private readonly providerConfig: AiProviderConfigService,
    private readonly aiDm: AiDmService,
    private readonly supportPreferences: SupportPreferencesService,
    @Inject(AI_DM_PROVIDER) private readonly fallbackProvider: AiDmProvider,
  ) {}

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
        sourceCursorAt: base.sourceCursorAt,
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

  // ── source assembly ───────────────────────────────────────────────────────

  /**
   * Assemble recap source material. When `scope` is set, only inbox notes resolved
   * during the window, encounters fought/linked in the window, and dice rolls logged
   * in the window are included (#499). Without scope, all campaign material is loaded
   * then filtered (on-demand default).
   */
  async assembleSource(campaignId: number, scope?: ScribeSourceScope): Promise<RecapDraftSource | null> {
    return (await this.assembleSourceWithConsent(campaignId, scope)).source;
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

  private async applyExternalAiConsent(
    campaignId: number,
    source: RecapDraftSource,
  ): Promise<ScribeAssembly> {
    const policy = await this.aiContentPolicy(campaignId);
    const consented = policy === 'member_consent' ? await this.consentingMemberIds(campaignId) : new Set<string>();
    return filterSourceForExternalAiConsent(source, policy, consented);
  }

  private async assembleSourceWithConsent(campaignId: number, scope?: ScribeSourceScope): Promise<ScribeAssembly> {
    const resolvedInbox = await this.notes.listAllInbox(campaignId, true);
    const encounterList = await this.encounters.listForCampaign(campaignId);
    const encountersWithCombatants = await Promise.all(encounterList.map((e) => this.encounters.getWithCombatantsOrThrow(e.id)));
    const foughtEncounterIds = new Set(
      encounterList.filter((e) => e.status === 'running' || e.status === 'ended').map((e) => e.id),
    );
    const events = await Promise.all(
      encounterList.map((e) =>
        foughtEncounterIds.has(e.id) ? this.encounters.listEvents(e.id) : Promise.resolve([]),
      ),
    );
    const eventsByEncounter = new Map(encounterList.map((e, i) => [e.id, events[i]]));
    const encounterRows = await this.db
      .select({
        id: encounters.id,
        endedAt: encounters.endedAt,
        updatedAt: encounters.updatedAt,
        sessionId: encounters.sessionId,
      })
      .from(encounters)
      .where(and(eq(encounters.campaignId, campaignId), inArray(encounters.id, encounterList.map((e) => e.id))));

    const encounterMeta = new Map(encounterRows.map((r) => [r.id, r]));
    const sessionPlayedAtById = await this.sessionPlayedAtMap(campaignId);

    const source: RecapDraftSource = {
      resolvedInbox: resolvedInbox.map((n: Note) => ({
        id: n.id,
        authorUserId: n.authorUserId,
        visibility: n.visibility,
        body: n.body,
        resolvedNote: n.resolvedNote,
        entityName: n.entityName,
        updatedAt: n.updatedAt,
      })),
      encounters: encountersWithCombatants.map((e) => {
        const meta = encounterMeta.get(e.id);
        return {
          id: e.id,
          name: e.name,
          status: e.status,
          combatants: e.combatants,
          events: eventsByEncounter.get(e.id) ?? [],
          endedAt: meta?.endedAt ?? null,
          updatedAt: meta?.updatedAt ?? null,
          sessionId: meta?.sessionId ?? null,
        };
      }),
      diceRolls: (await this.rolls.listForCampaign(campaignId, DEFAULT_DICE_ROLLS_RETENTION)).map((r) => ({
        id: r.id,
        label: r.label,
        actor: r.actor,
        rollerName: r.rollerName,
        total: r.total,
        dc: r.dc,
        success: r.success,
        natural20: r.natural20,
        source: r.source,
        createdAt: r.createdAt,
      })),
    };

    const scoped = scope ? filterSourceByScope(source, scope, sessionPlayedAtById) : source;
    const filtered = await this.applyExternalAiConsent(campaignId, scoped);
    const filteredSource = filtered.source ?? scoped;
    const fought = filteredSource.encounters.filter((e) => e.status === 'running' || e.status === 'ended');
    if (fought.length === 0 && filteredSource.resolvedInbox.length === 0 && (filteredSource.diceRolls?.length ?? 0) === 0) {
      return { source: null, consent: filtered.consent };
    }
    return { source: filteredSource, consent: filtered.consent };
  }

  private async sessionPlayedAtMap(campaignId: number): Promise<Map<number, string | null>> {
    const rows = await this.db
      .select({ id: sessions.id, playedAt: sessions.playedAt })
      .from(sessions)
      .where(and(eq(sessions.campaignId, campaignId), isNull(sessions.deletedAt)));
    return new Map(rows.map((r) => [r.id, r.playedAt ?? null]));
  }

  private sourceStats(source: RecapDraftSource, scope: ScribeSourceScope | undefined, consent: ScribeConsentSummary): ScribeSourceStats {
    return {
      ...sourceStatsFrom(source, scope),
      excludedInboxByConsent: consent.excludedInboxByConsent,
      excludedInboxPrivate: consent.excludedInboxPrivate,
    };
  }

  private sourceIds(source: RecapDraftSource, scope?: ScribeSourceScope): AiGenerationProvenance['sourceIds'] {
    return {
      inboxNotes: source.resolvedInbox.map((note) => note.id).filter((id): id is number => typeof id === 'number'),
      encounters: source.encounters.map((encounter) => encounter.id).filter((id): id is number => typeof id === 'number'),
      diceRolls: (source.diceRolls ?? []).map((roll) => roll.id).filter((id): id is number => typeof id === 'number'),
      ...(scope && isSessionScope(scope) ? { scheduledSessionId: scope.scheduledSessionId } : {}),
      ...(scope && !isSessionScope(scope) ? { sinceAt: scope.sinceAt } : {}),
    };
  }

  private promptHash(system: string, userPrompt: string): string {
    return createHash('sha256')
      .update(JSON.stringify({ promptVersion: SCRIBE_PROMPT_VERSION, system, userPrompt }))
      .digest('hex');
  }

  private buildGenerationProvenance(input: {
    source: RecapDraftSource;
    scope?: ScribeSourceScope;
    sourceHash: string;
    system: string;
    userPrompt: string;
    provider: string;
    providerType: string | null;
    model: string;
    endpointScope: AiGenerationProvenance['endpoint']['scope'];
    endpointBaseUrl?: string | null;
    consent: ScribeConsentSummary;
  }): AiGenerationProvenance {
    return {
      source: 'ai_scribe',
      provider: input.provider,
      providerType: input.providerType,
      model: input.model,
      endpoint: {
        scope: input.endpointScope,
        baseUrl: input.endpointBaseUrl ?? null,
      },
      sourceIds: this.sourceIds(input.source, input.scope),
      sourceHash: input.sourceHash,
      promptVersion: SCRIBE_PROMPT_VERSION,
      promptHash: this.promptHash(input.system, input.userPrompt),
      consent: input.consent,
      retentionNotice: AI_EXTERNAL_PROVIDER_PRIVACY.retentionNote,
      createdAt: nowIso(),
    };
  }

  // ── the run engine ──────────────────────────────────────────────────────────

  async run(
    campaignId: number,
    trigger: ScribeTrigger,
    user: RequestUser,
    opts: RunOpts = {},
  ): Promise<ScribeRunResult> {
    const dryRun = opts.dryRun ?? false;
    const force = opts.force ?? false;
    const scope = opts.scope ?? (await this.resolveRunScope(campaignId, trigger, opts.scheduledSessionId));

    if (trigger === 'post_session' && scope && isSessionScope(scope)) {
      const already = await this.hasPostSessionJob(campaignId, scope.scheduledSessionId);
      if (already && !force) {
        return this.record(campaignId, trigger, user, 'skipped', {
          detail: `post_session already recorded for scheduled session #${scope.scheduledSessionId}`,
          scheduledSessionId: scope.scheduledSessionId,
        });
      }
    }

    const all = await this.settings.getAll();
    if (!all.experimentalAiDm) return this.record(campaignId, trigger, user, 'disabled', { detail: 'experimentalAiDm off', scope });
    const [seat] = await this.db.select().from(aiDmSeats).where(eq(aiDmSeats.campaignId, campaignId)).limit(1);
    if (!seat || !seat.enabled) {
      return this.record(campaignId, trigger, user, 'disabled', { detail: 'AI DM seat not enabled', scope });
    }

    const assembly = await this.assembleSourceWithConsent(campaignId, scope);
    const source = assembly.source;
    const stats = this.sourceStats(source ?? { resolvedInbox: [], encounters: [] }, scope, assembly.consent);
    if (!source) {
      return this.record(campaignId, trigger, user, 'no_material', {
        detail: scope && isSessionScope(scope)
          ? `no inbox/encounter material for scheduled session #${scope.scheduledSessionId}`
          : 'no inbox/encounter material',
        scope,
        sourceStats: stats,
      });
    }

    const draft = buildRecapDraft(source);
    const sourceHash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
    const sourcePreview: ScribeSourcePreview = { ...stats, estimatedPromptTokens: estimatePromptTokens(draft) };

    if (!force) {
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
            scope,
            sourceStats: stats,
            sourcePreview,
          });
        }
        if (prior.sourceHash === sourceHash) {
          return this.record(campaignId, trigger, user, 'skipped', {
            detail: 'identical source already drafted',
            proposalId: prior.proposalId,
            sourceHash,
            scope,
            sourceStats: stats,
            sourcePreview,
          });
        }
      }
    }

    const remaining = seat.tokenBudget - seat.tokensUsed;
    if (remaining <= 0) {
      return this.record(campaignId, trigger, user, 'over_budget', {
        detail: `budget exhausted (${seat.tokensUsed}/${seat.tokenBudget})`,
        sourceHash,
        scope,
        sourceStats: stats,
        sourcePreview,
      });
    }
    try {
      await this.aiDm.assertWithinServerTokenCap();
    } catch (err) {
      return this.record(campaignId, trigger, user, 'over_budget', {
        detail: err instanceof Error ? err.message : 'server-wide AI token cap reached',
        sourceHash,
        scope,
        sourceStats: stats,
        sourcePreview,
      });
    }

    type SpendResult =
      | { ok: true; text: string; tokensUsed: number; providerName: string; generationProvenance: AiGenerationProvenance }
      | {
          ok: false;
          status: 'over_budget' | 'failed';
          detail: string;
          tokensUsed?: number;
          providerName?: string;
        };

    const [campaignRow] = await this.db
      .select({ narrationLanguage: campaigns.narrationLanguage })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    const narrationResolved = resolveNarrationLanguage(campaignRow?.narrationLanguage, opts.narrationLanguage);

    const spend: SpendResult = await this.aiDm.withSpendLock(campaignId, async () => {
      const seatAfterLock = await this.aiDm.getSeat(campaignId);
      const remainingAfterLock = seatAfterLock.tokenBudget - seatAfterLock.tokensUsed;
      if (remainingAfterLock <= 0) {
        return {
          ok: false,
          status: 'over_budget',
          detail: `budget exhausted after lock acquisition (${seatAfterLock.tokensUsed}/${seatAfterLock.tokenBudget})`,
        };
      }

      try {
        await this.aiDm.assertWithinServerTokenCap();
      } catch (err) {
        return {
          ok: false,
          status: 'over_budget',
          detail: err instanceof Error ? err.message : 'server-wide AI token cap reached',
        };
      }

      const config = await this.providerConfig.resolveEffectiveConfig(campaignId);
      const budgetPerRun = (await this.getConfig(campaignId)).budgetPerRun;
      const maxTokens = Math.min(budgetPerRun, remainingAfterLock);

      let text: string;
      let tokensUsed: number;
      let providerName: string;
      let providerType: string | null = null;
      let model = seatAfterLock.model || '';
      let endpointScope: AiGenerationProvenance['endpoint']['scope'] = 'injected';
      let endpointBaseUrl: string | null = null;
      let system = '';
      try {
        const aiSupports = await this.supportPreferences.listForAi(campaignId);
        const supportGuidance = aiSupports.length > 0
          ? `\n\nParticipant-authorized practical supports (apply respectfully; do not infer diagnoses):\n${JSON.stringify(aiSupports)}`
          : '';
        system =
          (seatAfterLock.instructions ? `${seatAfterLock.instructions}\n\n` : '') +
          'You are the campaign scribe. Write a concise, in-voice session recap from the source material below. ' +
          'Return only the finished recap prose (markdown allowed); do not include the raw source-notes appendix.' +
          supportGuidance +
          '\n\n' +
          buildNarrationLanguageContract(narrationResolved.language, narrationResolved.provenance);
        if (config) {
          const provider: AiProvider = createAiProvider({ ...config, params: { ...config.params, maxTokens } });
          const effective = await this.providerConfig.getEffectiveView(campaignId);
          const result = await provider.generate({
            system,
            messages: [{ role: 'user', content: draft }],
            model: config.model,
            maxTokens,
          });
          text = result.text;
          tokensUsed = result.usage.totalTokens;
          providerName = provider.name;
          providerType = config.providerType;
          model = result.model || config.model;
          endpointScope = effective.source ?? 'none';
          endpointBaseUrl = config.baseUrl ?? null;
        } else {
          const result = await this.fallbackProvider.generate({
            campaignId,
            kind: 'recap',
            prompt: draft,
            instructions: system,
            model: seatAfterLock.model,
            maxTokens,
          });
          text = result.narration;
          tokensUsed = result.tokensUsed;
          providerName = this.fallbackProvider.name;
          providerType = null;
          model = seatAfterLock.model || '';
          endpointScope = providerName === 'noop' ? 'none' : 'injected';
        }
      } catch (err) {
        return {
          ok: false,
          status: 'failed',
          detail: `provider error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      tokensUsed = Math.max(0, Math.floor(tokensUsed));

      try {
        await this.aiDm.meterTurn(campaignId, tokensUsed, {
          actor: auditActor(user),
          action: 'scribe.meter',
          detail: `${trigger} metering (+${tokensUsed} tokens)`,
        });
      } catch (err) {
        return {
          ok: false,
          status: 'failed',
          detail: `metering error: ${err instanceof Error ? err.message : String(err)}`,
          tokensUsed,
          providerName,
        };
      }

      if (!text.trim()) {
        return {
          ok: false,
          status: 'failed',
          detail: 'provider returned empty recap',
          tokensUsed,
          providerName,
        };
      }

      return {
        ok: true,
        text,
        tokensUsed,
        providerName,
        generationProvenance: this.buildGenerationProvenance({
          source,
          scope,
          sourceHash,
          system,
          userPrompt: draft,
          provider: providerName,
          providerType,
          model,
          endpointScope,
          endpointBaseUrl,
          consent: assembly.consent,
        }),
      };
    });

    if (!spend.ok) {
      return this.record(campaignId, trigger, user, spend.status, {
        detail: spend.detail,
        sourceHash,
        scope,
        sourceStats: stats,
        sourcePreview,
        ...(spend.tokensUsed !== undefined ? { tokensUsed: spend.tokensUsed } : {}),
        ...(spend.providerName !== undefined ? { provider: spend.providerName } : {}),
      });
    }
    const { text, tokensUsed, providerName, generationProvenance } = spend;

    if (dryRun) {
      const job = await this.record(campaignId, trigger, user, 'succeeded', {
        detail: 'dry-run preview (no proposal filed)',
        sourceHash,
        tokensUsed,
        provider: providerName,
        generationProvenance,
        scope,
        sourceStats: stats,
      });
      return { ...job, preview: text, sourcePreview };
    }

    const title = source.encounters.find((e) => e.status === 'running' || e.status === 'ended')?.name
      ? `Recap: ${source.encounters.find((e) => e.status === 'running' || e.status === 'ended')!.name}`
      : scope && isSessionScope(scope) && scope.scheduledSessionId
        ? `Session recap (scheduled #${scope.scheduledSessionId})`
        : 'Session recap (AI draft)';
    const proposal = await this.proposalRecords.create(
      campaignId,
      'session',
      null,
      'create',
      { recap: text, title },
      user,
      'dm' as Role,
      {
        proposer: `AI Scribe (${providerName})`,
        proposerUserId: `ai-dm:${campaignId}`,
        proposerToken: null,
        generationProvenance,
      },
    );

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'scribe.run',
      entityType: 'ai-dm',
      campaignId,
      detail: `${trigger} via ${providerName} -> proposal #${proposal.id} (+${tokensUsed} tokens)`,
    });

    await this.advanceSourceCursor(campaignId, scope);

    const job = await this.record(campaignId, trigger, user, 'succeeded', {
      detail: `drafted recap proposal #${proposal.id}`,
      sourceHash,
      proposalId: proposal.id,
      proposalCount: 1,
      tokensUsed,
      provider: providerName,
      generationProvenance,
      scope,
      sourceStats: stats,
    });
    return { ...job, proposalIds: [proposal.id], sourcePreview };
  }

  // ── post-session / cron sweep ────────────────────────────────────────────────

  async sweep(now: Date = new Date()): Promise<ScribeRunResult[]> {
    const configs = await this.db.select().from(aiScribeConfigs);
    const results: ScribeRunResult[] = [];
    const campaignIds = [...new Set(configs.map((cfg) => cfg.campaignId))];
    const liveCampaignIds = new Set<number>();
    if (campaignIds.length > 0) {
      const lifecycleRows = await this.db
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(inArray(campaigns.id, campaignIds), isNull(campaigns.deletedAt)));
      for (const row of lifecycleRows) liveCampaignIds.add(row.id);
    }
    for (const cfg of configs) {
      if (!liveCampaignIds.has(cfg.campaignId)) continue;

      let trigger: ScribeTrigger | null = null;
      let scope: ScribeSourceScope | undefined;
      if (cfg.postSession) {
        const pending = await this.findNextEndedScheduledSession(cfg.campaignId, now);
        if (pending) {
          trigger = 'post_session';
          scope = pending.scope;
        }
      } else if (cfg.cron) {
        trigger = 'cron';
        scope = this.cursorScopeFromConfig(configToDomain(cfg));
      }
      if (!trigger) continue;
      try {
        results.push(await this.run(cfg.campaignId, trigger, SCRIBE_SYSTEM_USER, { scope }));
      } catch (err) {
        this.logger.warn(`scribe run for campaign ${cfg.campaignId} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return results;
  }

  /** Oldest ended scheduled session without a prior post_session job (#499). */
  private async findNextEndedScheduledSession(
    campaignId: number,
    now: Date,
  ): Promise<{ scope: ScribeSessionScope } | null> {
    const rows = await this.db
      .select()
      .from(scheduledSessions)
      .where(eq(scheduledSessions.campaignId, campaignId))
      .orderBy(asc(scheduledSessions.scheduledAt), asc(scheduledSessions.id));

    const processed = await this.db
      .select({ scheduledSessionId: aiScribeJobs.scheduledSessionId })
      .from(aiScribeJobs)
      .where(and(eq(aiScribeJobs.campaignId, campaignId), eq(aiScribeJobs.trigger, 'post_session')));
    const done = new Set(processed.map((r) => r.scheduledSessionId).filter((id): id is number => id != null));

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const scheduledEnd = Date.parse(row.scheduledAt) + (row.durationMinutes ?? 0) * 60_000;
      if (scheduledEnd > now.getTime()) continue;
      if (done.has(row.id)) continue;
      const next = rows[i + 1];
      return {
        scope: postSessionScope(row.id, row.scheduledAt, row.durationMinutes ?? 0, {
          now,
          nextSessionStartAt: next?.scheduledAt ?? null,
        }),
      };
    }
    return null;
  }

  private async hasPostSessionJob(campaignId: number, scheduledSessionId: number): Promise<boolean> {
    const [row] = await this.db
      .select({ id: aiScribeJobs.id })
      .from(aiScribeJobs)
      .where(
        and(
          eq(aiScribeJobs.campaignId, campaignId),
          eq(aiScribeJobs.trigger, 'post_session'),
          eq(aiScribeJobs.scheduledSessionId, scheduledSessionId),
        ),
      )
      .limit(1);
    return !!row;
  }

  private cursorScopeFromConfig(config: ScribeConfig): ScribeCursorScope | undefined {
    if (!config.sourceCursorAt) return undefined;
    const sinceMs = Date.parse(config.sourceCursorAt);
    if (!Number.isFinite(sinceMs)) return undefined;
    return { sinceAt: config.sourceCursorAt, sinceMs };
  }

  private async resolveRunScope(
    campaignId: number,
    trigger: ScribeTrigger,
    scheduledSessionId?: number,
  ): Promise<ScribeSourceScope | undefined> {
    if (scheduledSessionId != null) {
      const rows = await this.db
        .select()
        .from(scheduledSessions)
        .where(eq(scheduledSessions.campaignId, campaignId))
        .orderBy(asc(scheduledSessions.scheduledAt), asc(scheduledSessions.id));
      const idx = rows.findIndex((r) => r.id === scheduledSessionId);
      const row = rows[idx];
      if (row) {
        const next = rows[idx + 1];
        return postSessionScope(row.id, row.scheduledAt, row.durationMinutes ?? 0, {
          nextSessionStartAt: next?.scheduledAt ?? null,
        });
      }
    }
    if (trigger === 'cron') return this.cursorScopeFromConfig(await this.getConfig(campaignId));
    return undefined;
  }

  private async advanceSourceCursor(campaignId: number, scope?: ScribeSourceScope): Promise<void> {
    const ts = nowIso();
    if (scope && isSessionScope(scope)) {
      await this.db
        .update(aiScribeConfigs)
        .set({ sourceCursorAt: scope.windowEnd, updatedAt: ts })
        .where(eq(aiScribeConfigs.campaignId, campaignId));
      return;
    }
    await this.db
      .update(aiScribeConfigs)
      .set({ sourceCursorAt: ts, updatedAt: ts })
      .where(eq(aiScribeConfigs.campaignId, campaignId));
  }

  // ── job recording ────────────────────────────────────────────────────────────

  private async record(
    campaignId: number,
    trigger: ScribeTrigger,
    user: RequestUser,
    status: ScribeJobStatus,
    extra: {
      detail?: string;
      sourceHash?: string;
      proposalId?: number;
      proposalCount?: number;
      tokensUsed?: number;
      provider?: string;
      generationProvenance?: AiGenerationProvenance;
      scope?: ScribeSourceScope;
      sourceStats?: ScribeSourceStats;
      sourcePreview?: ScribeSourcePreview;
      scheduledSessionId?: number;
    } = {},
  ): Promise<ScribeRunResult> {
    const scheduledSessionId =
      extra.scheduledSessionId ??
      (extra.scope && isSessionScope(extra.scope) ? extra.scope.scheduledSessionId : null);
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
        scheduledSessionId: scheduledSessionId ?? null,
        sourceStats: extra.sourceStats ? JSON.stringify(extra.sourceStats) : null,
        generationProvenance: extra.generationProvenance ? JSON.stringify(extra.generationProvenance) : null,
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
      sourcePreview: extra.sourcePreview ?? null,
    };
  }

  async campaignExists(campaignId: number): Promise<boolean> {
    const [row] = await this.db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    return !!row;
  }
}
