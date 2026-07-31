import { BadRequestException, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  AiExternalContentPolicy,
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
import { AI_EXTERNAL_PROVIDER_PRIVACY, AiGenerationProvenance, buildNarrationLanguageContract, resolveNarrationLanguage } from '@campfire/schema';
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
import { provenanceEndpointBaseUrl } from '../../common/ai-provenance-endpoint';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { NotesService } from '../notes/notes.service';
import { EncountersService } from '../encounters/encounters.service';
import { RollsService, DEFAULT_DICE_ROLLS_RETENTION } from '../rolls/rolls.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import { AiDmService, type AiDmTokenReservation } from '../ai-dm/ai-dm.service';
import { createAiProvider, type AiProvider, type AiProviderConfig } from '../ai-dm/providers';
import { AI_DM_PROVIDER, type AiDmProvider } from '../ai-dm/ai-dm.provider';
import { buildRecapDraft, type RecapDraftSource } from '../sessions/sessions.service';
import { scheduleLiveSql } from '../sessions/scheduling-queries';
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
import {
  applyScribeConsent,
  withheldConsentDetail,
  type ScribeConsentSummary,
  type ScribeEgress,
} from './scribe-consent';

type ScribeConfigUpdateInput = z.infer<typeof ScribeConfigUpdate>;

const SCRIBE_PROMPT_VERSION = 'scribe-recap-v2';

export type ScribeAssembly = {
  /**
   * The assembled, consent-filtered material. Always present — "is there enough here to
   * be worth recapping?" is a SCRIBE-RUN question (see `hasRecapMaterial`), not a property
   * of the assembly, and collapsing it to null here previously dropped prepared encounters
   * from the MCP scaffold tool, which spends no tokens and calls no model.
   */
  source: RecapDraftSource;
  consent: ScribeConsentSummary;
};

/**
 * Whether assembled material is worth drafting a recap FROM (issue #316).
 *
 * A still-`preparing` encounter is prep, not play, so it cannot carry a recap on its own —
 * but it is perfectly legitimate source material to hand an agent or a human who is
 * writing one. This gate therefore belongs to the run engine (which would otherwise spend
 * provider tokens narrating nothing), NOT to assembly.
 */
export function hasRecapMaterial(source: RecapDraftSource): boolean {
  const fought = source.encounters.filter((e) => e.status === 'running' || e.status === 'ended');
  return fought.length > 0 || source.resolvedInbox.length > 0 || (source.diceRolls?.length ?? 0) > 0;
}

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
    // Fail-closed placeholder; `getConfig` recomputes it from the resolved provider (#501).
    externalSend: true,
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
    // Fail-closed placeholder; `getConfig` recomputes it from the resolved provider (#501).
    externalSend: true,
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
    // Validate rather than blind-cast: a shape-drifted blob from an older build (or a
    // hand-edited DB) must not surface as a malformed `generationProvenance` in the API
    // response and break clients. Unparseable ⇒ null, same as "no provenance recorded".
    const parsed = AiGenerationProvenance.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
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
    const stored = row ? configToDomain(row) : defaultConfig(campaignId);
    // Derived per read (#501): the DM-facing external-send confirmation must describe what
    // a run will ACTUALLY do. On an install with no provider configured nothing leaves the
    // server, and warning about a vendor call that will not happen trains DMs to ignore
    // the dialog before the run where it does matter.
    //
    // COST, accepted deliberately: this makes every getConfig a provider-config resolution,
    // including the call inside the spend lock that only wants `budgetPerRun`. It is two
    // indexed row reads via the NON-decrypting `getEffectiveView`, so it neither decrypts a
    // key nor touches the network. Revisit if provider resolution ever grows either.
    return { ...stored, externalSend: (await this.resolveEgress(campaignId)) === 'external' };
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

  /**
   * The operator's EXPLICIT declaration that the configured provider endpoint is
   * on-box / operator-controlled, so a generation through it does not constitute
   * external use (issue #501).
   *
   * Deliberately an explicit opt-in rather than an inference. Campfire will NOT try to
   * decide that a `baseUrl` is "local enough" by inspecting its host: a loopback or
   * RFC1918 address can just as easily be an egress proxy forwarding to a public vendor,
   * and guessing wrong leaks member-authored content that a member declined to share.
   * That is the operator's call to make, and it defaults to OFF (fail-closed).
   *
   * Note this is NOT the same knob as `AI_PROVIDER_ALLOW_PRIVATE_HOSTS`, which is the SSRF
   * host policy — permitting a private host as a *destination* says nothing about whether
   * content sent there stays inside the deployment.
   */
  private operatorDeclaredLocalEndpoint(): boolean {
    const raw = process.env.AI_PROVIDER_ENDPOINT_IS_LOCAL?.trim().toLowerCase();
    return raw === '1' || raw === 'true';
  }

  /**
   * Decide, BEFORE any material is assembled, whether this campaign's generation will
   * actually leave the server (issue #501).
   *
   * `getEffectiveView` is the non-decrypting mirror of `resolveEffectiveConfig`'s
   * precedence: both resolve `campaign ?? server`, and `resolveEffectiveConfig` returns
   * null exactly when neither row exists — which is exactly when `configured` is false.
   * So "no provider row" ⟺ the run falls through to the injected/no-op seam, where
   * `endpointScope` resolves to `'injected'`/`'none'` and nothing is transmitted anywhere.
   *
   * Anything else is treated as external. A configured `baseUrl` is genuinely ambiguous —
   * it could be a localhost Ollama or a public API — so it stays external unless the
   * operator has explicitly declared otherwise.
   */
  private async resolveEgress(campaignId: number): Promise<ScribeEgress> {
    const view = await this.providerConfig.getEffectiveView(campaignId);
    if (!view.configured) return 'local';
    return this.operatorDeclaredLocalEndpoint() ? 'local' : 'external';
  }

  private async applyConsentGate(
    campaignId: number,
    source: RecapDraftSource,
    egress: ScribeEgress,
  ): Promise<ScribeAssembly> {
    const policy = await this.aiContentPolicy(campaignId);
    const consented =
      egress === 'external' && policy === 'member_consent'
        ? await this.consentingMemberIds(campaignId)
        : new Set<string>();
    return applyScribeConsent(source, policy, consented, egress);
  }

  /**
   * Assemble the recap source AND the consent decision that produced it (#501).
   *
   * Public because the scribe run engine is not the only egress path: the MCP
   * `draft_session_recap` tool hands this same material straight to a connected
   * agent (which IS an external model), so it must go through the identical
   * consent filter rather than reading notes directly.
   *
   * `egress` defaults to `'external'` — the fail-closed choice — so any caller that has
   * not reasoned about where the material is going gets the strict gate. Only the run
   * engine, which has resolved the effective provider first, passes `'local'`.
   */
  async assembleSourceWithConsent(
    campaignId: number,
    scope?: ScribeSourceScope,
    egress: ScribeEgress = 'external',
  ): Promise<ScribeAssembly> {
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
        // Join key for the consent gate only — stripped again before the prompt (#501).
        rollerUserId: r.rollerUserId,
        total: r.total,
        dc: r.dc,
        success: r.success,
        natural20: r.natural20,
        source: r.source,
        createdAt: r.createdAt,
      })),
    };

    const scoped = scope ? filterSourceByScope(source, scope, sessionPlayedAtById) : source;
    const filtered = await this.applyConsentGate(campaignId, scoped, egress);
    // Deliberately NOT collapsed to null when there is nothing "recap-worthy". Callers that
    // would spend tokens narrating it ask `hasRecapMaterial`; the MCP scaffold tool, which
    // spends none, gets whatever exists — including encounters that are still `preparing`.
    return { source: filtered.source, consent: filtered.consent };
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
      // The CAUSE behind the count, archived so the DM-facing copy can name the remedy that
      // applies. A `no_material` run records no provenance, so this is the only place the
      // UI can learn the policy from (#501 review).
      campaignPolicy: consent.campaignPolicy,
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
    const provenance: AiGenerationProvenance = {
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

    // Validate on WRITE, not just on read (#501). Every read path — `parseGenerationProvenance`
    // here and `proposal-records.toDomain` — validates and falls back to `null`, so a blob
    // that does not satisfy the schema silently becomes "no provenance recorded" at read
    // time with nothing logged at either end. For a provenance feature, losing the record
    // is precisely the failure it exists to prevent, so make it loud instead of silent.
    //
    // This is a LOUD LOG, not a guard: the blob is still returned and persisted either
    // way. Failing the run outright would trade a degraded record for a lost recap, which
    // is the worse outcome — the log is what turns a silent drop into a visible one.
    // Not currently reachable: every field comes from a validated config or a constant.
    const parsed = AiGenerationProvenance.safeParse(provenance);
    if (!parsed.success) {
      this.logger.error(
        `scribe generationProvenance failed schema validation and will be dropped on read: ${parsed.error.message}`,
      );
    }
    return provenance;
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

    // Resolve WHERE this generation will go BEFORE assembling, so the consent gate that
    // runs inside assembly is the one that actually applies (#501). Issue #501 is scoped
    // to EXTERNAL use; gating a purely local generation on external-use consent silently
    // empties recaps on the default self-hosted install, where nothing is transmitted at
    // all. The gate still runs strictly inside assembly, before any bytes exist to send.
    const egress = await this.resolveEgress(campaignId);
    const assembly = await this.assembleSourceWithConsent(campaignId, scope, egress);
    const source = assembly.source;
    const stats = this.sourceStats(source, scope, assembly.consent);
    // The run engine — not assembly — decides whether there is enough to be worth spending
    // provider tokens on. A campaign with only `preparing` encounters has nothing to recap.
    if (!hasRecapMaterial(source)) {
      return this.record(campaignId, trigger, user, 'no_material', {
        detail: withheldConsentDetail(
          scope && isSessionScope(scope)
            ? `no inbox/encounter material for scheduled session #${scope.scheduledSessionId}`
            : 'no inbox/encounter material',
          assembly.consent,
        ),
        scope,
        sourceStats: stats,
      });
    }

    const draft = buildRecapDraft(source);
    const sourceHash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
    const sourcePreview: ScribeSourcePreview = { ...stats, estimatedPromptTokens: estimatePromptTokens(draft) };

    if (!force) {
      const [pendingJob] = await this.db
        .select({ proposalId: aiScribeJobs.proposalId })
        .from(aiScribeJobs)
        .innerJoin(proposals, eq(aiScribeJobs.proposalId, proposals.id))
        .where(
          and(
            eq(aiScribeJobs.campaignId, campaignId),
            eq(aiScribeJobs.status, 'succeeded'),
            eq(proposals.status, 'pending'),
          ),
        )
        .orderBy(desc(aiScribeJobs.id))
        .limit(1);

      if (pendingJob && pendingJob.proposalId !== null) {
        return this.record(campaignId, trigger, user, 'skipped', {
          detail: 'a scribe recap proposal is already pending review',
          proposalId: pendingJob.proposalId,
          sourceHash,
          scope,
          sourceStats: stats,
          sourcePreview,
        });
      }

      const [identicalJob] = await this.db
        .select({ proposalId: aiScribeJobs.proposalId })
        .from(aiScribeJobs)
        .where(
          and(
            eq(aiScribeJobs.campaignId, campaignId),
            eq(aiScribeJobs.status, 'succeeded'),
            eq(aiScribeJobs.sourceHash, sourceHash),
            isNotNull(aiScribeJobs.proposalId),
          ),
        )
        .orderBy(desc(aiScribeJobs.id))
        .limit(1);

      if (identicalJob && identicalJob.proposalId !== null) {
        return this.record(campaignId, trigger, user, 'skipped', {
          detail: 'identical source already drafted',
          proposalId: identicalJob.proposalId,
          sourceHash,
          scope,
          sourceStats: stats,
          sourcePreview,
        });
      }
    }

    const remaining = Math.max(0, seat.tokenBudget - seat.tokensUsed - seat.tokensReserved - seat.tokensUnknown);
    if (remaining <= 0) {
      return this.record(campaignId, trigger, user, 'over_budget', {
        // Report the committed total the gate actually enforces (used + in-flight
        // reservations + unknown spend), not tokensUsed alone — otherwise a seat blocked
        // by in-flight reservations reads as "0/1000 exhausted" (#563 review).
        detail: `budget exhausted (${seat.tokensUsed + seat.tokensReserved + seat.tokensUnknown}/${seat.tokenBudget})`,
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
      const remainingAfterLock = seatAfterLock.budgetRemaining;
      if (remainingAfterLock <= 0) {
        return {
          ok: false,
          status: 'over_budget',
          detail: `budget exhausted after lock acquisition (${seatAfterLock.tokenBudget - seatAfterLock.budgetRemaining}/${seatAfterLock.tokenBudget})`,
        };
      }

      const budgetPerRun = (await this.getConfig(campaignId)).budgetPerRun;
      let reservation: AiDmTokenReservation;
      try {
        reservation = await this.aiDm.reserveTokenBudget(campaignId, budgetPerRun);
      } catch (err) {
        return {
          ok: false,
          status: 'over_budget',
          detail: err instanceof Error ? err.message : 'AI token budget exhausted',
        };
      }

      const maxTokens = reservation.tokensReserved;

      let text = '';
      let tokensUsed = 0;
      let providerName = '';
      // #501 provenance, captured as the call resolves so the stored blob names the
      // provider/model/endpoint that actually produced the text. Defaults are the
      // manual/legacy shape, so a throw before resolution never writes a half-truth.
      let providerType: string | null = null;
      let model = seatAfterLock.model || '';
      let endpointScope: AiGenerationProvenance['endpoint']['scope'] = 'injected';
      let endpointBaseUrl: string | null = null;
      let system = '';
      // Resolved INSIDE the try: the hold is live from here on, so every step between
      // reserving and settling must be on a path that releases it. Resolving the config
      // outside would strand the reservation if decrypting/reading it threw (#563).
      let config: AiProviderConfig | null = null;
      // Which scope OWNS the resolved endpoint — not merely whether a campaign row
      // exists. A keyless campaign override executes against the SERVER endpoint (#501).
      let resolvedEndpointScope: 'campaign' | 'server' | null = null;
      try {
        ({ config, endpointScope: resolvedEndpointScope } =
          await this.providerConfig.resolveEffectiveConfigWithEndpointScope(campaignId));
        const aiSupports = await this.supportPreferences.listForAi(campaignId);
        const supportGuidance = aiSupports.length > 0
          ? `\n\nParticipant-authorized practical supports (apply respectfully; do not infer diagnoses):\n${JSON.stringify(aiSupports)}`
          : '';
        // The seat's PERSONA travels here; the seat's TABLE STYLE deliberately does not (#1049).
        //
        // `AiDmService.takeTurn` applies `withTableStyle` to every turn kind, `recap` included,
        // so two paths that both produce "a recap" disagree on purpose. The scribe is a
        // different product: the line below replaces the speaker — this is the campaign scribe
        // writing a record that gets filed as a proposal for the DM to review, not the AI DM
        // taking a turn at the table. The style block announces itself as "How the DM of this
        // table wants the game NARRATED", and two of its five axes (combatStyle, npcDepth)
        // steer how to run combat and play NPCs, neither of which a post-session summary does.
        // Asserted in ai-dm-table-style-surfaces.e2e-spec.ts so this stays a decision.
        system =
          (seatAfterLock.instructions ? `${seatAfterLock.instructions}\n\n` : '') +
          'You are the campaign scribe. Write a concise, in-voice session recap from the source material below. ' +
          'Return only the finished recap prose (markdown allowed); do not include the raw source-notes appendix.' +
          supportGuidance +
          '\n\n' +
          buildNarrationLanguageContract(narrationResolved.language, narrationResolved.provenance);
        if (config) {
          // Ordering interlock (#501). The consent gate ran during assembly against the
          // egress we predicted BEFORE the spend lock. If a provider row appeared in the
          // meantime, this material was assembled unfiltered for a local seam and is now
          // about to be handed to an external endpoint. Refuse rather than send: the catch
          // below releases the reservation and records a failed run.
          if (egress === 'local' && !this.operatorDeclaredLocalEndpoint()) {
            throw new Error(
              'provider configuration changed to an external endpoint after source assembly; ' +
                'refusing to send material that was not filtered for external-use consent',
            );
          }
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
          providerType = config.providerType;
          model = result.model || config.model;
          // The scope that OWNS the endpoint, so a keyless campaign override that runs
          // against the server endpoint is recorded as 'server' — both truthful and the
          // condition the baseUrl gate below keys off (#501 review).
          endpointScope = resolvedEndpointScope ?? 'none';
          // Never persist the SERVER row's baseUrl — scribe jobs and filed proposals are
          // DM-readable, and the admin-managed server endpoint is deliberately hidden from
          // campaign DMs (#501 review).
          endpointBaseUrl = provenanceEndpointBaseUrl(endpointScope, config.baseUrl);
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
        await this.aiDm.releaseReservationQuietly(reservation, {
          actor: auditActor(user),
          action: 'scribe.usage_unknown',
          detail: `${trigger} provider error; usage unknown`,
        });
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
          detail: `${trigger} metering (+${tokensUsed} tokens, reserved=${reservation.tokensReserved})`,
          model: config?.model ?? seatAfterLock.model,
        }, reservation);
      } catch (err) {
        // meterTurn settles the reservation itself, even when it throws, so this is a
        // belt-and-braces settle for a stubbed/legacy meterTurn. It no-ops when the hold
        // was already released — consuming it twice would charge the tokens as BOTH used
        // and unknown (#563 review).
        await this.aiDm.releaseReservationQuietly(reservation, {
          actor: auditActor(user),
          action: 'scribe.usage_unknown',
          detail: `${trigger} metering failed; usage unknown`,
        });
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

  /**
   * Oldest ended scheduled session without a terminal post_session job (#499).
   *
   * Only EFFECTIVELY-scheduled nights are draftable (#504): a cancelled night was never
   * played, and a completed one already has the recap this run would draft. That is
   * exactly scheduleLiveSql(), which is also what the Upcoming/Past projections use —
   * so a night whose recap was trashed (stored `completed`, effectively `scheduled`
   * again) becomes draftable again, matching what the DM sees in the Schedule tab.
   */
  private async findNextEndedScheduledSession(
    campaignId: number,
    now: Date,
  ): Promise<{ scope: ScribeSessionScope } | null> {
    const rows = await this.db
      .select()
      .from(scheduledSessions)
      .where(and(eq(scheduledSessions.campaignId, campaignId), scheduleLiveSql()))
      .orderBy(asc(scheduledSessions.scheduledAt), asc(scheduledSessions.id));

    // A no-material window is terminal: its bounded session window cannot gain
    // source material later. Failed and pending-proposal skips stay eligible for
    // retry, while an identical-source skip is terminal for that fixed window.
    const processed = await this.db
      .select({ scheduledSessionId: aiScribeJobs.scheduledSessionId, status: aiScribeJobs.status, detail: aiScribeJobs.detail, sourceStats: aiScribeJobs.sourceStats })
      .from(aiScribeJobs)
      .where(
        and(
          eq(aiScribeJobs.campaignId, campaignId),
          eq(aiScribeJobs.trigger, 'post_session'),
          inArray(aiScribeJobs.status, ['succeeded', 'no_material', 'skipped']),
        ),
      );
    const done = new Set<number>();
    for (const job of processed) {
      if (job.scheduledSessionId !== null && (job.status === 'succeeded' || job.status === 'no_material')) {
        done.add(job.scheduledSessionId);
      }
      if (job.status === 'skipped' && job.detail === 'identical source already drafted') {
        const stats = parseSourceStats(job.sourceStats);
        if (stats?.scheduledSessionId !== undefined) done.add(stats.scheduledSessionId);
      }
    }

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
          inArray(aiScribeJobs.status, ['succeeded', 'no_material']),
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

  /**
   * Scope for a run. An EXPLICIT `scheduledSessionId` is a caller's instruction, so an
   * unusable one is an error, not a shrug (#504): before the draftable filter existed
   * every schedule id resolved, and afterwards an unknown/cancelled/completed id fell
   * silently through to the cron cursor (or to no scope at all) and drafted a recap
   * over the wrong window — a "successful" run the DM never asked for. Both bad ids now
   * fail loudly with the reason. The filter is scheduleLiveSql(), i.e. EFFECTIVE status,
   * so a night whose recap is in the Trash is draftable again just as it is upcoming again.
   */
  private async resolveRunScope(
    campaignId: number,
    trigger: ScribeTrigger,
    scheduledSessionId?: number,
  ): Promise<ScribeSourceScope | undefined> {
    if (scheduledSessionId != null) {
      const rows = await this.db
        .select()
        .from(scheduledSessions)
        .where(and(eq(scheduledSessions.campaignId, campaignId), scheduleLiveSql()))
        .orderBy(asc(scheduledSessions.scheduledAt), asc(scheduledSessions.id));
      const idx = rows.findIndex((r) => r.id === scheduledSessionId);
      const row = rows[idx];
      if (row) {
        const next = rows[idx + 1];
        return postSessionScope(row.id, row.scheduledAt, row.durationMinutes ?? 0, {
          nextSessionStartAt: next?.scheduledAt ?? null,
        });
      }
      const [raw] = await this.db
        .select({ status: scheduledSessions.status })
        .from(scheduledSessions)
        .where(and(eq(scheduledSessions.campaignId, campaignId), eq(scheduledSessions.id, scheduledSessionId)))
        .limit(1);
      if (!raw) {
        throw new BadRequestException(`Scheduled session ${scheduledSessionId} not found in this campaign`);
      }
      throw new BadRequestException(
        `Scheduled session ${scheduledSessionId} is ${raw.status} — only scheduled game nights can be drafted from`,
      );
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
      status === 'skipped'
        ? null
        : extra.scheduledSessionId ??
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
